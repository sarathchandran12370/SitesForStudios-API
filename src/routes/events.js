// Studio-side event management: events, uploads (direct to storage via signed URLs), photos.
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one } from '../db/pg.js';
import { requireRole, studioGuard, eventGuard, STUDIO_MANAGERS } from '../middleware/auth.js';
import { Photo, Face, PersonCluster } from '../models/index.js';
import { storage } from '../services/storage.js';
import { enqueuePhoto } from '../services/processing.js';
import { deleteEventFaces } from '../services/faces.js';
import { parse, HttpError, hashPassword } from '../util.js';
import { notify, studioBrand } from '../services/notify.js';
import { photosReadyMessage } from '../services/messages.js';
import { photoView } from './photoView.js';
import { DESIGN_OPTIONS, designOf } from '../services/gallery.js';
import { selectionsForStudio, reopenSelection, threadsForStudio, addComment } from '../services/feedback.js';
import { config } from '../config.js';

const r = Router();
r.use(requireRole(...STUDIO_MANAGERS));

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const HEIC_EXT = /\.(heic|heif)$/i; // many browsers send HEIC with an empty or generic type
const RAW_EXT = /\.(cr2|cr3|nef|arw|raf|orf|rw2|dng|pef|srw)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const MAX_VIDEO_BYTES = 5 * 1024 ** 3; // one signed upload (PUT) can carry up to 5 GB

/** An event row as the studio sees it: never the share password hash. */
function eventOut(ev) {
  if (!ev) return ev;
  const { share_password_hash, ...rest } = ev;
  return {
    ...rest,
    design: designOf(ev),
    share_has_password: !!share_password_hash,
    share_url: ev.share_token ? `${config.appUrl}/g/${ev.share_token}` : null,
  };
}

r.get('/studio/:studioId', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  res.json(
    await q(
      `SELECT e.*, (SELECT count(*) FROM event_access ea WHERE ea.event_id = e.id)::int AS client_count
       FROM events e WHERE e.studio_id = $1 ORDER BY e.event_date DESC NULLS LAST, e.created_at DESC`,
      [studio.id]
    ).then((rows) => rows.map(eventOut))
  );
});

const eventFields = z.object({
  title: z.string().min(2).max(160),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  venue: z.string().max(200).nullable().optional(),
  rawEnabled: z.boolean().optional(),
  faceEnabled: z.boolean().optional(),
  showInPortfolio: z.boolean().optional(),
});

r.post('/studio/:studioId', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  const b = parse(eventFields, req.body);
  const plan = await one('SELECT p.* FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [studio.org_id]);
  if (b.rawEnabled && !plan.raw_delivery) throw new HttpError(402, 'RAW delivery needs the Pro plan or higher');
  if (!plan.client_galleries) {
    // Website plan: events are portfolio albums (no client delivery, RAW or face recognition).
    b.rawEnabled = false;
    b.faceEnabled = false;
    if (b.showInPortfolio === undefined) b.showInPortfolio = true;
  }
  // Face search is offered only by plans with face events (none for now).
  if (!plan.face_events_per_month) b.faceEnabled = false;
  const ev = await one(
    `INSERT INTO events(studio_id, title, event_date, venue, raw_enabled, face_enabled, show_in_portfolio)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [studio.id, b.title, b.eventDate || null, b.venue || null, !!b.rawEnabled, !!b.faceEnabled, !!b.showInPortfolio]
  );
  res.status(201).json(eventOut(ev));
});

r.get('/:id', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const counts = await Photo.aggregate([
    { $match: { eventId: g.event.id } },
    { $group: { _id: { kind: '$kind', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const ceremonies = await Photo.distinct('ceremony', { eventId: g.event.id, kind: 'image' });
  const clients = await q(
    `SELECT a.id, a.name, a.email, ea.access_level FROM event_access ea JOIN accounts a ON a.id = ea.account_id WHERE ea.event_id = $1`,
    [g.event.id]
  );
  res.json({ ...eventOut(g.event), storage_bytes: Number(g.event.storage_bytes), counts, ceremonies, clients });
});

r.patch('/:id', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const b = parse(eventFields.partial().extend({ coverPhotoId: z.string().nullable().optional() }), req.body);
  if (b.rawEnabled || b.faceEnabled) {
    const plan = await one('SELECT p.* FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [g.studio.org_id]);
    if (b.rawEnabled && !plan.raw_delivery) throw new HttpError(402, 'RAW delivery needs the Pro plan or higher');
    if (b.faceEnabled && !plan.client_galleries) throw new HttpError(402, 'Face recognition is not included in the Website plan');
    if (b.faceEnabled && !plan.face_events_per_month) throw new HttpError(402, 'Face search is not included in your plan');
  }
  const ev = await one(
    `UPDATE events SET
       title = coalesce($2, title), event_date = CASE WHEN $3::boolean THEN $4::date ELSE event_date END,
       venue = CASE WHEN $5::boolean THEN $6 ELSE venue END,
       raw_enabled = coalesce($7, raw_enabled), face_enabled = coalesce($8, face_enabled),
       show_in_portfolio = coalesce($9, show_in_portfolio),
       cover_photo_id = CASE WHEN $10::boolean THEN $11 ELSE cover_photo_id END
     WHERE id = $1 RETURNING *`,
    [
      g.event.id, b.title ?? null, 'eventDate' in b, b.eventDate ?? null, 'venue' in b, b.venue ?? null,
      b.rawEnabled ?? null, b.faceEnabled ?? null, b.showInPortfolio ?? null, 'coverPhotoId' in b, b.coverPhotoId ?? null,
    ]
  );
  res.json(eventOut(ev));
});

// ---------- Gallery settings: selection limit, downloads, watermark, design ----------

const designSchema = z.object(Object.fromEntries(Object.entries(DESIGN_OPTIONS).map(([k, v]) => [k, z.enum(v).optional()])));

r.put('/:id/gallery', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const b = parse(
    z.object({
      selectionLimit: z.number().int().min(1).max(5000).nullable().optional(),
      downloads: z.enum(['full', 'web', 'none']).optional(),
      watermark: z.boolean().optional(),
      design: designSchema.optional(),
    }),
    req.body
  );
  const ev = await one(
    `UPDATE events SET
       selection_limit = CASE WHEN $2::boolean THEN $3::int ELSE selection_limit END,
       downloads = coalesce($4, downloads), watermark = coalesce($5, watermark),
       design = CASE WHEN $6::jsonb IS NULL THEN design ELSE design || $6::jsonb END
     WHERE id = $1 RETURNING *`,
    [g.event.id, 'selectionLimit' in b, b.selectionLimit ?? null, b.downloads ?? null, b.watermark ?? null, b.design ? JSON.stringify(b.design) : null]
  );
  res.json(eventOut(ev));
});

// ---------- Guest share link ----------

// Turn the link on or off, set or clear its password, allow guest downloads, or make a new link (the old one stops working).
r.put('/:id/share', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const b = parse(
    z.object({
      enabled: z.boolean().optional(),
      password: z.string().min(4).max(60).nullable().optional(), // null removes the password
      downloads: z.boolean().optional(),
      regenerate: z.boolean().optional(),
    }),
    req.body
  );
  const plan = await one('SELECT p.client_galleries FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [g.studio.org_id]);
  if (b.enabled && !plan.client_galleries) throw new HttpError(402, 'Share links come with client galleries (Starter and above).');
  const token = !g.event.share_token || b.regenerate ? crypto.randomBytes(18).toString('base64url') : g.event.share_token;
  const hash = b.password === undefined ? undefined : b.password === null ? null : await hashPassword(b.password);
  const ev = await one(
    `UPDATE events SET share_token = $2, share_enabled = coalesce($3, share_enabled),
       share_password_hash = CASE WHEN $4::boolean THEN $5 ELSE share_password_hash END,
       share_downloads = coalesce($6, share_downloads)
     WHERE id = $1 RETURNING *`,
    [g.event.id, token, b.enabled ?? null, hash !== undefined, hash ?? null, b.downloads ?? null]
  );
  res.json(eventOut(ev));
});

// ---------- Album selections and comments from clients ----------

r.get('/:id/selections', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  res.json(await selectionsForStudio(g.event));
});

// Unlock a client's sent selection so they can change it.
r.post('/:id/selections/:accountId/reopen', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  await reopenSelection(g.event.id, req.params.accountId);
  res.json({ ok: true });
});

r.get('/:id/comments', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const threads = await threadsForStudio(g.event.id);
  const photos = await Photo.find({ _id: { $in: [...new Set(threads.map((t) => t.photoId))] } }).lean();
  const views = new Map((await Promise.all(photos.map(photoView))).map((p) => [p.id, p]));
  res.json(threads.map((t) => ({ ...t, photo: views.get(t.photoId) || null })));
});

// The studio replies in one client's thread on a photo.
r.post('/:id/photos/:pid/comments', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const b = parse(z.object({ clientAccountId: z.string().uuid(), body: z.string().min(1).max(2000) }), req.body);
  const onEvent = await one('SELECT 1 FROM event_access WHERE event_id = $1 AND account_id = $2', [g.event.id, b.clientAccountId]);
  if (!onEvent) throw new HttpError(404, 'Client not found on this event');
  res.status(201).json(await addComment({ event: g.event, photoId: req.params.pid, clientAccountId: b.clientAccountId, authorAccountId: req.user.id, fromStudio: true, body: b.body }));
});

r.delete('/:id', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  if (!['super_admin', 'org_admin', 'studio_admin'].includes(req.user.role)) throw new HttpError(403, 'Only studio admins can delete events');
  const photos = await Photo.find({ eventId: g.event.id }).lean();
  for (const p of photos) {
    for (const k of [p.originalKey, p.variants?.thumb, p.variants?.web, p.variants?.wm]) if (k) await storage.remove(k).catch(() => {});
  }
  await Photo.deleteMany({ eventId: g.event.id });
  await deleteEventFaces(g.event.id);
  await q('DELETE FROM events WHERE id = $1', [g.event.id]);
  res.json({ ok: true });
});

// Step 1 of upload: the browser asks for signed upload URLs, then PUTs each file straight to storage.
r.post('/:id/uploads', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const { files, ceremony } = parse(
    z.object({
      ceremony: z.string().min(1).max(40).default('Wedding'),
      files: z.array(z.object({ name: z.string().max(255), type: z.string().max(100), size: z.number().int().positive() })).min(1).max(200),
    }),
    req.body
  );
  // Storage quota check (plan storage across the whole organization).
  const quota = await one(
    `SELECT p.storage_gb, coalesce(sum(e.storage_bytes),0)::bigint AS used
     FROM organizations o JOIN plans p ON p.id = o.plan_id
     LEFT JOIN studios s ON s.org_id = o.id LEFT JOIN events e ON e.studio_id = s.id
     WHERE o.id = $1 GROUP BY p.storage_gb`,
    [g.studio.org_id]
  );
  const incoming = files.reduce((s, f) => s + f.size, 0);
  if (Number(quota.used) + incoming > quota.storage_gb * 1024 ** 3) throw new HttpError(402, `Storage limit of ${quota.storage_gb} GB reached. Delete old events you no longer need, or move to a bigger plan.`);

  const out = [];
  for (const f of files) {
    const isRaw = RAW_EXT.test(f.name);
    const isVideo = !isRaw && (VIDEO_EXT.test(f.name) || f.type.startsWith('video/'));
    if (isVideo) {
      const ext = (f.name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
      if (!VIDEO_TYPES[ext]) {
        out.push({ name: f.name, error: 'Videos must be MP4, MOV, M4V or WebM' });
        continue;
      }
      if (f.size > MAX_VIDEO_BYTES) {
        out.push({ name: f.name, error: 'Videos can be up to 5 GB each' });
        continue;
      }
      const contentType = VIDEO_TYPES[ext];
      const key = `studios/${g.studio.id}/events/${g.event.id}/video/${crypto.randomUUID()}${ext}`;
      const video = await Photo.create({ eventId: g.event.id, studioId: g.studio.id, kind: 'video', ceremony, filename: f.name, originalKey: key, contentType, bytes: f.size, status: 'awaiting' });
      out.push({ name: f.name, photoId: video.id, upload: await storage.uploadUrl(key, { contentType }) });
      continue;
    }
    if (!isRaw && HEIC_EXT.test(f.name) && !IMAGE_TYPES.includes(f.type)) f.type = 'image/heic';
    if (!isRaw && !IMAGE_TYPES.includes(f.type)) {
      out.push({ name: f.name, error: 'Unsupported file type' });
      continue;
    }
    if (isRaw && !g.event.raw_enabled) {
      out.push({ name: f.name, error: 'Turn on RAW delivery for this event first' });
      continue;
    }
    const ext = (f.name.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
    const id = crypto.randomUUID();
    const key = `studios/${g.studio.id}/events/${g.event.id}/${isRaw ? 'raw' : 'original'}/${id}${ext}`;
    const contentType = isRaw ? 'application/octet-stream' : f.type;
    const photo = await Photo.create({
      eventId: g.event.id,
      studioId: g.studio.id,
      kind: isRaw ? 'raw' : 'image',
      ceremony,
      filename: f.name,
      originalKey: key,
      bytes: f.size,
      status: 'awaiting',
    });
    out.push({ name: f.name, photoId: photo.id, upload: await storage.uploadUrl(key, { contentType }) });
  }
  res.json({ files: out });
});

// Step 2: the browser reports which uploads finished; the server queues processing.
r.post('/:id/uploads/complete', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const { photoIds } = parse(z.object({ photoIds: z.array(z.string()).min(1).max(200) }), req.body);
  const photos = await Photo.find({ _id: { $in: photoIds }, eventId: g.event.id, status: 'awaiting' });
  for (const p of photos) {
    p.status = 'uploaded';
    await p.save();
    enqueuePhoto(p.id);
  }
  res.json({ queued: photos.length });
});

// Tell the event's clients their photos are ready (email + WhatsApp). The studio clicks this when
// uploading is finished, so clients get one message instead of one per upload batch.
r.post('/:id/notify-clients', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const notifyPlan = await one('SELECT p.client_galleries FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [g.studio.org_id]);
  if (!notifyPlan.client_galleries) throw new HttpError(402, 'Client galleries are not included in the Website plan. Upgrade to Starter or above to add clients.');
  const clients = await q(
    `SELECT a.id, a.name, a.email, a.phone FROM event_access ea JOIN accounts a ON a.id = ea.account_id WHERE ea.event_id = $1`,
    [g.event.id]
  );
  if (!clients.length) throw new HttpError(400, 'Add clients to this event first');
  const photoCount = await Photo.countDocuments({ eventId: g.event.id, kind: 'image', status: 'ready' });
  if (!photoCount) throw new HttpError(400, 'Upload photos before notifying clients');
  const brand = await studioBrand(g.studio.id);
  let emails = 0;
  let whatsapps = 0;
  for (const c of clients) {
    const msg = photosReadyMessage({ brand, name: c.name, event: g.event, photoCount });
    const r = await notify({ orgId: g.studio.org_id, kind: 'photos_ready', email: { to: c.email, ...msg.email }, whatsapp: c.phone ? { to: c.phone, ...msg.whatsapp } : undefined });
    if (['sent', 'logged'].includes(r.email?.status)) emails++;
    if (r.whatsapp?.status === 'sent') whatsapps++;
  }
  const [ev] = await q('UPDATE events SET clients_notified_at = now() WHERE id = $1 RETURNING clients_notified_at', [g.event.id]);
  res.json({ clients: clients.length, emails, whatsapps, notifiedAt: ev.clients_notified_at });
});

r.get('/:id/photos', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const filter = { eventId: g.event.id, kind: ['raw', 'video'].includes(req.query.kind) ? req.query.kind : 'image', status: { $ne: 'awaiting' } };
  if (req.query.ceremony) filter.ceremony = String(req.query.ceremony);
  if (req.query.highlights === '1') filter.isHighlight = true;
  const photos = await Photo.find(filter).sort({ ceremony: 1, filename: 1 }).limit(5000).lean();
  res.json(await Promise.all(photos.map(photoView)));
});

r.patch('/:id/photos', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const b = parse(
    z.object({ photoIds: z.array(z.string()).min(1).max(1000), isHighlight: z.boolean().optional(), ceremony: z.string().min(1).max(40).optional() }),
    req.body
  );
  const set = {};
  if (b.isHighlight !== undefined) set.isHighlight = b.isHighlight;
  if (b.ceremony) set.ceremony = b.ceremony;
  const out = await Photo.updateMany({ _id: { $in: b.photoIds }, eventId: g.event.id }, { $set: set });
  res.json({ updated: out.modifiedCount });
});

r.delete('/:id/photos', async (req, res) => {
  const g = await eventGuard(req, res, req.params.id);
  if (!g) return;
  const { photoIds } = parse(z.object({ photoIds: z.array(z.string()).min(1).max(1000) }), req.body);
  const photos = await Photo.find({ _id: { $in: photoIds }, eventId: g.event.id });
  let freed = 0;
  for (const p of photos) {
    for (const k of [p.originalKey, p.variants?.thumb, p.variants?.web, p.variants?.wm]) if (k) await storage.remove(k).catch(() => {});
    freed += p.bytes || 0;
    const faces = await Face.find({ photoId: p.id });
    for (const f of faces) await PersonCluster.updateOne({ _id: f.clusterId }, { $inc: { faceCount: -1 } });
    await Face.deleteMany({ photoId: p.id });
    await p.deleteOne();
  }
  await q('UPDATE events SET storage_bytes = greatest(0, storage_bytes - $2) WHERE id = $1', [g.event.id, freed]);
  res.json({ deleted: photos.length });
});

export default r;

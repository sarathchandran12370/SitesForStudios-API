// Client portal: a user sees only events their studio assigned to them.
import { Router } from 'express';
import express from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { q, one } from '../db/pg.js';
import { requireAuth, canManageStudio } from '../middleware/auth.js';
import { Photo, Face, PersonCluster } from '../models/index.js';
import { storage } from '../services/storage.js';
import { parse, HttpError } from '../util.js';
import { present } from '../services/clientInvoices.js';
import { designOf, downloadMode, listFiles, gallerySummary, eventPhoto, sendPreview, downloadOne, streamZip, faceSearchOn, findMe, studioCard } from '../services/gallery.js';
import { selectionState, setPicks, submitSelection, thread, addComment, commentedPhotoIds } from '../services/feedback.js';
import { notify, studioBrand, studioRecipients } from '../services/notify.js';
import { selectionSentMessage } from '../services/messages.js';

const r = Router();
r.use(requireAuth);

/** Resolve event access for the current user: client via event_access, or studio managers. */
async function access(req, eventId) {
  const event = await one('SELECT e.*, s.name AS studio_name, s.org_id FROM events e JOIN studios s ON s.id = e.studio_id WHERE e.id = $1', [eventId]);
  if (!event) throw new HttpError(404, 'Event not found');
  if (req.user.role === 'client') {
    const plan = await one('SELECT p.client_galleries FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [event.org_id]);
    if (!plan.client_galleries) throw new HttpError(403, `Online galleries are not available from ${event.studio_name} right now. Please contact your photographer.`);
    const a = await one('SELECT access_level FROM event_access WHERE event_id = $1 AND account_id = $2', [eventId, req.user.id]);
    if (!a) throw new HttpError(404, 'Event not found');
    return { event, level: a.access_level };
  }
  if (canManageStudio(req.user, { id: event.studio_id, org_id: event.org_id })) return { event, level: 'primary' };
  throw new HttpError(404, 'Event not found');
}

// Invoices the studio has sent to this client (drafts are never shown).
r.get('/invoices', async (req, res) => {
  const rows = await q(
    `SELECT i.*, e.title AS event_title, e.event_date, s.name AS studio_name
     FROM client_invoices i JOIN studios s ON s.id = i.studio_id LEFT JOIN events e ON e.id = i.event_id
     WHERE i.client_account_id = $1 AND i.status <> 'draft' ORDER BY i.issue_date DESC, i.created_at DESC`,
    [req.user.id]
  );
  res.json(
    rows.map((row) => {
      const i = present(row);
      return { id: i.id, number: i.number, status: i.status, issue_date: i.issue_date, due_date: i.due_date, total_paise: i.total_paise, paid_paise: i.paid_paise, balance_paise: i.balance_paise, overdue: i.overdue, event_title: i.event_title, studio_name: row.studio_name, view_url: i.view_url };
    })
  );
});

r.get('/events', async (req, res) => {
  const rows = await q(
    `SELECT e.id, e.title, e.event_date, e.venue, e.cover_photo_id, ea.access_level, s.name AS studio_name
     FROM event_access ea JOIN events e ON e.id = ea.event_id JOIN studios s ON s.id = e.studio_id
     WHERE ea.account_id = $1 ORDER BY e.event_date DESC NULLS LAST`,
    [req.user.id]
  );
  const out = [];
  for (const e of rows) {
    let cover = e.cover_photo_id ? await Photo.findById(e.cover_photo_id).lean().catch(() => null) : null;
    if (!cover) cover = await Photo.findOne({ eventId: e.id, kind: 'image', status: 'ready' }).sort({ isHighlight: -1, filename: 1 }).lean();
    const count = await Photo.countDocuments({ eventId: e.id, kind: 'image', status: 'ready' });
    out.push({ ...e, photoCount: count, cover: cover?.variants?.web ? await storage.url(cover.variants.web, { expiresIn: 3600 }) : null });
  }
  res.json(out);
});

const BASE = '/api/portal';
const isClient = (req) => req.user.role === 'client';

r.get('/events/:id', async (req, res) => {
  const { event, level } = await access(req, req.params.id);
  const summary = await gallerySummary(event);
  const rawCount = event.raw_enabled && level === 'primary' ? await Photo.countDocuments({ eventId: event.id, kind: 'raw', status: 'ready' }) : 0;
  const review = isClient(req) ? await one('SELECT rating, body, status FROM reviews WHERE event_id = $1 AND account_id = $2', [event.id, req.user.id]) : null;
  res.json({
    id: event.id,
    title: event.title,
    eventDate: event.event_date,
    venue: event.venue,
    studioName: event.studio_name,
    accessLevel: level,
    ...summary,
    rawAvailable: rawCount > 0,
    rawCount,
    facesEnabled: faceSearchOn(event),
    design: designOf(event),
    downloads: downloadMode(event),
    watermark: event.watermark,
    // Album selection and comments are for clients; studio staff previewing the gallery see neither.
    canSelect: isClient(req),
    selection: isClient(req) ? await selectionState(event, req.user.id) : null,
    commented: isClient(req) ? await commentedPhotoIds(event.id, req.user.id) : [],
    review,
    studio: await studioCard(event.studio_id),
  });
});

r.get('/events/:id/photos', async (req, res) => {
  const { event } = await access(req, req.params.id);
  const extra = {};
  if (req.query.cluster) {
    const ids = await clusterFamily(event.id, String(req.query.cluster));
    extra._id = { $in: await Face.distinct('photoId', { eventId: event.id, clusterId: { $in: ids } }) };
  } else if (req.query.picked === '1' && isClient(req)) {
    extra._id = { $in: (await selectionState(event, req.user.id)).ids };
  }
  res.json(await listFiles(event, req.query, BASE, extra));
});

// Large preview (2048 px). Goes through here only when the event has watermarks.
r.get('/photos/:pid/preview', async (req, res) => {
  const photo = await Photo.findById(req.params.pid).lean().catch(() => null);
  if (!photo) throw new HttpError(404, 'Photo not found');
  const { event } = await access(req, photo.eventId);
  await sendPreview(res, event, await eventPhoto(event, photo._id));
});

// ---------- People (face clusters) ----------

async function clusterFamily(eventId, clusterId) {
  const all = await PersonCluster.find({ eventId }, { _id: 1, mergedInto: 1 }).lean();
  const ids = new Set([clusterId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.mergedInto && ids.has(c.mergedInto) && !ids.has(String(c._id))) {
        ids.add(String(c._id));
        grew = true;
      }
    }
  }
  return [...ids];
}

r.get('/events/:id/people', async (req, res) => {
  const { event } = await access(req, req.params.id);
  const clusters = await PersonCluster.find({ eventId: event.id, mergedInto: null, faceCount: { $gt: 0 } }).sort({ faceCount: -1 }).limit(300).lean();
  const merged = await PersonCluster.find({ eventId: event.id, mergedInto: { $ne: null } }).lean();
  res.json(
    clusters.map((c) => ({
      id: String(c._id),
      label: c.label,
      photoCount: c.faceCount + merged.filter((m) => m.mergedInto === String(c._id)).reduce((s, m) => s + m.faceCount, 0),
      cover: `/api/portal/clusters/${c._id}/cover`,
    }))
  );
});

async function clusterAccess(req) {
  const cluster = await PersonCluster.findById(req.params.cid).catch(() => null);
  if (!cluster) throw new HttpError(404, 'Person not found');
  await access(req, cluster.eventId);
  return cluster;
}

r.get('/clusters/:cid/cover', async (req, res) => {
  const cluster = await clusterAccess(req);
  const face = await Face.findById(cluster.coverFaceId).lean();
  const photo = face && (await Photo.findById(face.photoId).lean());
  if (!photo?.variants?.web) throw new HttpError(404, 'No cover');
  const buf = await storage.getBuffer(photo.variants.web);
  const meta = await sharp(buf).metadata();
  const pad = 0.35;
  const left = Math.max(0, Math.floor((face.box.left - face.box.width * pad) * meta.width));
  const top = Math.max(0, Math.floor((face.box.top - face.box.height * pad) * meta.height));
  const width = Math.min(meta.width - left, Math.ceil(face.box.width * (1 + 2 * pad) * meta.width));
  const height = Math.min(meta.height - top, Math.ceil(face.box.height * (1 + 2 * pad) * meta.height));
  const img = await sharp(buf).extract({ left, top, width, height }).resize(200, 200, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
  res.set('Cache-Control', 'private, max-age=3600').type('image/webp').send(img);
});

// Users (and studios) can name a person. The name applies inside this event only.
r.patch('/clusters/:cid', async (req, res) => {
  const cluster = await clusterAccess(req);
  const { label } = parse(z.object({ label: z.string().max(60) }), req.body);
  cluster.label = label.trim();
  await cluster.save();
  res.json({ id: cluster.id, label: cluster.label });
});

r.post('/clusters/:cid/merge', async (req, res) => {
  const cluster = await clusterAccess(req);
  const { intoId } = parse(z.object({ intoId: z.string() }), req.body);
  const target = await PersonCluster.findOne({ _id: intoId, eventId: cluster.eventId, mergedInto: null }).catch(() => null);
  if (!target || target.id === cluster.id) throw new HttpError(400, 'Choose another person in this event');
  cluster.mergedInto = target.id;
  if (!target.label && cluster.label) target.label = cluster.label;
  await cluster.save();
  await target.save();
  await PersonCluster.updateMany({ mergedInto: cluster.id }, { $set: { mergedInto: target.id } });
  res.json({ ok: true });
});

// "Find me": upload a selfie, get matching photos. The selfie is not stored.
r.post('/events/:id/find-me', express.raw({ type: ['image/*'], limit: '8mb' }), async (req, res) => {
  const { event } = await access(req, req.params.id);
  res.json(await findMe(event, req.body, BASE));
});

// ---------- Album selection (each client picks their own) ----------

async function clientAccess(req, eventId) {
  if (!isClient(req)) throw new HttpError(403, 'Album selection is for clients');
  return access(req, eventId);
}

r.get('/events/:id/selection', async (req, res) => {
  const { event } = await clientAccess(req, req.params.id);
  res.json(await selectionState(event, req.user.id));
});

r.put('/events/:id/selection', async (req, res) => {
  const { event } = await clientAccess(req, req.params.id);
  const b = parse(z.object({ photoIds: z.array(z.string().max(40)).min(1).max(2000), picked: z.boolean() }), req.body);
  res.json(await setPicks(event, req.user.id, b.photoIds, b.picked));
});

// Send the selection to the studio. It is locked until the studio reopens it.
r.post('/events/:id/selection/submit', async (req, res) => {
  const { event } = await clientAccess(req, req.params.id);
  const { note } = parse(z.object({ note: z.string().max(1000).optional() }), req.body || {});
  const state = await submitSelection(event, req.user.id, note?.trim());
  const brand = await studioBrand(event.studio_id);
  const to = await studioRecipients(brand);
  const msg = selectionSentMessage({ brand, event, clientName: req.user.name, count: state.ids.length, note: state.note });
  await Promise.all(to.emails.map((email) => notify({ orgId: brand.org_id, kind: 'selection_sent', email: { to: email, ...msg.email } })));
  res.json(state);
});

// ---------- Comments on photos (this client and the studio) ----------

r.get('/photos/:pid/comments', async (req, res) => {
  const photo = await Photo.findById(req.params.pid).lean().catch(() => null);
  if (!photo) throw new HttpError(404, 'Photo not found');
  await clientAccess(req, photo.eventId);
  res.json(await thread(photo.eventId, String(photo._id), req.user.id));
});

r.post('/photos/:pid/comments', async (req, res) => {
  const photo = await Photo.findById(req.params.pid).lean().catch(() => null);
  if (!photo) throw new HttpError(404, 'Photo not found');
  const { event } = await clientAccess(req, photo.eventId);
  const { body } = parse(z.object({ body: z.string().min(1).max(2000) }), req.body);
  res.status(201).json(await addComment({ event, photoId: String(photo._id), clientAccountId: req.user.id, authorAccountId: req.user.id, fromStudio: false, body }));
});

// ---------- Review for the studio (published on its website once the studio approves) ----------

r.put('/events/:id/review', async (req, res) => {
  const { event } = await clientAccess(req, req.params.id);
  const b = parse(z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().min(10, 'Write at least a few words').max(1500), name: z.string().trim().min(2).max(80).optional() }), req.body);
  // Editing a review sends it back to the studio for approval.
  const row = await one(
    `INSERT INTO reviews(studio_id, event_id, account_id, author_name, rating, body) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (event_id, account_id) DO UPDATE SET author_name = EXCLUDED.author_name, rating = EXCLUDED.rating, body = EXCLUDED.body, status = 'pending', updated_at = now()
     RETURNING rating, body, status`,
    [event.studio_id, event.id, req.user.id, b.name || req.user.name, b.rating, b.body]
  );
  res.json(row);
});

// ---------- Downloads ----------

r.get('/photos/:pid/download', async (req, res) => {
  const photo = await Photo.findById(req.params.pid).lean().catch(() => null);
  if (!photo || photo.status !== 'ready') throw new HttpError(404, 'Photo not found');
  const { event, level } = await access(req, photo.eventId);
  if (photo.kind === 'raw' && (!event.raw_enabled || level !== 'primary')) throw new HttpError(403, 'RAW files are only for the couple');
  await downloadOne(res, event, photo, downloadMode(event));
});

r.get('/events/:id/download', async (req, res) => {
  const { event, level } = await access(req, req.params.id);
  await streamZip(res, event, {
    type: String(req.query.type || 'all'),
    ceremony: req.query.ceremony,
    ids: req.query.ids,
    mode: downloadMode(event),
    rawAllowed: event.raw_enabled && level === 'primary',
  });
});

export default r;

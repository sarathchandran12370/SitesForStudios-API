// Client portal: a user sees only events their studio assigned to them.
import { Router } from 'express';
import express from 'express';
import sharp from 'sharp';
import { ZipArchive } from 'archiver';
import { z } from 'zod';
import { q, one } from '../db/pg.js';
import { requireAuth, canManageStudio } from '../middleware/auth.js';
import { Photo, Face, PersonCluster } from '../models/index.js';
import { storage } from '../services/storage.js';
import { searchBySelfie, facesEnabled } from '../services/faces.js';
import { parse, HttpError } from '../util.js';
import { photoView } from './photoView.js';

const r = Router();
r.use(requireAuth);

/** Resolve event access for the current user: client via event_access, or studio managers. */
async function access(req, eventId) {
  const event = await one('SELECT e.*, s.name AS studio_name, s.org_id FROM events e JOIN studios s ON s.id = e.studio_id WHERE e.id = $1', [eventId]);
  if (!event) throw new HttpError(404, 'Event not found');
  if (req.user.role === 'client') {
    const a = await one('SELECT access_level FROM event_access WHERE event_id = $1 AND account_id = $2', [eventId, req.user.id]);
    if (!a) throw new HttpError(404, 'Event not found');
    if (event.status !== 'active') {
      throw new HttpError(410, `This gallery has been archived. Please contact ${event.studio_name} if you would like it restored.`);
    }
    return { event, level: a.access_level };
  }
  if (canManageStudio(req.user, { id: event.studio_id, org_id: event.org_id })) return { event, level: 'primary' };
  throw new HttpError(404, 'Event not found');
}

r.get('/events', async (req, res) => {
  const rows = await q(
    `SELECT e.id, e.title, e.event_date, e.venue, e.cover_photo_id, e.status, e.expires_at, ea.access_level, s.name AS studio_name
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

r.get('/events/:id', async (req, res) => {
  const { event, level } = await access(req, req.params.id);
  const ceremonies = await Photo.aggregate([
    { $match: { eventId: event.id, kind: 'image', status: 'ready' } },
    { $group: { _id: '$ceremony', n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const highlights = await Photo.countDocuments({ eventId: event.id, kind: 'image', status: 'ready', isHighlight: true });
  const rawCount = event.raw_enabled && level === 'primary' ? await Photo.countDocuments({ eventId: event.id, kind: 'raw', status: 'ready' }) : 0;
  res.json({
    id: event.id,
    title: event.title,
    eventDate: event.event_date,
    venue: event.venue,
    studioName: event.studio_name,
    accessLevel: level,
    status: event.status,
    expiresAt: event.expires_at,
    ceremonies: ceremonies.map((c) => ({ name: c._id, count: c.n })),
    highlightCount: highlights,
    rawAvailable: rawCount > 0,
    rawCount,
    facesEnabled: facesEnabled() && event.face_enabled,
  });
});

r.get('/events/:id/photos', async (req, res) => {
  const { event } = await access(req, req.params.id);
  const filter = { eventId: event.id, kind: 'image', status: 'ready' };
  if (req.query.ceremony) filter.ceremony = String(req.query.ceremony);
  if (req.query.highlights === '1') filter.isHighlight = true;
  if (req.query.cluster) {
    const ids = await clusterFamily(event.id, String(req.query.cluster));
    filter._id = { $in: await Face.distinct('photoId', { eventId: event.id, clusterId: { $in: ids } }) };
  }
  const photos = await Photo.find(filter).sort({ ceremony: 1, filename: 1 }).limit(5000).lean();
  res.json(await Promise.all(photos.map(photoView)));
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
  if (!facesEnabled() || !event.face_enabled) throw new HttpError(400, 'Face search is not available for this event');
  if (!req.body?.length) throw new HttpError(400, 'Send a selfie image');
  const jpeg = await sharp(req.body).rotate().resize({ width: 1200, height: 1200, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const ids = await searchBySelfie({ eventId: event.id, imageBytes: jpeg });
  const photos = await Photo.find({ _id: { $in: ids }, kind: 'image', status: 'ready' }).lean();
  res.json(await Promise.all(photos.map(photoView)));
});

// ---------- Downloads ----------

// Single full-resolution photo: redirect to a short-lived signed URL.
r.get('/photos/:pid/download', async (req, res) => {
  const photo = await Photo.findById(req.params.pid).lean().catch(() => null);
  if (!photo || photo.status !== 'ready') throw new HttpError(404, 'Photo not found');
  const { event, level } = await access(req, photo.eventId);
  if (event.status !== 'active') throw new HttpError(410, 'This gallery is archived');
  if (photo.kind === 'raw' && (!event.raw_enabled || level !== 'primary')) throw new HttpError(403, 'RAW files are only for the couple');
  res.redirect(await storage.url(photo.originalKey, { expiresIn: 900, download: photo.filename }));
});

// ZIP download streamed on the fly. Production: build ZIPs <= 5 GB in a background job and email the link.
r.get('/events/:id/download', async (req, res) => {
  const { event, level } = await access(req, req.params.id);
  if (event.status !== 'active') throw new HttpError(410, 'This gallery is archived');
  const type = String(req.query.type || 'all');
  const filter = { eventId: event.id, status: 'ready' };
  if (type === 'raw') {
    if (!event.raw_enabled || level !== 'primary') throw new HttpError(403, 'RAW files are only for the couple');
    filter.kind = 'raw';
  } else {
    filter.kind = 'image';
    if (type === 'highlights') filter.isHighlight = true;
    else if (type === 'selected') filter._id = { $in: String(req.query.ids || '').split(',').filter(Boolean).slice(0, 2000) };
    else if (type === 'ceremony') filter.ceremony = String(req.query.ceremony || '');
    else if (type !== 'all') throw new HttpError(400, 'Unknown download type');
  }
  const photos = await Photo.find(filter).sort({ ceremony: 1, filename: 1 }).lean();
  if (!photos.length) throw new HttpError(404, 'Nothing to download');

  const safe = (s) => String(s).replace(/[^\w\- ]+/g, '').trim() || 'photos';
  const zipName = `${safe(event.title)} - ${type === 'raw' ? 'RAW' : type}.zip`;
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName}"`);
  const archive = new ZipArchive({ store: true }); // photos are already compressed
  archive.on('error', (e) => res.destroy(e));
  archive.pipe(res);
  const used = new Set();
  for (const p of photos) {
    let name = type === 'raw' ? p.filename : `${safe(p.ceremony)}/${p.filename}`;
    while (used.has(name)) name = name.replace(/(\.[^.]+)?$/, '-1$1');
    used.add(name);
    // Append one file at a time so thousands of photos don't open thousands of streams at once.
    const done = new Promise((resolve) => archive.once('entry', resolve));
    archive.append(await storage.getStream(p.originalKey), { name });
    await done;
    if (res.destroyed) return;
  }
  await archive.finalize();
});

export default r;

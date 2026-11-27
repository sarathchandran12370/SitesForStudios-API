// Gallery viewing and downloads, shared by the client portal (/api/portal) and guest share links (/api/share).
// Each router does its own access check first, then calls these with the event row and what the viewer may do.
import sharp from 'sharp';
import { ZipArchive } from 'archiver';
import { one } from '../db/pg.js';
import { Photo, SiteConfig } from '../models/index.js';
import { storage } from './storage.js';
import { searchBySelfie, facesEnabled } from './faces.js';
import { config } from '../config.js';
import { HttpError } from '../util.js';

// ---------- Gallery design ----------

export const DESIGN_OPTIONS = {
  layout: ['masonry', 'grid', 'rows'],
  theme: ['light', 'dark'],
  font: ['classic', 'modern', 'editorial'],
  cover: ['full', 'split', 'minimal'],
};
export const DESIGN_DEFAULTS = { layout: 'masonry', theme: 'light', font: 'classic', cover: 'full' };

/** The event's gallery design with defaults filled in and unknown values dropped. */
export function designOf(event) {
  const d = event?.design || {};
  const out = { ...DESIGN_DEFAULTS };
  for (const [k, allowed] of Object.entries(DESIGN_OPTIONS)) if (allowed.includes(d[k])) out[k] = d[k];
  return out;
}

// ---------- What a viewer may download ----------

/**
 * 'full' (originals), 'web' (2048 px JPEG, watermarked when the event has watermarks) or 'none'.
 * Guests on a share link get nothing when the studio turned share downloads off.
 */
export function downloadMode(event, { guestLink = false } = {}) {
  if (guestLink && !event.share_downloads) return 'none';
  return ['full', 'web', 'none'].includes(event.downloads) ? event.downloads : 'full';
}

// ---------- Watermarks ----------

const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** The studio name repeated diagonally across the picture, white with a soft shadow so it shows on any photo. */
function watermarkSvg(width, height, text) {
  const size = Math.max(18, Math.round(Math.min(width, height) / 14));
  const label = escXml(text);
  const stepX = Math.round(size * Math.max(6, text.length * 0.75));
  const stepY = Math.round(size * 4.5);
  const rows = [];
  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width + ((y / stepY) % 2) * (stepX / 2); x < width * 2; x += stepX) {
      rows.push(`<text x="${Math.round(x)}" y="${Math.round(y)}">${label}</text>`);
    }
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <g transform="rotate(-30 ${width / 2} ${height / 2})" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" font-weight="600">
        <g fill="#000" fill-opacity="0.18" transform="translate(1.5 1.5)">${rows.join('')}</g>
        <g fill="#fff" fill-opacity="0.38">${rows.join('')}</g>
      </g>
    </svg>`
  );
}

/** Make a watermarked copy of any image buffer. */
export async function applyWatermark(buf, text) {
  const meta = await sharp(buf).metadata();
  return sharp(buf)
    .composite([{ input: watermarkSvg(meta.width, meta.height, text), top: 0, left: 0 }])
    .webp({ quality: 82 })
    .toBuffer();
}

/**
 * Storage key of the watermarked web-size preview, made on first request and kept.
 * Made again if the watermark text (the studio name) changed since.
 */
export async function watermarkedKey(photo, text) {
  if (photo.variants?.wm && photo.wmText === text) return photo.variants.wm;
  if (!photo.variants?.web) throw new HttpError(404, 'Photo not ready');
  const out = await applyWatermark(await storage.getBuffer(photo.variants.web), text);
  const key = photo.variants.web.replace(/\/web\/([^/]+)\.webp$/, '/wm/$1.webp');
  await storage.put(key, out, 'image/webp');
  await Photo.updateOne({ _id: photo._id }, { $set: { 'variants.wm': key, wmText: text } });
  return key;
}

export async function watermarkText(event) {
  const s = event.studio_name ? { name: event.studio_name } : await one('SELECT name FROM studios WHERE id = $1', [event.studio_id]);
  return `© ${s?.name || 'Photographer'}`;
}

// ---------- Listing ----------

/**
 * Shape a file for a gallery viewer. With watermarks on, the large preview goes through
 * `${base}/photos/:id/preview`, which serves the watermarked copy (thumbnails are small and stay plain).
 */
export async function viewerPhoto(p, event, base) {
  const id = String(p._id);
  if (p.kind === 'video') {
    return { id, kind: 'video', filename: p.filename, ceremony: p.ceremony, bytes: p.bytes, contentType: p.contentType || 'video/mp4', src: await storage.url(p.originalKey, { expiresIn: 6 * 3600 }) };
  }
  const ready = p.status === 'ready' && p.variants?.thumb;
  return {
    id,
    kind: p.kind,
    filename: p.filename,
    ceremony: p.ceremony,
    isHighlight: p.isHighlight,
    width: p.width,
    height: p.height,
    thumb: ready ? await storage.url(p.variants.thumb, { expiresIn: 3600 }) : null,
    web: !ready ? null : event.watermark ? `${base}/photos/${id}/preview` : await storage.url(p.variants.web, { expiresIn: 3600 }),
  };
}

/** Photos (and videos) for the gallery, filtered like the portal's tabs. */
export async function listFiles(event, query, base, extraFilter = {}) {
  const filter = { eventId: event.id, status: 'ready', kind: query.videos === '1' ? 'video' : 'image', ...extraFilter };
  if (query.ceremony) filter.ceremony = String(query.ceremony);
  if (query.highlights === '1') filter.isHighlight = true;
  const photos = await Photo.find(filter).sort({ ceremony: 1, filename: 1 }).limit(5000).lean();
  return Promise.all(photos.map((p) => viewerPhoto(p, event, base)));
}

/** Counts shown in the gallery header. */
export async function gallerySummary(event) {
  const [ceremonies, highlightCount, videoCount] = await Promise.all([
    Photo.aggregate([{ $match: { eventId: event.id, kind: 'image', status: 'ready' } }, { $group: { _id: '$ceremony', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Photo.countDocuments({ eventId: event.id, kind: 'image', status: 'ready', isHighlight: true }),
    Photo.countDocuments({ eventId: event.id, kind: 'video', status: 'ready' }),
  ]);
  return { ceremonies: ceremonies.map((c) => ({ name: c._id, count: c.n })), highlightCount, videoCount };
}

/** A ready image of this event, or 404. */
export async function eventPhoto(event, photoId, kinds = ['image']) {
  const photo = await Photo.findOne({ _id: photoId, eventId: event.id, status: 'ready', kind: { $in: kinds } })
    .lean()
    .catch(() => null);
  if (!photo) throw new HttpError(404, 'Photo not found');
  return photo;
}

/** Redirect to the large preview: the watermarked copy when the event has watermarks. */
export async function sendPreview(res, event, photo) {
  const key = event.watermark ? await watermarkedKey(photo, await watermarkText(event)) : photo.variants.web;
  res.set('Cache-Control', 'private, max-age=600');
  res.redirect(await storage.url(key, { expiresIn: 3600 }));
}

// ---------- Downloads ----------

const jpgName = (filename) => `${String(filename || 'photo').replace(/\.[^.]+$/, '')}.jpg`;

/** The web-size JPEG a 'web' download hands out (watermarked when the event has watermarks). */
async function webJpeg(event, photo) {
  const key = event.watermark ? await watermarkedKey(photo, await watermarkText(event)) : photo.variants.web;
  return sharp(await storage.getBuffer(key)).jpeg({ quality: 90 }).toBuffer();
}

/** One file. 'full' redirects to the original; 'web' sends the web-size JPEG; 'none' is refused. */
export async function downloadOne(res, event, photo, mode) {
  if (mode === 'none') throw new HttpError(403, 'Downloads are turned off for this gallery');
  if (mode === 'web' && photo.kind !== 'image') throw new HttpError(403, 'Only web-size photo downloads are allowed for this gallery');
  if (mode === 'full') return res.redirect(await storage.url(photo.originalKey, { expiresIn: 900, download: photo.filename }));
  res.attachment(jpgName(photo.filename)).type('image/jpeg').send(await webJpeg(event, photo));
}

/**
 * ZIP streamed on the fly. type: all | highlights | ceremony | selected | raw | videos.
 * Production: build ZIPs <= 5 GB in a background job and email the link.
 */
export async function streamZip(res, event, { type, ceremony, ids, mode, rawAllowed }) {
  if (mode === 'none') throw new HttpError(403, 'Downloads are turned off for this gallery');
  const filter = { eventId: event.id, status: 'ready' };
  if (type === 'raw') {
    if (!rawAllowed) throw new HttpError(403, 'RAW files are only for the couple');
    if (mode !== 'full') throw new HttpError(403, 'Only web-size photo downloads are allowed for this gallery');
    filter.kind = 'raw';
  } else if (type === 'videos') {
    if (mode !== 'full') throw new HttpError(403, 'Only web-size photo downloads are allowed for this gallery');
    filter.kind = 'video';
  } else {
    filter.kind = 'image';
    if (type === 'highlights') filter.isHighlight = true;
    else if (type === 'selected') filter._id = { $in: String(ids || '').split(',').filter(Boolean).slice(0, 2000) };
    else if (type === 'ceremony') filter.ceremony = String(ceremony || '');
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
  const web = mode === 'web';
  for (const p of photos) {
    const file = web ? jpgName(p.filename) : p.filename;
    let name = type === 'raw' || type === 'videos' ? file : `${safe(p.ceremony)}/${file}`;
    while (used.has(name)) name = name.replace(/(\.[^.]+)?$/, '-1$1');
    used.add(name);
    // Append one file at a time so thousands of photos don't open thousands of streams at once.
    const done = new Promise((resolve) => archive.once('entry', resolve));
    archive.append(web ? await webJpeg(event, p) : await storage.getStream(p.originalKey), { name });
    await done;
    if (res.destroyed) return;
  }
  await archive.finalize();
}

// ---------- Face search ----------

export const faceSearchOn = (event) => facesEnabled() && !!event.face_enabled;

/** "Find me": photos matching a selfie. The selfie is not stored. */
export async function findMe(event, selfie, base) {
  if (!faceSearchOn(event)) throw new HttpError(400, 'Face search is not available for this event');
  if (!selfie?.length) throw new HttpError(400, 'Send a selfie image');
  const jpeg = await sharp(selfie).rotate().resize({ width: 1200, height: 1200, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const ids = await searchBySelfie({ eventId: event.id, imageBytes: jpeg });
  const photos = await Photo.find({ _id: { $in: ids }, eventId: event.id, kind: 'image', status: 'ready' }).lean();
  return Promise.all(photos.map((p) => viewerPhoto(p, event, base)));
}

// ---------- Studio contact card ----------

/** Who to contact, shown in every gallery: the studio's website contact details, logo and website link. */
export async function studioCard(studioId) {
  const studio = await one('SELECT id, name, slug, custom_domain, domain_status, published_at FROM studios WHERE id = $1', [studioId]);
  if (!studio) return null;
  const site = await SiteConfig.findOne({ studioId }, { contact: 1, logoKey: 1, theme: 1, tagline: 1 }).lean();
  const c = site?.contact || {};
  const website = !studio.published_at
    ? null
    : ['verified', 'live'].includes(studio.domain_status) && studio.custom_domain
      ? `https://${studio.custom_domain}`
      : `${config.appUrl}/s/${studio.slug}`;
  return {
    name: studio.name,
    tagline: site?.tagline || '',
    logoUrl: site?.logoKey ? await storage.url(site.logoKey, { expiresIn: 6 * 3600 }) : null,
    accent: site?.theme?.accent || '#9a6b3c',
    phone: c.phone || null,
    whatsapp: c.whatsapp || null,
    email: c.email || null,
    city: c.city || null,
    instagram: c.instagram || null,
    youtube: c.youtube || null,
    website,
  };
}

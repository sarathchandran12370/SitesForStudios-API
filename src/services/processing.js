// In-process job queue for photo processing (thumbnails + face indexing).
// Production: replace with S3 event -> SQS -> Lambda workers; the per-photo function stays the same.
import sharp from 'sharp';
import convertHeic from 'heic-convert';
import { storage } from './storage.js';
import { Photo } from '../models/index.js';
import { indexPhotoFaces, facesEnabled } from './faces.js';
import { q } from '../db/pg.js';
import { config } from '../config.js';

// Small servers: one photo at a time, no libvips cache (keeps memory low; see PROCESSING_CONCURRENCY).
const CONCURRENCY = config.processingConcurrency;
sharp.cache(false);
if (CONCURRENCY === 1) sharp.concurrency(1);

// HEIC/HEIF (iPhone) brands in the file's "ftyp" box. sharp's prebuilt binaries can't decode HEVC images,
// so these are converted to JPEG in memory first. The original HEIC file is still what clients download.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
export function isHeic(buf) {
  return buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp' && HEIC_BRANDS.includes(buf.toString('ascii', 8, 12));
}

async function decodable(buf) {
  if (!isHeic(buf)) return buf;
  return Buffer.from(await convertHeic({ buffer: buf, format: 'JPEG', quality: 0.92 }));
}
const queue = [];
let running = 0;

export function enqueuePhoto(photoId) {
  queue.push(photoId);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running++;
    processPhoto(id)
      .catch((e) => console.error('process failed', id, e.message))
      .finally(() => {
        running--;
        pump();
      });
  }
}

export async function processPhoto(photoId) {
  const photo = await Photo.findById(photoId);
  if (!photo) return;
  photo.status = 'processing';
  await photo.save();
  try {
    const bytes = await storage.size(photo.originalKey);
    photo.bytes = bytes;
    if (photo.kind === 'raw') {
      photo.status = 'ready';
      await photo.save();
      await addEventBytes(photo.eventId, bytes);
      return;
    }
    const input = await decodable(await storage.getBuffer(photo.originalKey));
    const meta = await sharp(input).metadata(); // header only, no decode
    const base = photo.originalKey.replace(/\/(original|raw)\/[^/]+$/, '');

    // Decode the full-size photo once into a 2048 px working copy; every variant is made from that.
    const { data, info } = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const working = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    const web = await working().webp({ quality: 82 }).toBuffer();
    const thumb = await working().resize({ width: 480, height: 480, fit: 'inside' }).webp({ quality: 72 }).toBuffer();

    const thumbKey = `${base}/thumb/${photo.id}.webp`;
    const webKey = `${base}/web/${photo.id}.webp`;
    await storage.put(thumbKey, thumb, 'image/webp');
    await storage.put(webKey, web, 'image/webp');
    const rotated = meta.orientation && meta.orientation >= 5;
    photo.width = rotated ? meta.height : meta.width;
    photo.height = rotated ? meta.width : meta.height;
    photo.variants = { thumb: thumbKey, web: webKey };
    photo.status = 'ready';
    photo.error = undefined;
    await photo.save();
    await addEventBytes(photo.eventId, bytes + thumb.length + web.length);

    if (facesEnabled()) {
      const [event] = await q('SELECT face_enabled FROM events WHERE id = $1', [photo.eventId]);
      if (event?.face_enabled) {
        // Rekognition accepts up to 5 MB; send a 1600 px JPEG made from the working copy.
        const jpeg = await working().resize({ width: 1600, height: 1600, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
        await indexPhotoFaces({ eventId: photo.eventId, photoId: photo.id, imageBytes: jpeg });
        photo.facesIndexed = true;
        await photo.save();
      }
    }
  } catch (e) {
    photo.status = 'failed';
    photo.error = e.message;
    await photo.save();
    throw e;
  }
}

async function addEventBytes(eventId, bytes) {
  await q('UPDATE events SET storage_bytes = storage_bytes + $2 WHERE id = $1', [eventId, bytes]);
}

/** Re-queue photos left unfinished by a restart. */
export async function resumePending() {
  const pending = await Photo.find({ status: { $in: ['uploaded', 'processing'] }, originalKey: { $exists: true } }, { _id: 1 });
  for (const p of pending) {
    try {
      await storage.size((await Photo.findById(p._id)).originalKey);
      enqueuePhoto(p.id);
    } catch {
      /* file never arrived; leave it */
    }
  }
}

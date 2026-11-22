import { storage } from '../services/storage.js';

/** Shape a photo document for the browser, with short-lived signed URLs. */
export async function photoView(p) {
  const id = String(p._id);
  const ready = p.status === 'ready' && p.variants?.thumb;
  return {
    id,
    kind: p.kind,
    filename: p.filename,
    ceremony: p.ceremony,
    isHighlight: p.isHighlight,
    status: p.status,
    width: p.width,
    height: p.height,
    bytes: p.bytes,
    thumb: ready ? await storage.url(p.variants.thumb, { expiresIn: 3600 }) : null,
    web: ready ? await storage.url(p.variants.web, { expiresIn: 3600 }) : null,
  };
}

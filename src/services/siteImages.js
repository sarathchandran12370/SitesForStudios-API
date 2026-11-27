// Website images: each template image slot holds either a highlight photo from the studio's events
// ({ photoId }) or a file the studio uploaded for its website ({ key }). Used by the studio editor
// (routes/studios.js) and the public website (routes/public.js).
import { Photo } from '../models/index.js';
import { storage } from './storage.js';

export const siteImagePrefix = (studioId) => `studios/${studioId}/site/`;

/** Hero list, falling back to the older heroPhotoIds field. */
export const heroList = (site) =>
  site.heroImages?.length ? site.heroImages : (site.heroPhotoIds || []).map((photoId) => ({ photoId }));

/**
 * Signed URLs for a list of slot images, in order. Images that no longer exist (deleted photo,
 * another studio's photo, foreign key) come back with url null.
 */
export async function resolveSiteImages(studioId, images, { expiresIn = 3600, variant = 'web' } = {}) {
  const list = (images || []).filter((i) => i && (i.photoId || i.key));
  const ids = list.map((i) => i.photoId).filter(Boolean);
  const photos = ids.length ? await Photo.find({ _id: { $in: ids }, studioId, kind: 'image', status: 'ready' }).lean() : [];
  const byId = new Map(photos.map((p) => [String(p._id), p]));
  const prefix = siteImagePrefix(studioId);
  return Promise.all(
    list.map(async (i) => {
      let url = null;
      if (i.photoId) {
        const p = byId.get(String(i.photoId));
        const k = p && (p.variants?.[variant] || p.variants?.web);
        if (k) url = await storage.url(k, { expiresIn });
      } else if (i.key.startsWith(prefix)) {
        url = await storage.url(i.key, { expiresIn });
      }
      return { photoId: i.photoId || undefined, key: i.key || undefined, url };
    })
  );
}

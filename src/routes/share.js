// Public: guest share links (/g/:token in the web app). Anyone with the link can view the gallery without an account;
// when the studio set a password, the guest unlocks it once and gets a cookie scoped to this link's API path.
// Guests never see RAW files, album selections, comments or face-cluster names.
import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one } from '../db/pg.js';
import { config } from '../config.js';
import { BLOCKED_ORG_STATUSES } from '../middleware/auth.js';
import { parse, checkPassword, HttpError } from '../util.js';
import { designOf, downloadMode, listFiles, gallerySummary, eventPhoto, sendPreview, downloadOne, streamZip, faceSearchOn, findMe, studioCard } from '../services/gallery.js';

const r = Router();

const viewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600 * config.rateLimitScale, standardHeaders: 'draft-7', legacyHeaders: false });
const unlockLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 * config.rateLimitScale, standardHeaders: 'draft-7', legacyHeaders: false });
r.use(viewLimiter);
r.use((_req, res, next) => {
  res.set({ 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  next();
});

const COOKIE = 'sfs_share';
const cookiePath = (token) => `/api/share/${token}`;
// Changing or removing the password changes this, so earlier unlocks stop working.
const passwordStamp = (hash) => crypto.createHash('sha256').update(String(hash)).digest('base64url').slice(0, 16);

/** The shared event, or 404 when the link is off, unknown, or the studio's account can't serve galleries. */
async function sharedEvent(token) {
  if (!/^[\w-]{16,64}$/.test(String(token))) throw new HttpError(404, 'This link is not valid');
  const event = await one(
    `SELECT e.*, s.name AS studio_name, p.client_galleries
     FROM events e JOIN studios s ON s.id = e.studio_id JOIN organizations o ON o.id = s.org_id JOIN plans p ON p.id = o.plan_id
     WHERE e.share_token = $1 AND e.share_enabled AND o.status <> ALL($2)`,
    [token, BLOCKED_ORG_STATUSES]
  );
  if (!event || !event.client_galleries) throw new HttpError(404, 'This link is not valid or has been turned off. Please ask your photographer for a new one.');
  return event;
}

function unlocked(req, event) {
  if (!event.share_password_hash) return true;
  try {
    const p = jwt.verify(req.cookies?.[COOKIE] || '', config.jwtSecret);
    return p.t === event.share_token && p.s === passwordStamp(event.share_password_hash);
  } catch {
    return false;
  }
}

/** Load the event and refuse until the password is entered. */
async function guard(req) {
  const event = await sharedEvent(req.params.token);
  if (!unlocked(req, event)) throw Object.assign(new HttpError(401, 'Enter the password to view this gallery'), { needsPassword: true });
  return event;
}

const base = (event) => `/api/share/${event.share_token}`;

r.get('/:token', async (req, res) => {
  const event = await sharedEvent(req.params.token);
  const studio = await studioCard(event.studio_id);
  if (!unlocked(req, event)) {
    return res.json({ locked: true, title: event.title, studioName: event.studio_name, studio, design: designOf(event) });
  }
  res.json({
    locked: false,
    title: event.title,
    eventDate: event.event_date,
    venue: event.venue,
    studioName: event.studio_name,
    ...(await gallerySummary(event)),
    facesEnabled: faceSearchOn(event),
    design: designOf(event),
    downloads: downloadMode(event, { guestLink: true }),
    watermark: event.watermark,
    studio,
  });
});

r.post('/:token/unlock', unlockLimiter, async (req, res) => {
  const event = await sharedEvent(req.params.token);
  const { password } = parse(z.object({ password: z.string().min(1).max(100) }), req.body);
  if (!event.share_password_hash) return res.json({ ok: true });
  if (!(await checkPassword(password, event.share_password_hash))) throw new HttpError(401, 'That password is not right');
  const value = jwt.sign({ t: event.share_token, s: passwordStamp(event.share_password_hash) }, config.jwtSecret, { expiresIn: '30d' });
  res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 30 * 24 * 3600 * 1000, path: cookiePath(event.share_token) });
  res.json({ ok: true });
});

r.get('/:token/photos', async (req, res) => {
  const event = await guard(req);
  res.json(await listFiles(event, { ceremony: req.query.ceremony, highlights: req.query.highlights, videos: req.query.videos }, base(event)));
});

r.get('/:token/photos/:pid/preview', async (req, res) => {
  const event = await guard(req);
  await sendPreview(res, event, await eventPhoto(event, req.params.pid));
});

r.post('/:token/find-me', express.raw({ type: ['image/*'], limit: '8mb' }), async (req, res) => {
  const event = await guard(req);
  res.json(await findMe(event, req.body, base(event)));
});

r.get('/:token/photos/:pid/download', async (req, res) => {
  const event = await guard(req);
  await downloadOne(res, event, await eventPhoto(event, req.params.pid, ['image', 'video']), downloadMode(event, { guestLink: true }));
});

r.get('/:token/download', async (req, res) => {
  const event = await guard(req);
  const type = String(req.query.type || 'all');
  if (type === 'raw') throw new HttpError(403, 'RAW files are only for the couple');
  await streamZip(res, event, { type, ceremony: req.query.ceremony, ids: req.query.ids, mode: downloadMode(event, { guestLink: true }), rawAllowed: false });
});

export default r;

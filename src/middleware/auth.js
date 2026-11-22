import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one } from '../db/pg.js';

export const COOKIE = 'sfs_session';

export function issueSession(res, account) {
  const token = jwt.sign({ sub: account.id, v: account.token_version }, config.jwtSecret, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export async function loadUser(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await one(
      `SELECT id, email, name, phone, role, org_id, studio_id, must_change_password, token_version
       FROM accounts WHERE id = $1`,
      [payload.sub]
    );
    if (user && user.token_version === payload.v) req.user = user;
  } catch {
    /* invalid or expired token: treat as logged out */
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
}

// Studio-side staff (anyone who manages a studio's content).
export const STUDIO_MANAGERS = ['super_admin', 'org_admin', 'studio_admin', 'staff'];

/** Can this user manage the given studio row? */
export function canManageStudio(user, studio) {
  if (!user || !studio) return false;
  if (user.role === 'super_admin') return true;
  if (user.role === 'org_admin') return user.org_id === studio.org_id;
  if (user.role === 'studio_admin' || user.role === 'staff') return user.studio_id === studio.id;
  return false;
}

/** Load studio by id and check management rights; throws 404/403 via res. */
export async function studioGuard(req, res, studioId) {
  const studio = await one('SELECT * FROM studios WHERE id = $1', [studioId]);
  if (!studio) {
    res.status(404).json({ error: 'Studio not found' });
    return null;
  }
  if (!canManageStudio(req.user, studio)) {
    res.status(403).json({ error: 'Not allowed' });
    return null;
  }
  return studio;
}

/** Load event + studio and check management rights. */
export async function eventGuard(req, res, eventId) {
  const event = await one('SELECT * FROM events WHERE id = $1', [eventId]);
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  const studio = await studioGuard(req, res, event.studio_id);
  if (!studio) return null;
  return { event, studio };
}

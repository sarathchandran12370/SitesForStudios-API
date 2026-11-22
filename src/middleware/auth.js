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
      `SELECT a.id, a.email, a.name, a.phone, a.role, a.org_id, a.studio_id, a.must_change_password, a.token_version,
              o.status AS org_status
       FROM accounts a LEFT JOIN organizations o ON o.id = a.org_id WHERE a.id = $1`,
      [payload.sub]
    );
    if (user && user.token_version === payload.v) req.user = user;
  } catch {
    /* invalid or expired token: treat as logged out */
  }
  next();
}

// Organizations that stopped paying or were closed lose access to dashboards, the client portal
// and their websites. past_due and trial still work (the dashboard shows a banner).
export const BLOCKED_ORG_STATUSES = ['suspended', 'cancelled'];

export function isOrgBlocked(status) {
  return BLOCKED_ORG_STATUSES.includes(status);
}

export const ORG_BLOCKED_MESSAGE = {
  suspended: 'This account is suspended. Please contact SitesForStudios support.',
  cancelled: 'This account has been closed. Please contact SitesForStudios support.',
};

/**
 * Refuses every request from a user whose organization is suspended or cancelled, except
 * reading who they are and logging out (so the app can show the reason). Super Admin is never blocked.
 */
export function blockInactiveOrg(req, res, next) {
  const u = req.user;
  if (!u || u.role === 'super_admin' || !isOrgBlocked(u.org_status)) return next();
  if (req.path === '/api/auth/me' || req.path === '/api/auth/logout') return next();
  res.status(403).json({ error: ORG_BLOCKED_MESSAGE[u.org_status], code: 'ORG_BLOCKED', orgStatus: u.org_status });
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

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, q } from '../db/pg.js';
import { issueSession, clearSession, requireAuth, isOrgBlocked, ORG_BLOCKED_MESSAGE } from '../middleware/auth.js';
import { parse, checkPassword, hashPassword, HttpError, publicAccount } from '../util.js';
import { orgMode } from '../services/onboarding.js';
import { config } from '../config.js';

const r = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 * config.rateLimitScale, standardHeaders: true, legacyHeaders: false });

r.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const acct = await one('SELECT * FROM accounts WHERE lower(email) = lower($1)', [email]);
  if (!acct || !(await checkPassword(password, acct.password_hash))) throw new HttpError(401, 'Wrong email or password');
  if (acct.role !== 'super_admin' && acct.org_id) {
    const org = await one('SELECT status FROM organizations WHERE id = $1', [acct.org_id]);
    if (isOrgBlocked(org?.status)) throw new HttpError(403, ORG_BLOCKED_MESSAGE[org.status]);
  }
  issueSession(res, acct);
  res.json({ user: await meFor(acct.id) });
});

r.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get('/me', async (req, res) => {
  res.json({ user: req.user ? await meFor(req.user.id) : null });
});

// Users can change their own password. There is deliberately no self-service "forgot password":
// the studio resets it (see studios routes).
r.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = parse(
    z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8, 'must be at least 8 characters').max(128),
    }),
    req.body
  );
  const acct = await one('SELECT * FROM accounts WHERE id = $1', [req.user.id]);
  if (!(await checkPassword(currentPassword, acct.password_hash))) throw new HttpError(400, 'Current password is wrong');
  if (currentPassword === newPassword) throw new HttpError(400, 'New password must be different');
  const [updated] = await q(
    `UPDATE accounts SET password_hash = $2, must_change_password = false, token_version = token_version + 1
     WHERE id = $1 RETURNING *`,
    [acct.id, await hashPassword(newPassword)]
  );
  issueSession(res, updated); // other devices are logged out, this one stays in
  res.json({ ok: true });
});

// Accept the current Terms of Service and Privacy Policy (shown once to anyone who hasn't).
r.post('/accept-terms', requireAuth, async (req, res) => {
  const { version } = parse(z.object({ version: z.string() }), req.body);
  if (version !== config.termsVersion) throw new HttpError(409, 'The terms have changed. Please reload and read the latest version.');
  await q('UPDATE accounts SET terms_version = $2, terms_accepted_at = now() WHERE id = $1', [req.user.id, version]);
  res.json({ ok: true, version });
});

async function meFor(id) {
  const a = await one(
    `SELECT a.*, o.name AS org_name, o.plan_id, o.status AS org_status, o.trial_ends_at, o.expired_at,
            s.name AS studio_name, s.slug AS studio_slug
     FROM accounts a
     LEFT JOIN organizations o ON o.id = a.org_id
     LEFT JOIN studios s ON s.id = a.studio_id
     WHERE a.id = $1`,
    [id]
  );
  if (!a) return null;
  // Owners of a one-studio organization only see their Studio dashboard ("single" mode).
  if (a.role === 'org_admin') {
    const { mode, homeStudioId } = await orgMode(a.org_id);
    a.org_mode = mode;
    a.home_studio_id = homeStudioId;
  }
  a.terms_current_version = config.termsVersion;
  if (a.expired_at) a.grace_ends_at = new Date(new Date(a.expired_at).getTime() + config.signup.graceDays * 86400000);
  return publicAccount(a);
}

export default r;

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, q } from '../db/pg.js';
import { issueSession, clearSession, requireAuth, isOrgBlocked, ORG_BLOCKED_MESSAGE } from '../middleware/auth.js';
import { parse, checkPassword, hashPassword, HttpError, publicAccount } from '../util.js';

const r = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

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

async function meFor(id) {
  const a = await one(
    `SELECT a.*, o.name AS org_name, o.plan_id, o.status AS org_status, s.name AS studio_name, s.slug AS studio_slug
     FROM accounts a
     LEFT JOIN organizations o ON o.id = a.org_id
     LEFT JOIN studios s ON s.id = a.studio_id
     WHERE a.id = $1`,
    [id]
  );
  return publicAccount(a);
}

export default r;

// Self sign-up for studios and organizations: details -> 6-digit email code -> account on a free trial.
// Clients (couples, guests) still cannot sign up; studios create them.
import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { one, q } from '../db/pg.js';
import { config } from '../config.js';
import { issueSession } from '../middleware/auth.js';
import { parse, hashPassword, HttpError, publicAccount } from '../util.js';
import { notify } from '../services/notify.js';
import { createOrganizationWithStudio } from '../services/onboarding.js';

const r = Router();
const CODE_MINUTES = 10;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

const startLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 * config.rateLimitScale, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 * config.rateLimitScale, standardHeaders: true, legacyHeaders: false });

const hashCode = (id, code) => crypto.createHmac('sha256', config.jwtSecret).update(`${id}:${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const devCode = (code) => (!config.isProd && config.notifications.emailProvider === 'log' ? { devCode: code } : {});

async function sendCode(request, code) {
  await notify({
    kind: 'signup_code',
    email: {
      to: request.email,
      subject: `${code} is your SitesForStudios code`,
      html: `<p>Your verification code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>It expires in ${CODE_MINUTES} minutes. If you did not try to sign up, ignore this email.</p>`,
      text: `Your SitesForStudios verification code is ${code}. It expires in ${CODE_MINUTES} minutes.`,
    },
  });
}

r.get('/options', async (_req, res) => {
  const plans = await q('SELECT id, name, price_monthly_inr, max_studios, storage_gb, client_galleries FROM plans ORDER BY price_monthly_inr');
  res.json({ enabled: config.signup.enabled, trialDays: config.signup.trialDays, plans });
});

const startSchema = z.object({
  type: z.enum(['studio', 'organization']),
  studioName: z.string().trim().min(2).max(120),
  orgName: z.string().trim().min(2).max(120).optional(),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(6).max(20),
  password: z.string().min(8, 'must be at least 8 characters').max(128),
  planId: z.enum(['website', 'starter', 'pro', 'organization']),
  website: z.string().max(0).optional(), // honeypot
  acceptTerms: z.literal(true, { message: 'please accept the Terms of Service and Privacy Policy' }),
});

r.post('/start', startLimiter, async (req, res) => {
  if (!config.signup.enabled) throw new HttpError(403, 'Sign-up is closed. Please contact us for an account.');
  const b = parse(startSchema, req.body);
  if (b.type === 'organization' && !b.orgName) throw new HttpError(400, 'orgName: enter your organization name');
  if (b.type === 'organization' && b.planId !== 'organization') throw new HttpError(400, 'Organizations use the Organization plan');
  if (b.type === 'studio' && b.planId === 'organization') throw new HttpError(400, 'Choose "I run several studios" for the Organization plan');
  if (await one('SELECT 1 FROM accounts WHERE lower(email) = $1', [b.email])) throw new HttpError(409, 'An account with this email already exists. Log in instead.');

  await q(`DELETE FROM signup_requests WHERE lower(email) = $1 OR expires_at < now() - interval '1 day'`, [b.email]);
  const code = newCode();
  const data = {
    type: b.type,
    studioName: b.studioName,
    orgName: b.type === 'organization' ? b.orgName : b.studioName,
    name: b.name,
    phone: b.phone,
    planId: b.planId,
    passwordHash: await hashPassword(b.password),
    termsVersion: config.termsVersion,
  };
  const row = await one(
    `INSERT INTO signup_requests(email, data, code_hash, expires_at) VALUES ($1, $2, 'pending', now() + make_interval(mins => $3)) RETURNING id`,
    [b.email, JSON.stringify(data), CODE_MINUTES]
  );
  await q('UPDATE signup_requests SET code_hash = $2 WHERE id = $1', [row.id, hashCode(row.id, code)]);
  await sendCode({ email: b.email }, code);
  res.status(201).json({ requestId: row.id, email: b.email, expiresInMinutes: CODE_MINUTES, ...devCode(code) });
});

r.post('/resend', startLimiter, async (req, res) => {
  const { requestId } = parse(z.object({ requestId: z.string().uuid() }), req.body);
  const reqRow = await one('SELECT * FROM signup_requests WHERE id = $1', [requestId]);
  if (!reqRow) throw new HttpError(404, 'This sign-up has expired. Please start again.');
  const wait = RESEND_SECONDS - Math.floor((Date.now() - new Date(reqRow.last_sent_at)) / 1000);
  if (wait > 0) throw new HttpError(429, `Please wait ${wait} seconds before asking for a new code`);
  const code = newCode();
  await q(
    `UPDATE signup_requests SET code_hash = $2, attempts = 0, last_sent_at = now(), expires_at = now() + make_interval(mins => $3) WHERE id = $1`,
    [requestId, hashCode(requestId, code), CODE_MINUTES]
  );
  await sendCode(reqRow, code);
  res.json({ ok: true, ...devCode(code) });
});

r.post('/verify', verifyLimiter, async (req, res) => {
  const { requestId, code } = parse(z.object({ requestId: z.string().uuid(), code: z.string().trim().regex(/^\d{6}$/, 'enter the 6-digit code') }), req.body);
  const reqRow = await one('SELECT * FROM signup_requests WHERE id = $1', [requestId]);
  if (!reqRow || new Date(reqRow.expires_at) < new Date()) throw new HttpError(410, 'This code has expired. Ask for a new one.');
  if (reqRow.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
  const expected = Buffer.from(reqRow.code_hash);
  const given = Buffer.from(hashCode(requestId, code));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    await q('UPDATE signup_requests SET attempts = attempts + 1 WHERE id = $1', [requestId]);
    throw new HttpError(400, `That code is not right. ${MAX_ATTEMPTS - reqRow.attempts - 1} attempts left.`);
  }
  const d = reqRow.data;
  const { org, studio, account } = await createOrganizationWithStudio({
    orgName: d.orgName,
    studioName: d.studioName,
    planId: d.planId,
    owner: { name: d.name, email: reqRow.email, phone: d.phone, passwordHash: d.passwordHash },
    source: 'self',
  });
  // Consent was given at sign-up (the checkbox); record which version and when.
  await q('UPDATE accounts SET terms_version = $2, terms_accepted_at = now() WHERE id = $1', [account.id, d.termsVersion || config.termsVersion]);
  await q('DELETE FROM signup_requests WHERE id = $1', [requestId]);
  issueSession(res, account);
  res.status(201).json({ user: publicAccount(account), orgId: org.id, studioId: studio.id, trialEndsAt: org.trial_ends_at });
});

export default r;

// Studio (partner) management: website template + customization, custom domain,
// staff and client accounts, enquiries.
import { Router } from 'express';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import { q, one } from '../db/pg.js';
import { requireRole, studioGuard, STUDIO_MANAGERS, canManageStudio } from '../middleware/auth.js';
import { SiteConfig, Photo } from '../models/index.js';
import { storage } from '../services/storage.js';
import { config } from '../config.js';
import { parse, tempPassword, hashPassword, HttpError, publicAccount } from '../util.js';
import { notify, studioBrand } from '../services/notify.js';
import { inviteMessage, passwordResetMessage } from '../services/messages.js';
import { studioChecklist } from '../services/onboarding.js';

const r = Router();
r.use(requireRole(...STUDIO_MANAGERS));

r.get('/templates', async (_req, res) => res.json(await q('SELECT * FROM templates ORDER BY tier, id')));

r.get('/mine', async (req, res) => {
  const u = req.user;
  let rows;
  if (u.role === 'super_admin') rows = await q('SELECT * FROM studios ORDER BY created_at');
  else if (u.role === 'org_admin') rows = await q('SELECT * FROM studios WHERE org_id = $1 ORDER BY created_at', [u.org_id]);
  else rows = await q('SELECT * FROM studios WHERE id = $1', [u.studio_id]);
  res.json(rows);
});

r.get('/:id', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  const plan = await one('SELECT p.* FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [studio.org_id]);
  res.json({ ...studio, plan, cnameTarget: config.sitesCnameTarget });
});

// Getting-started checklist for this studio.
r.get('/:id/onboarding', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  res.json(await studioChecklist(studio, req.user));
});

// ---------- Website ----------

r.get('/:id/site', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  const site = (await SiteConfig.findOne({ studioId: studio.id }).lean()) || (await SiteConfig.create({ studioId: studio.id })).toObject();
  const logoUrl = site.logoKey ? await storage.url(site.logoKey, { expiresIn: 3600 }) : null;
  // Photos the studio can pick as hero images: highlights from its events.
  const heroChoices = await Photo.find({ studioId: studio.id, kind: 'image', status: 'ready', isHighlight: true })
    .sort({ createdAt: -1 })
    .limit(60)
    .lean();
  res.json({
    site: { ...site, logoUrl },
    heroChoices: await Promise.all(heroChoices.map(async (p) => ({ id: String(p._id), thumb: await storage.url(p.variants.thumb, { expiresIn: 3600 }) }))),
  });
});

const SECTION_IDS = ['about', 'portfolio', 'packages', 'testimonials', 'faq', 'contact'];
const siteSchema = z.object({
  templateId: z.string().optional(),
  theme: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/), fontPair: z.enum(['template', 'classic', 'modern', 'editorial']) }).optional(),
  tagline: z.string().max(140).optional(),
  about: z.string().max(3000).optional(),
  heroPhotoIds: z.array(z.string()).max(6).optional(),
  sections: z.array(z.object({ id: z.enum(SECTION_IDS), enabled: z.boolean() })).optional(),
  packages: z.array(z.object({ name: z.string().max(60), price: z.string().max(40), features: z.array(z.string().max(120)).max(10) })).max(6).optional(),
  testimonials: z.array(z.object({ quote: z.string().max(600), author: z.string().max(80) })).max(8).optional(),
  faq: z.array(z.object({ q: z.string().max(200), a: z.string().max(1000) })).max(12).optional(),
  contact: z
    .object({
      email: z.string().max(120).optional(),
      phone: z.string().max(20).optional(),
      whatsapp: z.string().max(20).optional(),
      city: z.string().max(80).optional(),
      instagram: z.string().max(120).optional(),
      youtube: z.string().max(200).optional(),
    })
    .optional(),
  seo: z.object({ title: z.string().max(70).optional(), description: z.string().max(160).optional() }).optional(),
  logoKey: z.string().optional().nullable(),
  publish: z.boolean().optional(),
});

r.put('/:id/site', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  const body = parse(siteSchema, req.body);
  if (body.templateId) {
    const tpl = await one('SELECT * FROM templates WHERE id = $1', [body.templateId]);
    if (!tpl) throw new HttpError(400, 'Unknown template');
    const plan = await one('SELECT p.* FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [studio.org_id]);
    if (tpl.tier === 'premium' && !plan.premium_templates) throw new HttpError(402, 'This template needs the Pro plan or higher');
    await q('UPDATE studios SET template_id = $2 WHERE id = $1', [studio.id, body.templateId]);
  }
  if (body.logoKey && !body.logoKey.startsWith(`studios/${studio.id}/`)) throw new HttpError(400, 'Invalid logo');
  const { publish, ...fields } = body;
  const site = await SiteConfig.findOneAndUpdate({ studioId: studio.id }, { $set: fields }, { new: true, upsert: true });
  if (publish) await q('UPDATE studios SET published_at = coalesce(published_at, now()) WHERE id = $1', [studio.id]);
  res.json(site);
});

r.post('/:id/logo-upload', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  const { contentType } = parse(z.object({ contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']) }), req.body);
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[contentType];
  const key = `studios/${studio.id}/brand/logo-${Date.now()}.${ext}`;
  res.json({ key, upload: await storage.uploadUrl(key, { contentType }) });
});

// ---------- Custom domain ----------

r.put('/:id/domain', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  const { domain } = parse(
    z.object({ domain: z.string().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, 'enter a domain like www.yourstudio.in').nullable() }),
    req.body
  );
  if (!domain) {
    await q(`UPDATE studios SET custom_domain = NULL, domain_status = 'none', domain_verify_token = NULL WHERE id = $1`, [studio.id]);
    return res.json({ ok: true });
  }
  if (domain.endsWith('sitesforstudios.com')) throw new HttpError(400, 'Use your own domain');
  const taken = await one('SELECT id FROM studios WHERE custom_domain = $1 AND id <> $2', [domain, studio.id]);
  if (taken) throw new HttpError(409, 'This domain is already connected to another studio');
  const token = crypto.randomBytes(12).toString('hex');
  await q(`UPDATE studios SET custom_domain = $2, domain_status = 'pending', domain_verify_token = $3 WHERE id = $1`, [studio.id, domain, token]);
  res.json(dnsInstructions(domain, token));
});

r.get('/:id/domain', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  if (!studio.custom_domain) return res.json({ status: 'none' });
  res.json({ status: studio.domain_status, ...dnsInstructions(studio.custom_domain, studio.domain_verify_token) });
});

// Checks the partner's DNS. In production a background job calls the same check and then
// requests an ACM certificate + attaches the domain to CloudFront when verified.
r.post('/:id/domain/verify', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  if (!studio.custom_domain) throw new HttpError(400, 'No domain set');
  const d = studio.custom_domain;
  const checks = { txt: false, cname: false };
  try {
    const txt = (await dns.resolveTxt(`_sfs-verify.${d}`)).flat();
    checks.txt = txt.includes(`sfs-verify=${studio.domain_verify_token}`);
  } catch {}
  try {
    const cname = await dns.resolveCname(d);
    checks.cname = cname.some((c) => c.replace(/\.$/, '') === config.sitesCnameTarget);
  } catch {}
  const status = checks.txt && checks.cname ? 'verified' : 'pending';
  await q('UPDATE studios SET domain_status = $2 WHERE id = $1', [studio.id, status]);
  res.json({ status, checks, ...dnsInstructions(d, studio.domain_verify_token) });
});

function dnsInstructions(domain, token) {
  return {
    domain,
    records: [
      { type: 'CNAME', host: domain, value: config.sitesCnameTarget },
      { type: 'TXT', host: `_sfs-verify.${domain}`, value: `sfs-verify=${token}` },
    ],
    note: domain.split('.').length === 2 ? 'Root domains usually cannot use a CNAME. Use www.' + domain + ' and redirect the root to it at your registrar.' : undefined,
  };
}

// ---------- Accounts: staff and clients ----------

r.get('/:id/accounts', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  const role = req.query.role === 'staff' ? ['studio_admin', 'staff'] : ['client'];
  const rows = await q(
    `SELECT a.id, a.email, a.name, a.phone, a.role, a.must_change_password, a.created_at,
       coalesce(json_agg(json_build_object('eventId', e.id, 'title', e.title, 'accessLevel', ea.access_level))
         FILTER (WHERE e.id IS NOT NULL), '[]') AS events
     FROM accounts a
     LEFT JOIN event_access ea ON ea.account_id = a.id
     LEFT JOIN events e ON e.id = ea.event_id
     WHERE a.studio_id = $1 AND a.role = ANY($2)
     GROUP BY a.id ORDER BY a.created_at DESC`,
    [studio.id, role]
  );
  res.json(rows);
});

// Studios create client (and staff) accounts. There is no public sign-up.
r.post('/:id/accounts', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  const body = parse(
    z.object({
      name: z.string().min(2).max(120),
      email: z.string().email(),
      phone: z.string().max(20).optional(),
      role: z.enum(['client', 'staff']).default('client'),
      events: z.array(z.object({ eventId: z.string().uuid(), accessLevel: z.enum(['primary', 'guest']).default('primary') })).default([]),
      sendInvite: z.boolean().default(true),
    }),
    req.body
  );
  const accountPlan = await one('SELECT p.* FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [studio.org_id]);
  if (body.role === 'client' && !accountPlan.client_galleries) throw new HttpError(402, 'Client galleries are not included in the Website plan. Upgrade to Starter or above to add clients.');
  if (body.role === 'staff') {
    if (!['super_admin', 'org_admin', 'studio_admin'].includes(req.user.role)) throw new HttpError(403, 'Only studio admins can add staff');
    const plan = await one('SELECT p.staff_seats FROM plans p JOIN organizations o ON o.plan_id = p.id WHERE o.id = $1', [studio.org_id]);
    const { count } = await one(`SELECT count(*)::int AS count FROM accounts WHERE studio_id = $1 AND role IN ('studio_admin','staff')`, [studio.id]);
    if (count >= plan.staff_seats) throw new HttpError(402, `Your plan includes ${plan.staff_seats} staff seat(s)`);
  }
  if (await one('SELECT 1 FROM accounts WHERE lower(email)=lower($1)', [body.email])) throw new HttpError(409, 'An account with this email already exists');
  const password = tempPassword();
  const acct = await one(
    `INSERT INTO accounts(email, name, phone, password_hash, role, org_id, studio_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [body.email, body.name, body.phone || null, await hashPassword(password), body.role, studio.org_id, studio.id, req.user.id]
  );
  for (const e of body.events) {
    const ev = await one('SELECT id FROM events WHERE id = $1 AND studio_id = $2', [e.eventId, studio.id]);
    if (ev) await q('INSERT INTO event_access(event_id, account_id, access_level) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ev.id, acct.id, e.accessLevel]);
  }
  let invited = null;
  if (body.sendInvite) {
    const msg = inviteMessage({ brand: await studioBrand(studio.id), name: acct.name, email: acct.email, password, role: acct.role });
    invited = await notify({ orgId: studio.org_id, kind: 'invite', email: { to: acct.email, ...msg.email }, whatsapp: acct.phone ? { to: acct.phone, ...msg.whatsapp } : undefined });
  }
  res.status(201).json({ account: publicAccount(acct), temporaryPassword: password, loginUrl: `${config.appUrl}/login`, invited: summarize(invited) });
});

async function accountGuard(req, res) {
  const acct = await one('SELECT * FROM accounts WHERE id = $1', [req.params.accountId]);
  if (!acct || !acct.studio_id) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  const studio = await one('SELECT * FROM studios WHERE id = $1', [acct.studio_id]);
  if (!canManageStudio(req.user, studio) || (acct.role !== 'client' && req.user.role === 'staff')) {
    res.status(403).json({ error: 'Not allowed' });
    return null;
  }
  return acct;
}

// Studio resets a user's password: issues a new temporary password and logs the user out everywhere.
r.post('/accounts/:accountId/reset-password', async (req, res) => {
  const acct = await accountGuard(req, res);
  if (!acct) return;
  const { sendInvite } = parse(z.object({ sendInvite: z.boolean().default(true) }), req.body || {});
  const password = tempPassword();
  await q(
    'UPDATE accounts SET password_hash = $2, must_change_password = true, token_version = token_version + 1 WHERE id = $1',
    [acct.id, await hashPassword(password)]
  );
  let invited = null;
  if (sendInvite) {
    const msg = passwordResetMessage({ brand: await studioBrand(acct.studio_id), name: acct.name, email: acct.email, password });
    invited = await notify({ orgId: acct.org_id, kind: 'password_reset', email: { to: acct.email, ...msg.email }, whatsapp: acct.phone ? { to: acct.phone, ...msg.whatsapp } : undefined });
  }
  res.json({ email: acct.email, temporaryPassword: password, invited: summarize(invited) });
});

r.put('/accounts/:accountId/events', async (req, res) => {
  const acct = await accountGuard(req, res);
  if (!acct) return;
  const { events } = parse(
    z.object({ events: z.array(z.object({ eventId: z.string().uuid(), accessLevel: z.enum(['primary', 'guest']) })) }),
    req.body
  );
  await q('DELETE FROM event_access WHERE account_id = $1', [acct.id]);
  for (const e of events) {
    const ev = await one('SELECT id FROM events WHERE id = $1 AND studio_id = $2', [e.eventId, acct.studio_id]);
    if (ev) await q('INSERT INTO event_access(event_id, account_id, access_level) VALUES ($1,$2,$3)', [ev.id, acct.id, e.accessLevel]);
  }
  res.json({ ok: true });
});

r.delete('/accounts/:accountId', async (req, res) => {
  const acct = await accountGuard(req, res);
  if (!acct) return;
  if (acct.id === req.user.id) throw new HttpError(400, 'You cannot delete yourself');
  await q('DELETE FROM accounts WHERE id = $1', [acct.id]);
  res.json({ ok: true });
});

// ---------- Enquiries ----------

r.get('/:id/enquiries', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.id);
  if (!studio) return;
  res.json(await q('SELECT * FROM enquiries WHERE studio_id = $1 ORDER BY created_at DESC LIMIT 500', [studio.id]));
});

r.patch('/enquiries/:enquiryId', async (req, res) => {
  const enq = await one('SELECT * FROM enquiries WHERE id = $1', [req.params.enquiryId]);
  if (!enq) throw new HttpError(404, 'Enquiry not found');
  const studio = await studioGuard(req, res, enq.studio_id);
  if (!studio) return;
  const { status } = parse(z.object({ status: z.enum(['new', 'contacted', 'quoted', 'booked', 'lost']) }), req.body);
  res.json(await one('UPDATE enquiries SET status = $2 WHERE id = $1 RETURNING *', [enq.id, status]));
});

/** {email:'logged', whatsapp:'skipped'} style summary of a notify() result for the UI. */
function summarize(r) {
  if (!r) return null;
  return { email: r.email?.status || null, whatsapp: r.whatsapp?.status || null };
}

export default r;

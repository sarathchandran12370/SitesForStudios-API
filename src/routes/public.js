// Public: studio websites (by slug or custom domain), enquiry form, client invoice links, signed media and local uploads.
import { Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { q, one } from '../db/pg.js';
import { SiteConfig, Photo } from '../models/index.js';
import { storage, localStorage } from '../services/storage.js';
import { config } from '../config.js';
import { parse, HttpError } from '../util.js';
import { BLOCKED_ORG_STATUSES } from '../middleware/auth.js';
import { notify, studioBrand, studioRecipients } from '../services/notify.js';
import { enquiryMessage } from '../services/messages.js';
import { present, paymentsFor } from '../services/clientInvoices.js';
import { dateTaken } from '../services/bookings.js';
import { renderClientInvoiceHtml } from '../services/clientInvoiceHtml.js';

const r = Router();

async function siteData(studio) {
  const site = (await SiteConfig.findOne({ studioId: studio.id }).lean()) || {};
  const urlFor = (k) => (k ? storage.url(k, { expiresIn: 6 * 3600 }) : null);
  // Portfolio: highlights from events the studio marked "show in portfolio".
  const events = await q(
    `SELECT id, title, event_date, venue FROM events WHERE studio_id = $1 AND show_in_portfolio ORDER BY event_date DESC NULLS LAST LIMIT 12`,
    [studio.id]
  );
  const portfolio = [];
  for (const e of events) {
    const photos = await Photo.find({ eventId: e.id, kind: 'image', status: 'ready', isHighlight: true }).sort({ filename: 1 }).limit(12).lean();
    if (!photos.length) continue;
    portfolio.push({
      id: e.id,
      title: e.title,
      venue: e.venue,
      photos: await Promise.all(photos.map(async (p) => ({ id: String(p._id), web: await urlFor(p.variants.web), thumb: await urlFor(p.variants.thumb), w: p.width, h: p.height }))),
    });
  }
  let hero = [];
  if (site.heroPhotoIds?.length) {
    const hp = await Photo.find({ _id: { $in: site.heroPhotoIds }, studioId: studio.id, status: 'ready' }).lean();
    hero = await Promise.all(hp.map((p) => urlFor(p.variants.web)));
  }
  if (!hero.length) hero = portfolio.flatMap((p) => p.photos).slice(0, 3).map((p) => p.web);
  return {
    studio: { id: studio.id, name: studio.name, slug: studio.slug, published: !!studio.published_at },
    templateId: studio.template_id,
    site: { ...site, _id: undefined, logoUrl: await urlFor(site.logoKey) },
    hero,
    portfolio,
  };
}

r.get('/sites/:slug', async (req, res) => {
  const studio = await one(
    `SELECT s.* FROM studios s JOIN organizations o ON o.id = s.org_id
     WHERE s.slug = $1 AND o.status <> ALL($2)`,
    [req.params.slug, BLOCKED_ORG_STATUSES]
  );
  if (!studio) throw new HttpError(404, 'Site not found');
  // Always revalidate (ETag -> 304 when unchanged) so template and content edits show immediately.
  res.set('Cache-Control', 'no-cache');
  res.json(await siteData(studio));
});

// Custom domains: the web app calls this with window.location.host.
r.get('/sites-by-host/:host', async (req, res) => {
  const host = req.params.host.toLowerCase().replace(/:\d+$/, '');
  const studio = await one(
    `SELECT s.* FROM studios s JOIN organizations o ON o.id = s.org_id
     WHERE s.custom_domain = $1 AND s.domain_status IN ('verified','live') AND o.status <> ALL($2)`,
    [host, BLOCKED_ORG_STATUSES]
  );
  if (!studio) throw new HttpError(404, 'Site not found');
  res.set('Cache-Control', 'no-cache');
  res.json(await siteData(studio));
});

const enquiryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

r.post('/sites/:slug/enquiries', enquiryLimiter, express.json({ limit: '32kb' }), async (req, res) => {
  const studio = await one(
    `SELECT s.id, s.name, s.org_id FROM studios s JOIN organizations o ON o.id = s.org_id
     WHERE s.slug = $1 AND o.status <> ALL($2)`,
    [req.params.slug, BLOCKED_ORG_STATUSES]
  );
  if (!studio) throw new HttpError(404, 'Site not found');
  const b = parse(
    z.object({
      name: z.string().min(2).max(120),
      phone: z.string().min(6).max(20),
      email: z.string().email().optional().or(z.literal('')),
      eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
      city: z.string().max(80).optional(),
      eventType: z.string().max(60).optional(),
      budget: z.string().max(60).optional(),
      message: z.string().max(2000).optional(),
      website: z.string().max(0).optional(), // honeypot: bots fill this
    }),
    req.body
  );
  let dateAvailable = null;
  if (b.eventDate) {
    // Taken if a gallery event or a tentative/confirmed booking is on that date.
    const event = await one('SELECT 1 FROM events WHERE studio_id = $1 AND event_date = $2', [studio.id, b.eventDate]);
    dateAvailable = !event && !(await dateTaken(studio.id, b.eventDate));
  }
  const [enquiry] = await q(
    `INSERT INTO enquiries(studio_id, name, phone, email, event_date, city, event_type, budget, message, date_available)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [studio.id, b.name, b.phone, b.email || null, b.eventDate || null, b.city || null, b.eventType || null, b.budget || null, b.message || null, dateAvailable]
  );
  const brand = await studioBrand(studio.id);
  const to = await studioRecipients(brand);
  const msg = enquiryMessage({ brand, enquiry });
  await Promise.all([
    ...to.emails.map((email) => notify({ orgId: studio.org_id, kind: 'enquiry', email: { to: email, ...msg.email } })),
    to.whatsapp ? notify({ orgId: studio.org_id, kind: 'enquiry', whatsapp: { to: to.whatsapp, ...msg.whatsapp } }) : null,
  ]);
  res.status(201).json({ ok: true, dateAvailable });
});

// ---------- Client invoice link (sent by the studio by email; the long random token is the access check) ----------

const invoiceLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

r.get('/invoice-view/:token', invoiceLimiter, async (req, res) => {
  const inv = await one(
    `SELECT i.*, e.title AS event_title, e.event_date FROM client_invoices i LEFT JOIN events e ON e.id = i.event_id
     WHERE i.view_token = $1 AND i.status <> 'draft'`,
    [String(req.params.token)]
  );
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  if (!inv) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Invoice not found</title><p style="font-family:Arial;padding:24px">This invoice link is not valid. Please ask your photographer for a new link.</p>');
  const brand = await studioBrand(inv.studio_id);
  res.type('html').send(renderClientInvoiceHtml({ inv: present(inv), seller: inv.seller, payments: await paymentsFor(inv.id), accent: brand?.accent }));
});

// ---------- Local storage endpoints (dev only; S3 serves these in production) ----------

if (config.storageDriver === 'local') {
  r.get('/media/*key', (req, res) => {
    const key = req.params.key.join('/');
    if (!localStorage.verifyGet(key, req.query.exp, req.query.sig, req.query.dl)) return res.status(403).send('Link expired');
    if (req.query.dl) res.attachment(String(req.query.dl));
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(localStorage.localPath(key));
  });

  r.put('/uploads/*key', async (req, res) => {
    const key = req.params.key.join('/');
    if (!localStorage.verifyPut(key, req.query.exp, req.query.sig)) return res.status(403).json({ error: 'Upload link expired' });
    const out = await localStorage.putStream(key, req);
    res.json({ ok: true, bytes: out.bytes });
  });
}

export default r;

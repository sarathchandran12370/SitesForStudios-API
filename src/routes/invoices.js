// Studio role: invoices the studio team sends to its own clients, with payments recorded against them.
// Clients see sent invoices in the portal (routes/portal.js) or through the private link (routes/public.js).
import { Router } from 'express';
import { z } from 'zod';
import { q, one } from '../db/pg.js';
import { requireRole, studioGuard, STUDIO_MANAGERS } from '../middleware/auth.js';
import { parse, HttpError } from '../util.js';
import { GST_STATES, isValidGstin } from '../services/gst.js';
import { notify, studioBrand } from '../services/notify.js';
import { invoiceMessage, paymentReceivedMessage } from '../services/messages.js';
import {
  GST_RATES, PAYMENT_METHODS, invoiceSettings, calcTotals, newViewToken, issueInvoice, refreshPaid,
  present, paymentsFor, invoiceViewUrl, sellerSnapshot,
} from '../services/clientInvoices.js';
import { renderClientInvoiceHtml } from '../services/clientInvoiceHtml.js';

const r = Router();
r.use(requireRole(...STUDIO_MANAGERS));

const SETTINGS_EDITORS = ['super_admin', 'org_admin', 'studio_admin'];
const paise = (rupees) => Math.round(Number(rupees) * 100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use a date like 2026-12-20');
const stateCode = z.string().refine((s) => !!GST_STATES[s], 'unknown state');
const gstin = z.string().toUpperCase().refine(isValidGstin, 'enter a valid 15-character GSTIN');
const optional = (s) => s.optional().nullable().or(z.literal('').transform(() => null));

const loadInvoice = (id) =>
  one(`SELECT i.*, e.title AS event_title, e.event_date FROM client_invoices i LEFT JOIN events e ON e.id = i.event_id WHERE i.id = $1`, [id]);

async function invoiceGuard(req, res) {
  const inv = await loadInvoice(req.params.id);
  if (!inv) {
    res.status(404).json({ error: 'Invoice not found' });
    return null;
  }
  const studio = await studioGuard(req, res, inv.studio_id);
  if (!studio) return null;
  return { inv, studio };
}

async function full(inv) {
  return { ...present(inv), payments: await paymentsFor(inv.id) };
}

// ---------- Settings: the studio's details printed on every invoice ----------

r.get('/studio/:studioId/settings', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  res.json({ ...(await invoiceSettings(studio)), canEdit: SETTINGS_EDITORS.includes(req.user.role), states: GST_STATES, gstRates: GST_RATES });
});

r.put('/studio/:studioId/settings', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  if (!SETTINGS_EDITORS.includes(req.user.role)) throw new HttpError(403, 'Only studio admins can change invoice settings');
  const b = parse(
    z.object({
      legalName: z.string().min(2).max(120),
      gstin: optional(gstin),
      address: z.string().max(400).default(''),
      stateCode: optional(stateCode),
      email: optional(z.string().email()),
      phone: z.string().max(20).default(''),
      prefix: z.string().toUpperCase().regex(/^[A-Z0-9-]{1,5}$/, 'use 1 to 5 letters or numbers').default('INV'),
      defaultSac: z.string().regex(/^\d{4,8}$/, 'SAC is 4 to 8 digits').default('998383'),
      defaultGstRate: z.number().refine((n) => GST_RATES.includes(n), 'choose 0, 5, 12, 18 or 28').default(18),
      dueDays: z.number().int().min(0).max(90).default(7),
      bankDetails: z.string().max(500).default(''),
      upiId: optional(z.string().regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, 'enter a UPI ID like studio@okhdfcbank')),
      terms: z.string().max(1000).default(''),
    }),
    req.body
  );
  const state = b.gstin ? b.gstin.slice(0, 2) : b.stateCode;
  await q(
    `INSERT INTO studio_invoice_settings(studio_id, legal_name, gstin, address, state_code, email, phone, prefix, default_sac, default_gst_rate, due_days, bank_details, upi_id, terms, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (studio_id) DO UPDATE SET legal_name=$2, gstin=$3, address=$4, state_code=$5, email=$6, phone=$7, prefix=$8,
       default_sac=$9, default_gst_rate=$10, due_days=$11, bank_details=$12, upi_id=$13, terms=$14, updated_at=now()`,
    [studio.id, b.legalName, b.gstin, b.address, state, b.email, b.phone, b.prefix, b.defaultSac, b.defaultGstRate, b.dueDays, b.bankDetails, b.upiId, b.terms]
  );
  res.json({ ...(await invoiceSettings(studio)), canEdit: true, states: GST_STATES, gstRates: GST_RATES });
});

// ---------- List ----------

r.get('/studio/:studioId', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  const rows = await q(
    `SELECT i.*, e.title AS event_title, e.event_date FROM client_invoices i LEFT JOIN events e ON e.id = i.event_id
     WHERE i.studio_id = $1 ORDER BY i.created_at DESC LIMIT 1000`,
    [studio.id]
  );
  const invoices = rows.map(present);
  const open = invoices.filter((i) => ['sent', 'partially_paid'].includes(i.status));
  const paidThisMonth = await one(
    `SELECT coalesce(sum(p.amount_paise), 0)::bigint AS paid FROM client_invoice_payments p JOIN client_invoices i ON i.id = p.invoice_id
     WHERE i.studio_id = $1 AND date_trunc('month', p.paid_on) = date_trunc('month', current_date)`,
    [studio.id]
  );
  res.json({
    invoices,
    summary: {
      outstanding_paise: open.reduce((s, i) => s + i.balance_paise, 0),
      overdue_paise: open.filter((i) => i.overdue).reduce((s, i) => s + i.balance_paise, 0),
      overdue_count: open.filter((i) => i.overdue).length,
      paid_this_month_paise: Number(paidThisMonth.paid),
      draft_count: invoices.filter((i) => i.status === 'draft').length,
    },
  });
});

// ---------- Create and edit drafts ----------

const invoiceSchema = z.object({
  clientAccountId: z.string().uuid().optional().nullable(),
  eventId: z.string().uuid().optional().nullable(),
  bookingId: z.string().uuid().optional().nullable(),
  customer: z.object({
    name: z.string().min(1, 'enter who the invoice is for').max(120),
    email: optional(z.string().email()),
    phone: z.string().max(20).optional().default(''),
    address: z.string().max(400).optional().default(''),
    stateCode: optional(stateCode),
    gstin: optional(gstin),
  }),
  issueDate: date.optional(),
  dueDate: optional(date),
  lines: z
    .array(
      z.object({
        description: z.string().min(1, 'describe each item').max(300),
        sac: z.string().regex(/^\d{0,8}$/).optional().default(''),
        qty: z.number().positive().max(10000),
        rate: z.number().min(0).max(10000000),
      })
    )
    .min(1, 'add at least one item')
    .max(30),
  discount: z.number().min(0).max(10000000).default(0),
  gstRate: z.number().refine((n) => GST_RATES.includes(n), 'choose 0, 5, 12, 18 or 28').optional(),
  notes: z.string().max(2000).optional().default(''),
});

async function buildInvoice(studio, body) {
  const settings = await invoiceSettings(studio);
  if (body.clientAccountId) {
    const acct = await one(`SELECT id FROM accounts WHERE id = $1 AND studio_id = $2 AND role = 'client'`, [body.clientAccountId, studio.id]);
    if (!acct) throw new HttpError(400, 'That client is not in this studio');
  }
  if (body.eventId && !(await one('SELECT id FROM events WHERE id = $1 AND studio_id = $2', [body.eventId, studio.id]))) {
    throw new HttpError(400, 'That event is not in this studio');
  }
  if (body.bookingId && !(await one('SELECT id FROM bookings WHERE id = $1 AND studio_id = $2', [body.bookingId, studio.id]))) {
    throw new HttpError(400, 'That booking is not in this studio');
  }
  const gstRate = body.gstRate ?? (settings.gstin ? settings.default_gst_rate : 0);
  if (gstRate > 0 && !settings.gstin) throw new HttpError(400, 'Add your GSTIN in invoice settings before charging GST');
  const c = body.customer;
  const placeOfSupply = c.gstin ? c.gstin.slice(0, 2) : c.stateCode || settings.state_code || null;
  const totals = calcTotals({
    lines: body.lines.map((l) => ({ ...l, sac: l.sac || settings.default_sac, rate_paise: paise(l.rate) })),
    discountPaise: paise(body.discount),
    gstRate,
    sellerState: settings.state_code,
    placeOfSupply,
  });
  const issueDate = body.issueDate || new Date().toISOString().slice(0, 10);
  let dueDate = body.dueDate;
  if (dueDate === undefined) {
    const d = new Date(`${issueDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + settings.due_days);
    dueDate = d.toISOString().slice(0, 10);
  }
  if (dueDate && dueDate < issueDate) throw new HttpError(400, 'The due date is before the invoice date');
  return {
    client_account_id: body.clientAccountId || null,
    event_id: body.eventId || null,
    booking_id: body.bookingId || null,
    customer: { name: c.name, email: c.email || null, phone: c.phone || '', address: c.address || '', state_code: c.gstin ? c.gstin.slice(0, 2) : c.stateCode || null, gstin: c.gstin || null },
    issue_date: issueDate,
    due_date: dueDate || null,
    lines: totals.lines,
    discount_paise: totals.discount_paise,
    gst_rate: gstRate,
    place_of_supply: placeOfSupply,
    taxable_paise: totals.taxable_paise,
    cgst_paise: totals.cgst_paise,
    sgst_paise: totals.sgst_paise,
    igst_paise: totals.igst_paise,
    total_paise: totals.total_paise,
    notes: body.notes || '',
  };
}

const COLS = ['client_account_id', 'event_id', 'booking_id', 'customer', 'issue_date', 'due_date', 'lines', 'discount_paise', 'gst_rate', 'place_of_supply', 'taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'total_paise', 'notes'];
const values = (b) => COLS.map((c) => (c === 'customer' || c === 'lines' ? JSON.stringify(b[c]) : b[c]));

r.post('/studio/:studioId', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  const b = await buildInvoice(studio, parse(invoiceSchema, req.body));
  const created = await one(
    `INSERT INTO client_invoices(studio_id, view_token, created_by, ${COLS.join(', ')})
     VALUES ($1, $2, $3, ${COLS.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
    [studio.id, newViewToken(), req.user.id, ...values(b)]
  );
  res.status(201).json(await full(await loadInvoice(created.id)));
});

r.get('/:id', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  res.json(await full(g.inv));
});

r.patch('/:id', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  if (g.inv.status !== 'draft') throw new HttpError(409, 'Only drafts can be edited. Cancel this invoice and create a new one to change it.');
  const b = await buildInvoice(g.studio, parse(invoiceSchema, req.body));
  await q(`UPDATE client_invoices SET ${COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [g.inv.id, ...values(b)]);
  res.json(await full(await loadInvoice(g.inv.id)));
});

r.delete('/:id', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  if (g.inv.status !== 'draft') throw new HttpError(409, 'Sent invoices cannot be deleted. Cancel it instead.');
  await q('DELETE FROM client_invoices WHERE id = $1', [g.inv.id]);
  res.json({ ok: true });
});

// ---------- Send, remind, cancel ----------

// First send gives the invoice its number. Later sends email the same invoice again (or a payment reminder).
r.post('/:id/send', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  const { email, reminder } = parse(z.object({ email: z.boolean().default(true), reminder: z.boolean().default(false) }), req.body || {});
  let inv = g.inv;
  if (inv.status === 'cancelled') throw new HttpError(409, 'This invoice is cancelled');
  if (Number(inv.total_paise) <= 0) throw new HttpError(400, 'The invoice total is zero');
  if (email && !inv.customer?.email) throw new HttpError(400, 'Add the client’s email address to send by email, or share the link instead');
  if (reminder && (inv.status === 'draft' || inv.status === 'paid')) throw new HttpError(409, 'Reminders are for sent invoices with a balance due');
  inv = await loadInvoice((await issueInvoice(inv, g.studio)).id);
  let sent = null;
  if (email) {
    const msg = invoiceMessage({ brand: await studioBrand(g.studio.id), invoice: inv, url: invoiceViewUrl(inv), reminder });
    const out = await notify({ orgId: g.studio.org_id, kind: reminder ? 'invoice_reminder' : 'client_invoice', email: { to: inv.customer.email, ...msg.email } });
    sent = out.email?.status || null;
  }
  res.json({ ...(await full(inv)), emailed: sent });
});

r.post('/:id/cancel', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  if (g.inv.status === 'draft') throw new HttpError(409, 'Delete the draft instead');
  if (g.inv.status === 'cancelled') return res.json(await full(g.inv));
  if (Number(g.inv.paid_paise) > 0) throw new HttpError(409, 'This invoice has payments recorded. Remove them before cancelling.');
  await q(`UPDATE client_invoices SET status = 'cancelled', updated_at = now() WHERE id = $1`, [g.inv.id]);
  res.json(await full(await loadInvoice(g.inv.id)));
});

// ---------- Payments (recorded by the studio: UPI, bank transfer, cash…) ----------

r.post('/:id/payments', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  const b = parse(
    z.object({
      amount: z.number().positive().max(10000000),
      method: z.enum(PAYMENT_METHODS),
      reference: z.string().max(120).optional().default(''),
      paidOn: date.optional(),
      notifyClient: z.boolean().default(true),
    }),
    req.body
  );
  if (!['sent', 'partially_paid'].includes(g.inv.status)) {
    throw new HttpError(409, g.inv.status === 'draft' ? 'Send the invoice before recording a payment' : `This invoice is ${g.inv.status.replace('_', ' ')}`);
  }
  const amount = paise(b.amount);
  const balance = Number(g.inv.total_paise) - Number(g.inv.paid_paise);
  if (amount > balance) throw new HttpError(400, `That is more than the balance due (₹${(balance / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })})`);
  const payment = await one(
    `INSERT INTO client_invoice_payments(invoice_id, amount_paise, method, reference, paid_on, recorded_by)
     VALUES ($1,$2,$3,$4,coalesce($5::date, current_date),$6) RETURNING *`,
    [g.inv.id, amount, b.method, b.reference || null, b.paidOn || null, req.user.id]
  );
  await refreshPaid(g.inv.id);
  const inv = await loadInvoice(g.inv.id);
  if (b.notifyClient && inv.customer?.email) {
    const msg = paymentReceivedMessage({ brand: await studioBrand(g.studio.id), invoice: inv, payment, url: invoiceViewUrl(inv) });
    await notify({ orgId: g.studio.org_id, kind: 'payment_receipt', email: { to: inv.customer.email, ...msg.email } });
  }
  res.status(201).json(await full(inv));
});

r.delete('/:id/payments/:paymentId', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  const removed = await one('DELETE FROM client_invoice_payments WHERE id = $1 AND invoice_id = $2 RETURNING id', [req.params.paymentId, g.inv.id]);
  if (!removed) throw new HttpError(404, 'Payment not found');
  await refreshPaid(g.inv.id);
  res.json(await full(await loadInvoice(g.inv.id)));
});

// ---------- Printable document (drafts show a preview with the current studio details) ----------

r.get('/:id/document', async (req, res) => {
  const g = await invoiceGuard(req, res);
  if (!g) return;
  const seller = g.inv.seller || sellerSnapshot(await invoiceSettings(g.studio));
  const brand = await studioBrand(g.studio.id);
  res.set('Cache-Control', 'no-store').type('html').send(renderClientInvoiceHtml({ inv: present(g.inv), seller, payments: await paymentsFor(g.inv.id), accent: brand.accent }));
});

export default r;

// Invoices a studio sends to its clients. Shared by the studio routes (create, send, record payments),
// the client portal (list) and the public invoice link (view without logging in).
import crypto from 'node:crypto';
import { config } from '../config.js';
import { q, one, tx } from '../db/pg.js';
import { SiteConfig } from '../models/index.js';
import { GST_STATES, financialYear } from './gst.js';

export const GST_RATES = [0, 5, 12, 18, 28];
export const PAYMENT_METHODS = ['upi', 'bank', 'cash', 'card', 'cheque', 'other'];

/** The studio's invoice settings, with sensible defaults taken from the studio and its website contact details. */
export async function invoiceSettings(studio) {
  const row = await one('SELECT * FROM studio_invoice_settings WHERE studio_id = $1', [studio.id]);
  const site = await SiteConfig.findOne({ studioId: studio.id }, { contact: 1 }).lean();
  const c = site?.contact || {};
  return {
    legal_name: row?.legal_name || studio.name,
    gstin: row?.gstin || null,
    address: row?.address || c.city || '',
    state_code: row?.state_code || (row?.gstin ? row.gstin.slice(0, 2) : null),
    email: row?.email || c.email || '',
    phone: row?.phone || c.phone || c.whatsapp || '',
    prefix: row?.prefix || 'INV',
    default_sac: row?.default_sac || '998383',
    default_gst_rate: row ? Number(row.default_gst_rate) : 18,
    due_days: row?.due_days ?? 7,
    bank_details: row?.bank_details || '',
    upi_id: row?.upi_id || '',
    terms: row?.terms || '',
    saved: !!row,
  };
}

/**
 * Totals for an invoice. Prices are before GST. Same state as the studio -> CGST + SGST, otherwise IGST.
 * @returns {{lines, subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise}}
 */
export function calcTotals({ lines, discountPaise = 0, gstRate = 0, sellerState, placeOfSupply }) {
  const priced = lines.map((l) => ({
    description: l.description,
    sac: l.sac || '',
    qty: Number(l.qty),
    rate_paise: Math.round(l.rate_paise),
    amount_paise: Math.round(Number(l.qty) * Math.round(l.rate_paise)),
  }));
  const subtotal = priced.reduce((s, l) => s + l.amount_paise, 0);
  const discount = Math.min(Math.max(0, Math.round(discountPaise)), subtotal);
  const taxable = subtotal - discount;
  const tax = Math.round((taxable * Number(gstRate)) / 100);
  const intra = !placeOfSupply || !sellerState || placeOfSupply === sellerState;
  const cgst = intra ? Math.round(tax / 2) : 0;
  return {
    lines: priced,
    subtotal_paise: subtotal,
    discount_paise: discount,
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: intra ? tax - cgst : 0,
    igst_paise: intra ? 0 : tax,
    total_paise: taxable + tax,
  };
}

export const newViewToken = () => crypto.randomBytes(24).toString('base64url');

/** Link the client opens to view (and print) the invoice. Served by the API, so it works on any app domain. */
export const invoiceViewUrl = (inv) => `${config.appUrl}/api/invoice-view/${inv.view_token}`;

/** Next number in the studio's series for the financial year, e.g. INV/26-27/0001 (16 characters at most, as GST requires). */
export async function nextInvoiceNumber(client, studioId, prefix, date = new Date()) {
  const fy = financialYear(date);
  const { rows } = await client.query(
    `INSERT INTO studio_invoice_sequences(studio_id, fy, last) VALUES ($1, $2, 1)
     ON CONFLICT (studio_id, fy) DO UPDATE SET last = studio_invoice_sequences.last + 1 RETURNING last`,
    [studioId, fy]
  );
  return `${prefix}/${fy.slice(2)}/${String(rows[0].last).padStart(4, '0')}`;
}

export function sellerSnapshot(settings) {
  return {
    name: settings.legal_name,
    gstin: settings.gstin,
    address: settings.address,
    stateCode: settings.state_code,
    state: GST_STATES[settings.state_code] || '',
    email: settings.email,
    phone: settings.phone,
    bankDetails: settings.bank_details,
    upiId: settings.upi_id,
    terms: settings.terms,
  };
}

/**
 * Give a draft its number and seller snapshot (first send only). Later sends keep both,
 * so a re-sent invoice is the same document.
 */
export async function issueInvoice(invoice, studio) {
  if (invoice.number) return invoice;
  const settings = await invoiceSettings(studio);
  return tx(async (client) => {
    const number = await nextInvoiceNumber(client, studio.id, settings.prefix, new Date(invoice.issue_date));
    const { rows } = await client.query(
      `UPDATE client_invoices SET number = $2, seller = $3, status = 'sent', sent_at = now(), updated_at = now()
       WHERE id = $1 AND number IS NULL RETURNING *`,
      [invoice.id, number, JSON.stringify(sellerSnapshot(settings))]
    );
    return rows[0] || (await client.query('SELECT * FROM client_invoices WHERE id = $1', [invoice.id])).rows[0];
  });
}

/** Recompute paid amount and status from the payments table. */
export async function refreshPaid(invoiceId) {
  return one(
    `UPDATE client_invoices i SET
       paid_paise = p.paid,
       status = CASE WHEN i.status IN ('draft','cancelled') THEN i.status
                     WHEN p.paid >= i.total_paise THEN 'paid'
                     WHEN p.paid > 0 THEN 'partially_paid'
                     ELSE 'sent' END,
       updated_at = now()
     FROM (SELECT coalesce(sum(amount_paise), 0)::bigint AS paid FROM client_invoice_payments WHERE invoice_id = $1) p
     WHERE i.id = $1 RETURNING i.*`,
    [invoiceId]
  );
}

export const isOverdue = (inv, today = new Date()) =>
  ['sent', 'partially_paid'].includes(inv.status) && inv.due_date && String(inv.due_date instanceof Date ? inv.due_date.toISOString() : inv.due_date).slice(0, 10) < today.toISOString().slice(0, 10);

/** Invoice as returned to the studio and client apps: money as numbers, plus balance, overdue flag and view link. */
export function present(inv) {
  const num = (v) => Number(v || 0);
  return {
    ...inv,
    discount_paise: num(inv.discount_paise),
    gst_rate: num(inv.gst_rate),
    taxable_paise: num(inv.taxable_paise),
    cgst_paise: num(inv.cgst_paise),
    sgst_paise: num(inv.sgst_paise),
    igst_paise: num(inv.igst_paise),
    total_paise: num(inv.total_paise),
    paid_paise: num(inv.paid_paise),
    balance_paise: inv.status === 'cancelled' ? 0 : num(inv.total_paise) - num(inv.paid_paise),
    overdue: isOverdue(inv),
    view_url: inv.status === 'draft' ? null : invoiceViewUrl(inv),
  };
}

export const paymentsFor = (invoiceId) =>
  q('SELECT id, amount_paise, method, reference, paid_on, created_at FROM client_invoice_payments WHERE invoice_id = $1 ORDER BY paid_on, created_at', [invoiceId]).then((rows) =>
    rows.map((p) => ({ ...p, amount_paise: Number(p.amount_paise) }))
  );

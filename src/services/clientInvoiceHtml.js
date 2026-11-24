// Printable invoice a studio sends to its client. Opened from the studio dashboard, the client portal
// or the private link in the email; "Save as PDF" through the browser's print dialog.
import { GST_STATES, amountInWords, formatInr } from './gst.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (d) => (d ? new Date(`${String(d instanceof Date ? d.toISOString() : d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const br = (s) => esc(s).replace(/\n/g, '<br>');
const qty = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2));
const METHOD = { upi: 'UPI', bank: 'Bank transfer', cash: 'Cash', card: 'Card', cheque: 'Cheque', other: 'Other' };

/**
 * @param inv     client_invoices row (presented: numbers, balance_paise)
 * @param seller  seller snapshot (inv.seller once sent; built from current settings for a draft preview)
 * @param payments recorded payments
 * @param accent  studio accent colour
 */
export function renderClientInvoiceHtml({ inv, seller, payments = [], accent = '#9a6b3c' }) {
  const s = seller || {};
  const c = inv.customer || {};
  const gst = Number(inv.gst_rate) > 0;
  const intra = Number(inv.igst_paise) === 0;
  const half = Number(inv.gst_rate) / 2;
  const title = gst ? 'Tax Invoice' : 'Invoice';
  const color = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#9a6b3c';
  const subtotal = inv.lines.reduce((sum, l) => sum + Number(l.amount_paise), 0);
  const balance = inv.status === 'cancelled' ? 0 : Number(inv.total_paise) - Number(inv.paid_paise);
  const stamp = { draft: 'Draft', paid: 'Paid', cancelled: 'Cancelled' }[inv.status];
  const pos = inv.place_of_supply ? `${GST_STATES[inv.place_of_supply] || ''} (${inv.place_of_supply})` : '';

  const lines = inv.lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${br(l.description)}</td>${gst ? `<td>${esc(l.sac)}</td>` : ''}<td class="num">${qty(l.qty)}</td><td class="num">${formatInr(l.rate_paise)}</td><td class="num">${formatInr(l.amount_paise)}</td></tr>`
    )
    .join('');
  const span = gst ? 5 : 4;
  const row = (label, value, cls = '') => `<tr class="${cls}"><td colspan="${span}">${label}</td><td class="num">${value}</td></tr>`;
  const totals = [
    Number(inv.discount_paise) > 0 ? row('Subtotal', formatInr(subtotal)) + row('Discount', `− ${formatInr(inv.discount_paise)}`) : '',
    gst ? row('Taxable value', formatInr(inv.taxable_paise)) : '',
    gst && intra ? row(`CGST @ ${half}%`, formatInr(inv.cgst_paise)) + row(`SGST @ ${half}%`, formatInr(inv.sgst_paise)) : '',
    gst && !intra ? row(`IGST @ ${Number(inv.gst_rate)}%`, formatInr(inv.igst_paise)) : '',
    row('Total', formatInr(inv.total_paise), 'total'),
    Number(inv.paid_paise) > 0 ? row('Paid', formatInr(inv.paid_paise)) : '',
    Number(inv.paid_paise) > 0 && inv.status !== 'cancelled' ? row('Balance due', formatInr(balance), 'total') : '',
  ].join('');

  const upi =
    s.upiId && balance > 0 && inv.status !== 'draft'
      ? `upi://pay?pa=${encodeURIComponent(s.upiId)}&pn=${encodeURIComponent(s.name || '')}&am=${(balance / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Invoice ${inv.number || ''}`.trim())}`
      : null;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} ${esc(inv.number || '(draft)')} · ${esc(s.name)}</title>
<style>
  :root { --ink:#1c1917; --muted:#57534e; --line:#d6d3d1; --accent:${color}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #f5f5f4; font-size: 13px; }
  .page { width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff; padding: 16mm 15mm; box-shadow: 0 2px 12px rgba(0,0,0,.08); position: relative; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 3px solid var(--accent); padding-bottom: 14px; }
  .studio { font-family: Georgia, serif; font-size: 24px; margin: 0 0 4px; }
  h1 { font-size: 18px; margin: 0 0 6px; letter-spacing: .04em; text-transform: uppercase; text-align: right; }
  .muted { color: var(--muted); }
  .meta td { padding: 2px 0 2px 16px; text-align: right; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 18px 0; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 6px; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.items th, table.items td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
  table.items th { background: #f5f5f4; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .num { text-align: right !important; white-space: nowrap; }
  .total td { font-weight: bold; font-size: 14px; background: #fafaf9; }
  .words { margin: 10px 0 20px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 18px; }
  .box { border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; }
  .pay { display: inline-block; margin-top: 8px; background: var(--accent); color: #fff; text-decoration: none; padding: 8px 14px; border-radius: 6px; font-weight: bold; }
  .stamp { position: absolute; top: 46mm; right: 18mm; transform: rotate(-12deg); border: 3px solid currentColor; border-radius: 8px; padding: 4px 14px; font-size: 26px; font-weight: bold; letter-spacing: .1em; text-transform: uppercase; opacity: .55; }
  .stamp.paid { color: #2f7a4b; } .stamp.cancelled { color: #b3261e; } .stamp.draft { color: #a8a29e; }
  .bar { width: 210mm; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; }
  .bar button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--ink); background: var(--ink); color: #fff; cursor: pointer; }
  .foot { margin-top: 28px; font-size: 11px; color: var(--muted); text-align: center; }
  @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; width: auto; min-height: 0; } .bar, .pay { display: none; } }
  @media (max-width: 800px) { .page, .bar { width: auto; margin: 8px; padding: 16px; } .parties, .grid { grid-template-columns: 1fr; } .top { flex-direction: column; } h1 { text-align: left; } .meta td { text-align: left; padding-left: 0; padding-right: 12px; } .stamp { top: 12px; right: 12px; font-size: 18px; } table.items { font-size: 12px; } }
</style></head>
<body>
<div class="bar"><button onclick="window.print()">Download PDF / Print</button></div>
<div class="page">
  ${stamp ? `<div class="stamp ${inv.status}">${stamp}</div>` : ''}
  <div class="top">
    <div>
      <div class="studio">${esc(s.name)}</div>
      <div class="muted">${br(s.address)}${s.state ? `<br>${esc(s.state)}` : ''}</div>
      ${s.gstin ? `<div>GSTIN: <b>${esc(s.gstin)}</b></div>` : ''}
      <div class="muted">${[s.phone, s.email].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
    <div>
      <h1>${title}</h1>
      <table class="meta">
        <tr><td class="muted">Invoice no.</td><td><b>${esc(inv.number || 'Draft')}</b></td></tr>
        <tr><td class="muted">Date</td><td>${day(inv.issue_date)}</td></tr>
        ${inv.due_date ? `<tr><td class="muted">Due by</td><td>${day(inv.due_date)}</td></tr>` : ''}
        ${gst && pos ? `<tr><td class="muted">Place of supply</td><td>${esc(pos)}</td></tr>` : ''}
      </table>
    </div>
  </div>

  <div class="parties">
    <div>
      <h3>Bill to</h3>
      <div><b>${esc(c.name)}</b></div>
      ${c.address ? `<div class="muted">${br(c.address)}</div>` : ''}
      ${c.gstin ? `<div>GSTIN: ${esc(c.gstin)}</div>` : ''}
      <div class="muted">${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
    ${inv.event_title ? `<div><h3>For</h3><div><b>${esc(inv.event_title)}</b></div>${inv.event_date ? `<div class="muted">${day(inv.event_date)}</div>` : ''}</div>` : '<div></div>'}
  </div>

  <table class="items">
    <thead><tr><th style="width:32px">#</th><th>Description</th>${gst ? '<th>SAC</th>' : ''}<th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>${lines}${totals}</tbody>
  </table>
  <div class="words"><span class="muted">Amount in words:</span> ${esc(amountInWords(Number(inv.total_paise)))}</div>

  ${payments.length ? `<h3>Payments received</h3>
  <table class="items" style="margin-bottom:8px"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>
  ${payments.map((p) => `<tr><td>${day(p.paid_on)}</td><td>${esc(METHOD[p.method] || p.method)}</td><td>${esc(p.reference || '')}</td><td class="num">${formatInr(p.amount_paise)}</td></tr>`).join('')}
  </tbody></table>` : ''}

  <div class="grid">
    ${s.bankDetails || s.upiId ? `<div class="box"><h3>How to pay</h3>${s.upiId ? `<div>UPI: <b>${esc(s.upiId)}</b></div>` : ''}${s.bankDetails ? `<div style="margin-top:6px">${br(s.bankDetails)}</div>` : ''}${upi ? `<a class="pay" href="${esc(upi)}">Pay ${formatInr(balance)} by UPI</a>` : ''}</div>` : '<div></div>'}
    ${inv.notes || s.terms ? `<div class="box">${inv.notes ? `<h3>Notes</h3><div>${br(inv.notes)}</div>` : ''}${s.terms ? `<h3 style="margin-top:${inv.notes ? 10 : 0}px">Terms</h3><div class="muted">${br(s.terms)}</div>` : ''}</div>` : ''}
  </div>

  <div class="foot">${gst ? '' : 'GST not charged. '}This is a computer-generated invoice and needs no signature.</div>
</div>
</body></html>`;
}

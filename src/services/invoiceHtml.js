// Printable GST invoice. Opened in the browser; "Save as PDF" via the print dialog.
import { GST_STATES, amountInWords, formatInr } from './gst.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export function renderInvoiceHtml(inv) {
  const s = inv.seller;
  const bu = inv.buyer;
  const gst = Number(inv.gst_rate) > 0;
  const intra = inv.cgst_paise > 0 || inv.sgst_paise > 0;
  const half = Number(inv.gst_rate) / 2;
  const title = gst ? 'Tax Invoice' : 'Invoice';
  const lines = inv.lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td>${esc(l.sac)}</td><td class="num">${formatInr(l.taxable_paise)}</td></tr>`
    )
    .join('');
  const taxRows = !gst
    ? `<tr><td colspan="3">GST</td><td class="num">Not applicable</td></tr>`
    : intra
      ? `<tr><td colspan="3">CGST @ ${half}%</td><td class="num">${formatInr(inv.cgst_paise)}</td></tr>
         <tr><td colspan="3">SGST @ ${half}%</td><td class="num">${formatInr(inv.sgst_paise)}</td></tr>`
      : `<tr><td colspan="3">IGST @ ${Number(inv.gst_rate)}%</td><td class="num">${formatInr(inv.igst_paise)}</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} ${esc(inv.number)}</title>
<style>
  :root { --ink:#1c1917; --muted:#57534e; --line:#d6d3d1; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #f5f5f4; font-size: 13px; }
  .page { width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff; padding: 18mm 16mm; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 2px solid var(--ink); padding-bottom: 14px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .02em; }
  .muted { color: var(--muted); }
  .meta td { padding: 2px 0 2px 16px; text-align: right; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 18px 0; }
  .parties h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 6px; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.items th, table.items td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
  table.items th { background: #f5f5f4; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .num { text-align: right !important; white-space: nowrap; }
  .total td { font-weight: bold; font-size: 14px; background: #fafaf9; }
  .words { margin: 12px 0 24px; }
  .foot { margin-top: 36px; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
  .stamp { border: 1px dashed var(--line); padding: 10px 14px; text-align: center; min-width: 200px; }
  .bar { width: 210mm; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; }
  .bar button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--ink); background: var(--ink); color: #fff; cursor: pointer; }
  @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; width: auto; min-height: 0; } .bar { display: none; } }
  @media (max-width: 800px) { .page, .bar { width: auto; margin: 8px; padding: 16px; } .parties { grid-template-columns: 1fr; } .top { flex-direction: column; } .meta td { text-align: left; padding-left: 0; padding-right: 12px; } }
</style></head>
<body>
<div class="bar"><button onclick="window.print()">Download PDF / Print</button></div>
<div class="page">
  <div class="top">
    <div>
      <h1>${title}</h1>
      <div><b>${esc(s.name)}</b></div>
      <div class="muted">${esc(s.address).replace(/\n/g, '<br>')}</div>
      ${s.state ? `<div class="muted">${esc(s.state)} (State code ${esc(s.stateCode)})</div>` : ''}
      ${s.gstin ? `<div>GSTIN: <b>${esc(s.gstin)}</b></div>` : ''}
      ${s.email ? `<div class="muted">${esc(s.email)}</div>` : ''}
    </div>
    <table class="meta">
      <tr><td class="muted">Invoice no.</td><td><b>${esc(inv.number)}</b></td></tr>
      <tr><td class="muted">Date</td><td>${day(inv.issued_at)}</td></tr>
      ${inv.period_start ? `<tr><td class="muted">Service period</td><td>${day(inv.period_start)} – ${day(inv.period_end)}</td></tr>` : ''}
      <tr><td class="muted">Place of supply</td><td>${esc(GST_STATES[inv.place_of_supply] || '')} (${esc(inv.place_of_supply)})</td></tr>
      ${inv.razorpay_payment_id ? `<tr><td class="muted">Payment ref.</td><td>${esc(inv.razorpay_payment_id)}</td></tr>` : ''}
      <tr><td class="muted">Status</td><td>${inv.status === 'paid' ? 'Paid' : 'Void'}</td></tr>
    </table>
  </div>

  <div class="parties">
    <div>
      <h3>Billed to</h3>
      <div><b>${esc(bu.legalName)}</b></div>
      <div>${esc(bu.address)}</div>
      <div>${esc([bu.city, bu.state, bu.pincode].filter(Boolean).join(', '))}</div>
      ${bu.gstin ? `<div>GSTIN: <b>${esc(bu.gstin)}</b></div>` : '<div class="muted">Unregistered (no GSTIN)</div>'}
      ${bu.email ? `<div class="muted">${esc(bu.email)}</div>` : ''}
    </div>
    <div>
      <h3>Supply</h3>
      <div>Software subscription (online service)</div>
      <div class="muted">${gst ? (intra ? 'Intra-state supply: CGST + SGST' : 'Inter-state supply: IGST') : 'Supplier not registered for GST'}</div>
    </div>
  </div>

  <table class="items">
    <thead><tr><th style="width:36px">#</th><th>Description</th><th style="width:90px">SAC</th><th class="num" style="width:150px">Taxable value</th></tr></thead>
    <tbody>
      ${lines}
      <tr><td colspan="3"><b>Total taxable value</b></td><td class="num"><b>${formatInr(inv.taxable_paise)}</b></td></tr>
      ${taxRows}
      <tr class="total"><td colspan="3">Total (paid)</td><td class="num">${formatInr(inv.total_paise)}</td></tr>
    </tbody>
  </table>
  <div class="words"><span class="muted">Amount in words:</span> <b>${esc(amountInWords(inv.total_paise))}</b></div>

  <div class="foot">
    <div class="muted" style="max-width:110mm">This is a computer-generated invoice and does not need a signature. Payment received online via Razorpay.${gst ? ' Tax is not payable on reverse charge basis.' : ''}</div>
    <div class="stamp"><div class="muted">For ${esc(s.name)}</div><div style="margin-top:28px">Authorised signatory</div></div>
  </div>
</div>
</body></html>`;
}

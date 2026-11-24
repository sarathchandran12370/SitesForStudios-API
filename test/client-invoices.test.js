import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client } from './helpers.js';

let ctx;
let studio;
let staff;
let sid;
const GSTIN = '32AAACR5055K1ZG'; // Kerala, valid check digit

before(async () => {
  ctx = await start();
  studio = await as('studio@test.local');
  staff = await as('staff@test.local');
  sid = ctx.fx.studio.id;
});
after(stop);

const draft = (extra = {}) => ({
  clientAccountId: ctx.fx.client.id,
  eventId: ctx.fx.event.id,
  customer: { name: 'Anu & Vivek', email: 'couple@test.local', phone: '9800000001' },
  issueDate: '2026-11-20',
  lines: [
    { description: 'Wedding photography, 2 days', qty: 1, rate: 85000 },
    { description: 'Premium album', qty: 2, rate: 7500.5 },
  ],
  discount: 1000,
  ...extra,
});

describe('Client invoices', () => {
  it('without a GSTIN, invoices have no GST and default to a 7-day due date', async () => {
    const r = await staff.post(`/api/invoices/studio/${sid}`, draft());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'draft');
    assert.equal(r.body.number, null);
    assert.equal(r.body.gst_rate, 0);
    assert.equal(r.body.total_paise, 8500000 + 1500100 - 100000);
    assert.equal(r.body.due_date.slice(0, 10), '2026-11-27');
    assert.equal(r.body.view_url, null, 'drafts have no client link');
    const gst = await staff.post(`/api/invoices/studio/${sid}`, draft({ gstRate: 18 }));
    assert.equal(gst.status, 400);
    assert.match(gst.body.error, /GSTIN/);
  });

  it('only studio admins change invoice settings, and the GSTIN is checked', async () => {
    assert.equal((await staff.put(`/api/invoices/studio/${sid}/settings`, { legalName: 'Test Studio LLP' })).status, 403);
    const bad = await studio.put(`/api/invoices/studio/${sid}/settings`, { legalName: 'Test Studio LLP', gstin: '32AAACR5055K1Z5' });
    assert.equal(bad.status, 400);
    const ok = await studio.put(`/api/invoices/studio/${sid}/settings`, {
      legalName: 'Test Studio LLP', gstin: GSTIN, address: 'MG Road, Kochi', prefix: 'ts', upiId: 'teststudio@okhdfcbank', bankDetails: 'HDFC 0001', terms: '50% advance',
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.state_code, '32');
    assert.equal(ok.body.prefix, 'TS');
  });

  it('GST splits into CGST + SGST in the same state and IGST for another state', async () => {
    const same = (await staff.post(`/api/invoices/studio/${sid}`, draft({ discount: 0, lines: [{ description: 'Shoot', qty: 1, rate: 10000 }] }))).body;
    assert.equal(same.gst_rate, 18, 'defaults to 18% once a GSTIN is set');
    assert.equal(same.place_of_supply, '32');
    assert.deepEqual([same.taxable_paise, same.cgst_paise, same.sgst_paise, same.igst_paise, same.total_paise], [1000000, 90000, 90000, 0, 1180000]);
    const other = (await staff.post(`/api/invoices/studio/${sid}`, draft({ discount: 0, lines: [{ description: 'Shoot', qty: 1, rate: 10000 }], customer: { name: 'Riya', stateCode: '29' } }))).body;
    assert.deepEqual([other.cgst_paise, other.igst_paise, other.total_paise], [0, 180000, 1180000]);
    const noGst = (await staff.post(`/api/invoices/studio/${sid}`, draft({ discount: 0, gstRate: 0, lines: [{ description: 'Shoot', qty: 1, rate: 10000 }] }))).body;
    assert.deepEqual([noGst.gst_rate, noGst.cgst_paise, noGst.igst_paise, noGst.total_paise], [0, 0, 0, 1000000], 'GST can be left off even with a GSTIN');
  });

  it('sending numbers the invoice, emails the client and creates a private link', async () => {
    const inv = (await staff.post(`/api/invoices/studio/${sid}`, draft())).body;
    const sent = await staff.post(`/api/invoices/${inv.id}/send`, {});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.status, 'sent');
    assert.match(sent.body.number, /^TS\/26-27\/\d{4}$/);
    assert.ok(sent.body.number.length <= 16);
    assert.equal(sent.body.emailed, 'logged');
    assert.equal(sent.body.seller.name, 'Test Studio LLP');
    const mail = await ctx.db.one(`SELECT * FROM notifications WHERE kind = 'client_invoice' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(mail.recipient, 'couple@test.local');
    assert.ok(mail.body.includes(sent.body.view_url));

    const again = await staff.post(`/api/invoices/${inv.id}/send`, {});
    assert.equal(again.body.number, sent.body.number, 're-sending keeps the number');
    assert.equal((await staff.patch(`/api/invoices/${inv.id}`, draft())).status, 409, 'sent invoices cannot be edited');
    assert.equal((await staff.del(`/api/invoices/${inv.id}`)).status, 409);

    const page = await client().get(new URL(sent.body.view_url).pathname);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('Tax Invoice') && page.body.includes(sent.body.number) && page.body.includes('upi://pay?pa=teststudio%40okhdfcbank'));
    assert.equal((await client().get('/api/invoice-view/not-a-real-token')).status, 404);
  });

  it('numbers are consecutive and drafts never use one', async () => {
    const a = (await staff.post(`/api/invoices/studio/${sid}`, draft())).body;
    await staff.post(`/api/invoices/studio/${sid}`, draft()); // stays a draft
    const b = (await staff.post(`/api/invoices/studio/${sid}`, draft())).body;
    const na = (await staff.post(`/api/invoices/${a.id}/send`, { email: false })).body.number;
    const nb = (await staff.post(`/api/invoices/${b.id}/send`, { email: false })).body.number;
    assert.equal(Number(nb.slice(-4)), Number(na.slice(-4)) + 1);
  });

  it('records part and full payments, sends receipts and refuses overpayment', async () => {
    const inv = (await staff.post(`/api/invoices/studio/${sid}`, draft({ discount: 0, lines: [{ description: 'Shoot', qty: 1, rate: 10000 }] }))).body;
    assert.equal((await staff.post(`/api/invoices/${inv.id}/payments`, { amount: 100, method: 'upi' })).status, 409, 'send first');
    await staff.post(`/api/invoices/${inv.id}/send`, { email: false });
    const part = await staff.post(`/api/invoices/${inv.id}/payments`, { amount: 5000, method: 'upi', reference: 'UTR123' });
    assert.equal(part.status, 201);
    assert.equal(part.body.status, 'partially_paid');
    assert.equal(part.body.balance_paise, 680000);
    assert.ok(await ctx.db.one(`SELECT 1 FROM notifications WHERE kind = 'payment_receipt' AND recipient = 'couple@test.local'`));
    assert.equal((await staff.post(`/api/invoices/${inv.id}/payments`, { amount: 7000, method: 'cash' })).status, 400);
    const rest = await staff.post(`/api/invoices/${inv.id}/payments`, { amount: 6800, method: 'bank', notifyClient: false });
    assert.equal(rest.body.status, 'paid');
    assert.equal(rest.body.balance_paise, 0);
    assert.equal((await staff.post(`/api/invoices/${inv.id}/cancel`)).status, 409, 'cannot cancel with payments');
    const undone = await staff.del(`/api/invoices/${inv.id}/payments/${rest.body.payments[1].id}`);
    assert.equal(undone.body.status, 'partially_paid');
  });

  it('cancelled invoices show as cancelled and take no payments', async () => {
    const inv = (await staff.post(`/api/invoices/studio/${sid}`, draft())).body;
    await staff.post(`/api/invoices/${inv.id}/send`, { email: false });
    const c = await staff.post(`/api/invoices/${inv.id}/cancel`);
    assert.equal(c.body.status, 'cancelled');
    assert.equal(c.body.balance_paise, 0);
    assert.equal((await staff.post(`/api/invoices/${inv.id}/payments`, { amount: 10, method: 'cash' })).status, 409);
    assert.ok((await client().get(new URL(c.body.view_url).pathname)).body.includes('Cancelled'));
  });

  it('the list has totals for outstanding, overdue and paid this month', async () => {
    const old = (await staff.post(`/api/invoices/studio/${sid}`, draft({ issueDate: '2026-01-01', dueDate: '2026-01-10' }))).body;
    await staff.post(`/api/invoices/${old.id}/send`, { email: false });
    const r = await staff.get(`/api/invoices/studio/${sid}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.invoices.find((i) => i.id === old.id).overdue);
    assert.ok(r.body.summary.overdue_count >= 1);
    assert.ok(r.body.summary.outstanding_paise >= r.body.summary.overdue_paise);
    assert.equal(r.body.summary.paid_this_month_paise, 500000, 'the ₹5,000 part payment (the removed ₹6,800 one does not count)');
  });

  it('clients see their sent invoices in the portal, never drafts or other clients’ invoices', async () => {
    const couple = await as('couple@test.local');
    const mine = (await couple.get('/api/portal/invoices')).body;
    assert.ok(mine.length >= 1);
    assert.ok(mine.every((i) => i.status !== 'draft' && i.view_url));
    const guest = await as('guest@test.local');
    assert.deepEqual((await guest.get('/api/portal/invoices')).body, []);
    assert.equal((await couple.get(`/api/invoices/studio/${sid}`)).status, 403, 'clients cannot use the studio routes');
  });

  it('another studio cannot see or change these invoices', async () => {
    const org2 = await ctx.db.one(`INSERT INTO organizations(name, plan_id, status) VALUES ('Other','pro','active') RETURNING id`);
    const s2 = await ctx.db.one(`INSERT INTO studios(org_id,name,slug) VALUES ($1,'Other Studio','other-studio') RETURNING id`, [org2.id]);
    const { hashPassword } = await import('../src/util.js');
    await ctx.db.q(`INSERT INTO accounts(email,name,password_hash,role,org_id,studio_id,must_change_password) VALUES ('other@test.local','Other',$1,'studio_admin',$2,$3,false)`, [await hashPassword('Test!2026pw'), org2.id, s2.id]);
    const other = await as('other@test.local');
    const inv = (await staff.post(`/api/invoices/studio/${sid}`, draft())).body;
    assert.equal((await other.get(`/api/invoices/${inv.id}`)).status, 403);
    assert.equal((await other.get(`/api/invoices/studio/${sid}`)).status, 403);
    const foreign = await other.post(`/api/invoices/studio/${s2.id}`, draft());
    assert.equal(foreign.status, 400, 'cannot bill another studio’s client');
  });

  it('works on the Website plan for people without a login', async () => {
    await ctx.db.q(`UPDATE organizations SET plan_id = 'website' WHERE id = $1`, [ctx.fx.org.id]);
    const inv = await staff.post(`/api/invoices/studio/${sid}`, draft({ clientAccountId: null, eventId: null, customer: { name: 'Meera', email: 'meera@example.com' } }));
    assert.equal(inv.status, 201);
    const sent = await staff.post(`/api/invoices/${inv.body.id}/send`, {});
    assert.equal(sent.status, 200);
    assert.equal((await client().get(new URL(sent.body.view_url).pathname)).status, 200);
    await ctx.db.q(`UPDATE organizations SET plan_id = 'pro' WHERE id = $1`, [ctx.fx.org.id]);
  });
});

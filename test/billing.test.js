import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { start, stop, as, client } from './helpers.js';
import { isValidGstin, amountInWords, splitInclusive, financialYear, withGst } from '../src/services/gst.js';

// ---------------------------------------------------------------- fake Razorpay API
const KEY_SECRET = 'rzp_test_secret';
const WEBHOOK_SECRET = 'whsec_test';
const fake = { calls: [], subs: {}, payments: {}, n: 0 };
const now = () => Math.floor(Date.now() / 1000);

const fakeServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url.replace(/^\/v1/, '');
    fake.calls.push({ method: req.method, path, body });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    let m;
    if (req.method === 'POST' && path === '/subscriptions') {
      const id = `sub_${++fake.n}`;
      fake.subs[id] = { id, plan_id: body.plan_id, status: 'created', current_start: now(), current_end: now() + 30 * 86400, notes: body.notes };
      return send(200, fake.subs[id]);
    }
    if ((m = path.match(/^\/subscriptions\/([^/]+)$/))) {
      const sub = fake.subs[m[1]];
      if (!sub) return send(404, { error: { description: 'no such subscription' } });
      if (req.method === 'PATCH') Object.assign(sub, { plan_id: body.schedule_change_at === 'now' ? body.plan_id : sub.plan_id, scheduled_plan: body.plan_id });
      return send(200, sub);
    }
    if (req.method === 'POST' && (m = path.match(/^\/subscriptions\/([^/]+)\/cancel$/))) return send(200, { ...fake.subs[m[1]], cancel_at_cycle_end: true });
    if (req.method === 'POST' && (m = path.match(/^\/subscriptions\/([^/]+)\/addons$/))) return send(200, { id: `ao_${++fake.n}`, item: body.item });
    if (req.method === 'GET' && (m = path.match(/^\/payments\/([^/]+)$/))) return send(200, fake.payments[m[1]] || { id: m[1], status: 'failed', amount: 0 });
    send(404, { error: { description: 'not found' } });
  });
});

/** A valid GSTIN for a state: computes the check character. */
function gstinFor(state, pan = 'AABCS1234A') {
  const base = `${state}${pan}1Z`;
  for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (isValidGstin(base + c)) return base + c;
  throw new Error('no check digit');
}
const SELLER_GSTIN = gstinFor('32', 'AAACT2727Q');
const BUYER_GSTIN = gstinFor('32');

const signWebhook = (obj) => {
  const raw = JSON.stringify(obj);
  return { raw, sig: crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex') };
};

let ctx;
let owner;
before(async () => {
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_API_BASE: `http://127.0.0.1:${fakeServer.address().port}/v1`,
    SELLER_NAME: 'SitesForStudios Test Pvt Ltd',
    SELLER_GSTIN,
    SELLER_ADDRESS: 'MG Road, Kochi',
    INVOICE_PREFIX: 'SFS',
  });
  ctx = await start();
  await ctx.db.q(`UPDATE plans SET razorpay_plan_id = 'plan_' || id || '_m', razorpay_plan_id_yearly = 'plan_' || id || '_y'`);
  await ctx.db.q(`UPDATE organizations SET status = 'trial', plan_id = 'starter' WHERE id = $1`, [ctx.fx.org.id]);
  owner = await as('owner@test.local');
});
after(async () => {
  await stop();
  fakeServer.close();
});

async function pay(subscriptionId, amount) {
  const paymentId = `pay_${++fake.n}`;
  fake.payments[paymentId] = { id: paymentId, amount, status: 'captured' };
  fake.subs[subscriptionId].status = 'active';
  const signature = crypto.createHmac('sha256', KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');
  return { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature };
}

const invoices = () => ctx.db.q('SELECT * FROM invoices WHERE org_id = $1 ORDER BY issued_at, number', [ctx.fx.org.id]);
const org = () => ctx.db.one('SELECT * FROM organizations WHERE id = $1', [ctx.fx.org.id]);
const fy = financialYear(new Date());

describe('GST helpers', () => {
  it('validates GSTINs including the check character', () => {
    assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
    assert.equal(isValidGstin('27AAPFU0939F1ZX'), false, 'wrong check character');
    assert.equal(isValidGstin('99AAPFU0939F1ZV'), false, 'unknown state');
    assert.equal(isValidGstin('27AAPFU0939'), false);
  });
  it('splits GST into CGST+SGST in the same state and IGST across states', () => {
    assert.deepEqual(splitInclusive(412882, 18, '32', '32'), { taxable: 349900, cgst: 31491, sgst: 31491, igst: 0, tax: 62982 });
    assert.deepEqual(splitInclusive(412882, 18, '32', '29'), { taxable: 349900, cgst: 0, sgst: 0, igst: 62982, tax: 62982 });
    assert.deepEqual(splitInclusive(349900, 0, '32', '29'), { taxable: 349900, cgst: 0, sgst: 0, igst: 0, tax: 0 });
  });
  it('writes amounts in Indian words and knows the financial year', () => {
    assert.equal(amountInWords(412882), 'Rupees Four Thousand One Hundred Twenty Eight and Eighty Two Paise Only');
    assert.equal(amountInWords(17698820), 'Rupees One Lakh Seventy Six Thousand Nine Hundred Eighty Eight and Twenty Paise Only');
    assert.equal(financialYear(new Date('2026-11-23')), '2026-27');
    assert.equal(financialYear(new Date('2027-02-10')), '2026-27');
    assert.equal(financialYear(new Date('2027-04-01')), '2027-28');
    assert.equal(withGst(3499, 18), 412882);
  });
});

describe('billing (Razorpay + GST invoices)', () => {
  let subId;

  it('shows plans with GST-inclusive totals', async () => {
    const r = await owner.get('/api/billing/summary');
    assert.equal(r.status, 200);
    assert.equal(r.body.billing.gst, true);
    const pro = r.body.plans.find((p) => p.id === 'pro');
    assert.equal(pro.monthlyTotalPaise, withGst(pro.price_monthly_inr, 18));
    assert.equal(r.body.org.status, 'trial');
  });

  it('is only for organization owners', async () => {
    const studio = await as('studio@test.local');
    assert.equal((await studio.get('/api/billing/summary')).status, 403);
    assert.equal((await studio.post('/api/billing/checkout', { planId: 'pro', cycle: 'monthly' })).status, 403);
  });

  it('needs billing details before checkout', async () => {
    const r = await owner.post('/api/billing/checkout', { planId: 'pro', cycle: 'monthly' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /billing details/);
  });

  it('validates billing details (GSTIN, state, PIN)', async () => {
    const base = { legalName: 'Arjun Creative LLP', address: 'Panampilly Nagar', city: 'Kochi', stateCode: '32', pincode: '682036', email: 'accounts@test.local' };
    assert.equal((await owner.put('/api/billing/profile', { ...base, gstin: '32ABCDE1234F1Z0' })).status, 400, 'bad check character');
    const mismatch = await owner.put('/api/billing/profile', { ...base, gstin: gstinFor('29') });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.body.error, /Karnataka/);
    assert.equal((await owner.put('/api/billing/profile', { ...base, pincode: '12345' })).status, 400);
    const ok = await owner.put('/api/billing/profile', { ...base, gstin: BUYER_GSTIN.toLowerCase() });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.gstin, BUYER_GSTIN);
  });

  it('starts a Razorpay subscription for the chosen plan', async () => {
    const r = await owner.post('/api/billing/checkout', { planId: 'pro', cycle: 'monthly' });
    assert.equal(r.status, 200);
    subId = r.body.subscriptionId;
    assert.ok(subId);
    assert.equal(r.body.keyId, 'rzp_test_key');
    assert.equal(r.body.amountPaise, withGst(5999, 18));
    assert.equal(fake.subs[subId].plan_id, 'plan_pro_m');
    assert.equal((await org()).pending_plan_id, 'pro');
  });

  it('refuses a payment with a bad signature', async () => {
    const p = await pay(subId, withGst(5999, 18));
    const r = await owner.post('/api/billing/verify', { ...p, razorpay_signature: 'bad' });
    assert.equal(r.status, 400);
    assert.equal((await org()).status, 'trial');
  });

  it('activates the plan and issues a GST invoice after payment', async () => {
    const p = await pay(subId, withGst(5999, 18));
    const r = await owner.post('/api/billing/verify', p);
    assert.equal(r.status, 200);
    assert.equal(r.body.invoiceNumber, `SFS/${fy}/0001`);
    const o = await org();
    assert.equal(o.status, 'active');
    assert.equal(o.plan_id, 'pro');
    assert.equal(o.billing_cycle, 'monthly');
    assert.ok(o.current_period_end);
    const [inv] = await invoices();
    assert.equal(inv.total_paise, 707882);
    assert.equal(inv.taxable_paise, 599900);
    assert.equal(inv.cgst_paise + inv.sgst_paise, 107982);
    assert.equal(inv.igst_paise, 0, 'same state as the seller');
    assert.equal(inv.buyer.gstin, BUYER_GSTIN);
    const mail = await ctx.db.one(`SELECT * FROM notifications WHERE kind = 'invoice' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(mail.recipient, 'accounts@test.local');
  });

  it('renders a printable tax invoice, only for its own organization and the Super Admin', async () => {
    const [inv] = await invoices();
    const doc = await owner.get(`/api/billing/invoices/${inv.id}/document`);
    assert.equal(doc.status, 200);
    for (const text of ['Tax Invoice', `SFS/${fy}/0001`, SELLER_GSTIN, BUYER_GSTIN, 'CGST @ 9%', 'SGST @ 9%', 'Rupees Seven Thousand Seventy Eight and Eighty Two Paise Only', '997331'])
      assert.ok(doc.body.includes(text), `invoice shows ${text}`);
    const admin = await as('admin@test.local');
    assert.equal((await admin.get(`/api/billing/invoices/${inv.id}/document`)).status, 200);
    const created = await admin.post('/api/admin/orgs', { name: 'Other', planId: 'starter', ownerName: 'Other Owner', ownerEmail: 'o2@test.local', sendInvite: false });
    const other = await as('o2@test.local', created.body.owner.temporaryPassword);
    assert.equal((await other.get(`/api/billing/invoices/${inv.id}/document`)).status, 404);
    assert.equal((await admin.get('/api/admin/invoices')).body.length, 1);
  });

  it('upgrades immediately and downgrades at the end of the period', async () => {
    const up = await owner.post('/api/billing/checkout', { planId: 'organization', cycle: 'monthly' });
    assert.equal(up.body.when, 'now');
    assert.equal((await org()).plan_id, 'organization');
    const down = await owner.post('/api/billing/checkout', { planId: 'starter', cycle: 'monthly' });
    assert.equal(down.body.when, 'cycle_end');
    const o = await org();
    assert.equal(o.plan_id, 'organization', 'keeps the paid plan until the period ends');
    assert.equal(o.pending_plan_id, 'starter');
    const patch = fake.calls.filter((c) => c.method === 'PATCH').at(-1);
    assert.equal(patch.body.schedule_change_at, 'cycle_end');
  });

  it('rejects webhooks without a valid signature', async () => {
    const r = await fetch(`${ctx.url}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'nope' }, body: '{}' });
    assert.equal(r.status, 400);
  });

  it('invoices renewals from the webhook, with no duplicates', async () => {
    // Downgrade takes effect at renewal: Razorpay now reports the starter plan.
    fake.subs[subId].plan_id = 'plan_starter_m';
    const amount = withGst(2999, 18);
    const evt = {
      event: 'subscription.charged',
      payload: { subscription: { entity: { ...fake.subs[subId], status: 'active', current_start: now(), current_end: now() + 30 * 86400 } }, payment: { entity: { id: 'pay_renewal_1', amount } } },
    };
    const { raw, sig } = signWebhook(evt);
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${ctx.url}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body: raw });
      assert.equal(r.status, 200);
    }
    const all = await invoices();
    assert.equal(all.length, 2, 'the replayed webhook did not create a second invoice');
    const renewal = all[1];
    assert.equal(renewal.number, `SFS/${fy}/0002`);
    assert.equal(renewal.total_paise, amount);
    assert.equal(renewal.lines.length, 1);
    assert.match(renewal.lines[0].description, /Starter plan/);
    assert.equal(renewal.lines[0].taxable_paise, renewal.taxable_paise);
    const o = await org();
    assert.equal(o.plan_id, 'starter');
    assert.equal(o.pending_plan_id, null);
  });

  it('charges IGST when the buyer is in another state', async () => {
    await owner.put('/api/billing/profile', { legalName: 'Arjun Creative LLP', address: 'Indiranagar', city: 'Bengaluru', stateCode: '29', pincode: '560038', email: 'accounts@test.local' });
    const evt = { event: 'subscription.charged', payload: { subscription: { entity: { ...fake.subs[subId], status: 'active' } }, payment: { entity: { id: 'pay_renewal_2', amount: withGst(2999, 18) } } } };
    const { raw, sig } = signWebhook(evt);
    await fetch(`${ctx.url}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig }, body: raw });
    const inv = (await invoices()).at(-1);
    assert.equal(inv.place_of_supply, '29');
    assert.equal(inv.igst_paise, 53982);
    assert.equal(inv.cgst_paise, 0);
    const doc = await owner.get(`/api/billing/invoices/${inv.id}/document`);
    assert.ok(doc.body.includes('IGST @ 18%'));
    assert.ok(doc.body.includes('Unregistered (no GSTIN)'));
  });

  it('marks failed renewals as past due, and cancellation at period end', async () => {
    const halted = signWebhook({ event: 'subscription.halted', payload: { subscription: { entity: { ...fake.subs[subId], status: 'halted' } } } });
    await fetch(`${ctx.url}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': halted.sig }, body: halted.raw });
    assert.equal((await org()).status, 'past_due');

    const r = await owner.post('/api/billing/cancel');
    assert.equal(r.status, 200);
    assert.equal((await org()).cancel_at_period_end, true);
    assert.ok(fake.calls.some((c) => c.path === `/subscriptions/${subId}/cancel` && c.body.cancel_at_cycle_end === 1));

    const cancelled = signWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: { ...fake.subs[subId], status: 'cancelled' } } } });
    await fetch(`${ctx.url}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': cancelled.sig }, body: cancelled.raw });
    const o = await org();
    assert.equal(o.status, 'cancelled');
    assert.equal(o.cancel_at_period_end, false);
    assert.equal((await client().login('owner@test.local')).status, 403, 'a cancelled organization is blocked');
  });
});

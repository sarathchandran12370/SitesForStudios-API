import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as } from './helpers.js';

let ctx;
before(async () => (ctx = await start()));
after(stop);

const proPlan = {
  name: 'Pro',
  price_monthly_inr: 7499,
  price_yearly_inr: 74990,
  storage_gb: 2048,
  max_studios: 2,
  face_events_per_month: 10,
  staff_seats: 4,
  raw_delivery: true,
  premium_templates: true,
  retention_months: 18,
  razorpay_plan_id: 'plan_TEST123',
};

describe('Super Admin plan editing (item 10)', () => {
  it('updates every plan field', async () => {
    const admin = await as('admin@test.local');
    const r = await admin.put('/api/admin/plans/pro', proPlan);
    assert.equal(r.status, 200);
    for (const [k, v] of Object.entries(proPlan)) assert.equal(r.body[k], v, k);
    const list = await admin.get('/api/admin/plans');
    assert.equal(list.body.find((p) => p.id === 'pro').price_monthly_inr, 7499);
  });

  it('new limits apply right away (studio limit raised to 2)', async () => {
    const owner = await as('owner@test.local');
    const r = await owner.post('/api/org/studios', { name: 'Second Studio', sendInvite: false });
    assert.equal(r.status, 201);
  });

  it('new events use the plan retention', async () => {
    const studio = await as('studio@test.local');
    const ev = await studio.post(`/api/events/studio/${ctx.fx.studio.id}`, { title: 'Retention check' });
    const months = (new Date(ev.body.expires_at) - Date.now()) / (30.44 * 24 * 3600 * 1000);
    assert.ok(months > 17.5 && months < 18.5, `expected ~18 months, got ${months}`);
  });

  it('validates input', async () => {
    const admin = await as('admin@test.local');
    assert.equal((await admin.put('/api/admin/plans/pro', { ...proPlan, price_monthly_inr: -1 })).status, 400);
    assert.equal((await admin.put('/api/admin/plans/pro', { ...proPlan, retention_months: 0 })).status, 400);
    assert.equal((await admin.put('/api/admin/plans/nope', proPlan)).status, 404);
  });

  it('is Super Admin only', async () => {
    const owner = await as('owner@test.local');
    assert.equal((await owner.put('/api/admin/plans/pro', proPlan)).status, 403);
  });
});

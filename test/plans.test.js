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

  it('new events never expire (galleries stay online while the studio subscribes)', async () => {
    const studio = await as('studio@test.local');
    const ev = await studio.post(`/api/events/studio/${ctx.fx.studio.id}`, { title: 'No expiry' });
    assert.equal(ev.status, 201);
    assert.equal(ev.body.expires_at, null);
    assert.equal(ev.body.status, 'active');
  });

  it('validates input', async () => {
    const admin = await as('admin@test.local');
    assert.equal((await admin.put('/api/admin/plans/pro', { ...proPlan, price_monthly_inr: -1 })).status, 400);
    assert.equal((await admin.put('/api/admin/plans/pro', { ...proPlan, storage_gb: 0 })).status, 400);
    assert.equal((await admin.put('/api/admin/plans/nope', proPlan)).status, 404);
  });

  it('is Super Admin only', async () => {
    const owner = await as('owner@test.local');
    assert.equal((await owner.put('/api/admin/plans/pro', proPlan)).status, 403);
  });
});

describe('No archiving', () => {
  it('there is no restore endpoint or retention job any more', async () => {
    const studio = await as('studio@test.local');
    assert.equal((await studio.post(`/api/events/${ctx.fx.event.id}/restore`)).status, 404);
    const admin = await as('admin@test.local');
    assert.equal((await admin.post('/api/admin/retention/run')).status, 404);
  });

  it('old galleries stay open to clients', async () => {
    await ctx.db.q(`UPDATE events SET event_date = '2019-01-01' WHERE id = $1`, [ctx.fx.event.id]);
    const couple = await as('couple@test.local');
    assert.equal((await couple.get(`/api/portal/events/${ctx.fx.event.id}`)).status, 200);
  });

  it('the storage limit message points to deleting old events or upgrading', async () => {
    await ctx.db.q(`UPDATE events SET storage_bytes = 3000 * 1024::bigint * 1024 * 1024 WHERE id = $1`, [ctx.fx.event.id]);
    const studio = await as('studio@test.local');
    const r = await studio.post(`/api/events/${ctx.fx.event.id}/uploads`, { files: [{ name: 'a.jpg', size: 1000, type: 'image/jpeg' }] });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /Delete old events you no longer need, or move to a bigger plan/);
    assert.doesNotMatch(r.body.error, /archive/i);
  });
});

describe('Face search not offered', () => {
  it('no plan includes face events, and new events have face search off', async () => {
    const admin = await as('admin@test.local');
    const plans = (await admin.get('/api/admin/plans')).body;
    // Pro was edited by the plan-editing tests above; every other plan keeps the seeded 0.
    assert.ok(plans.filter((p) => p.id !== 'pro').every((p) => p.face_events_per_month === 0));
    const pro = plans.find((p) => p.id === 'pro');
    await admin.put('/api/admin/plans/pro', { ...pro, face_events_per_month: 0, razorpay_plan_id: pro.razorpay_plan_id || null, razorpay_plan_id_yearly: null });
    const studio = await as('studio@test.local');
    const ev = await studio.post(`/api/events/studio/${ctx.fx.studio.id}`, { title: 'No faces', faceEnabled: true });
    assert.equal(ev.body.face_enabled, false);
    const on = await studio.patch(`/api/events/${ev.body.id}`, { faceEnabled: true });
    assert.equal(on.status, 402);
    assert.match(on.body.error, /Face search is not included/);
  });

  it('the Super Admin can bring it back for a plan', async () => {
    const admin = await as('admin@test.local');
    const pro = (await admin.get('/api/admin/plans')).body.find((p) => p.id === 'pro');
    await admin.put('/api/admin/plans/pro', { ...pro, face_events_per_month: 8, razorpay_plan_id: pro.razorpay_plan_id || null, razorpay_plan_id_yearly: null });
    const studio = await as('studio@test.local');
    const ev = await studio.post(`/api/events/studio/${ctx.fx.studio.id}`, { title: 'Faces back', faceEnabled: true });
    assert.equal(ev.body.face_enabled, true);
    await admin.put('/api/admin/plans/pro', { ...pro, face_events_per_month: 0, razorpay_plan_id: pro.razorpay_plan_id || null, razorpay_plan_id_yearly: null });
  });
});

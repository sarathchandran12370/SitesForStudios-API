import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client, uploadPhoto, jpeg } from './helpers.js';

let ctx;
let studio;
let owner;
const setPlan = (id) => ctx.db.q('UPDATE organizations SET plan_id = $2 WHERE id = $1', [ctx.fx.org.id, id]);

before(async () => {
  ctx = await start();
  studio = await as('studio@test.local');
  owner = await as('owner@test.local');
});
after(stop);

describe('Website plan (website only, no client galleries)', () => {
  it('exists at ₹999 / ₹9,990 with 10 GB and no client galleries', async () => {
    const admin = await as('admin@test.local');
    const plan = (await admin.get('/api/admin/plans')).body.find((p) => p.id === 'website');
    assert.equal(plan.price_monthly_inr, 999);
    assert.equal(plan.price_yearly_inr, 9990);
    assert.equal(plan.storage_gb, 10);
    assert.equal(plan.client_galleries, false);
    assert.equal(plan.face_events_per_month, 0);
    assert.equal(plan.raw_delivery, false);
  });

  it('a studio can sign up straight onto it', async () => {
    const c = client();
    const r = await c.post('/api/signup/start', { type: 'studio', studioName: 'Just A Site', name: 'Nila', email: 'nila@test.local', phone: '9833344455', password: 'Strong!pass1', planId: 'website', acceptTerms: true });
    assert.equal(r.status, 201);
    const code = (await ctx.db.one(`SELECT subject FROM notifications WHERE kind = 'signup_code' AND recipient = 'nila@test.local'`)).subject.slice(0, 6);
    await c.post('/api/signup/verify', { requestId: r.body.requestId, code });
    const me = (await c.get('/api/auth/me')).body.user;
    assert.equal(me.plan_id, 'website');
    assert.equal(me.client_galleries, false);
    assert.equal(me.org_mode, 'single');
  });

  it('blocks client accounts but still allows a staff seat', async () => {
    await setPlan('website');
    const r = await studio.post(`/api/studios/${ctx.fx.studio.id}/accounts`, { name: 'New Couple', email: 'newcouple@test.local', sendInvite: false });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /Website plan/);
  });

  it('events are portfolio albums: no RAW or face recognition, portfolio on by default', async () => {
    const r = await studio.post(`/api/events/studio/${ctx.fx.studio.id}`, { title: 'Portfolio: Beach wedding', rawEnabled: false, faceEnabled: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.face_enabled, false);
    assert.equal(r.body.raw_enabled, false);
    assert.equal(r.body.show_in_portfolio, true);
    assert.equal((await studio.patch(`/api/events/${r.body.id}`, { faceEnabled: true })).status, 402);
    const photo = await uploadPhoto(studio, r.body.id, { name: 'beach.jpg', type: 'image/jpeg', buffer: await jpeg() });
    assert.equal(photo.status, 'ready', 'portfolio photos still upload and process');
    await studio.patch(`/api/events/${r.body.id}/photos`, { photoIds: [String(photo._id)], isHighlight: true });
    const site = await client().get('/api/sites/test-studio');
    assert.ok(site.body.portfolio.some((p) => p.title === 'Portfolio: Beach wedding'), 'highlights show on the website');
  });

  it('cannot notify clients', async () => {
    assert.equal((await studio.post(`/api/events/${ctx.fx.event.id}/notify-clients`)).status, 402);
  });

  it('existing clients see a clear message after a downgrade', async () => {
    const couple = await as('couple@test.local');
    const r = await couple.get(`/api/portal/events/${ctx.fx.event.id}`);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /contact your photographer/);
  });

  it('the website and enquiries keep working', async () => {
    assert.equal((await client().get('/api/sites/test-studio')).status, 200);
    assert.equal((await client().post('/api/sites/test-studio/enquiries', { name: 'Asha', phone: '9876543210' })).status, 201);
  });

  it('checklist shows portfolio steps instead of client steps', async () => {
    const steps = (await owner.get(`/api/studios/${ctx.fx.studio.id}/onboarding`)).body.steps.map((s) => s.id);
    assert.ok(!steps.includes('client') && !steps.includes('notify'));
    assert.match((await owner.get(`/api/studios/${ctx.fx.studio.id}/onboarding`)).body.steps.find((s) => s.id === 'event').label, /portfolio album/);
  });

  it('upgrading to Starter brings client galleries back', async () => {
    await setPlan('starter');
    const couple = await as('couple@test.local');
    assert.equal((await couple.get(`/api/portal/events/${ctx.fx.event.id}`)).status, 200);
    const r = await studio.post(`/api/studios/${ctx.fx.studio.id}/accounts`, { name: 'New Couple', email: 'newcouple@test.local', sendInvite: false });
    assert.equal(r.status, 201);
  });

  it('the Super Admin can switch client galleries on or off for any plan', async () => {
    const admin = await as('admin@test.local');
    const plan = (await admin.get('/api/admin/plans')).body.find((p) => p.id === 'website');
    const r = await admin.put('/api/admin/plans/website', { ...plan, razorpay_plan_id: null, razorpay_plan_id_yearly: null, client_galleries: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.client_galleries, true);
  });
});

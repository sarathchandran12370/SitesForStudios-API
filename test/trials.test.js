import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, client, as } from './helpers.js';
import { runTrials } from '../src/services/trials.js';

let ctx;
const DAY = 86400000;
const setTrial = (daysLeft, status = 'trial') =>
  ctx.db.q(`UPDATE organizations SET status = $2, trial_ends_at = now() + make_interval(secs => $3), trial_reminder_days = NULL, expired_at = NULL WHERE id = $1`, [ctx.fx.org.id, status, Math.round(daysLeft * 86400)]);
const org = () => ctx.db.one('SELECT * FROM organizations WHERE id = $1', [ctx.fx.org.id]);
const count = async (kind) => (await ctx.db.one('SELECT count(*)::int AS n FROM notifications WHERE kind = $1', [kind])).n;

before(async () => (ctx = await start()));
after(stop);

describe('trials', () => {
  it('sends 7, 3 and 1-day reminders once each', async () => {
    await setTrial(6.5);
    assert.equal((await runTrials()).reminders, 1);
    assert.equal((await runTrials()).reminders, 0, 'not repeated');
    await ctx.db.q(`UPDATE organizations SET trial_ends_at = now() + interval '2 days' WHERE id = $1`, [ctx.fx.org.id]);
    assert.equal((await runTrials()).reminders, 1);
    await ctx.db.q(`UPDATE organizations SET trial_ends_at = now() + interval '10 hours' WHERE id = $1`, [ctx.fx.org.id]);
    assert.equal((await runTrials()).reminders, 1);
    assert.equal((await org()).trial_reminder_days, 1);
    assert.equal(await count('trial_reminder'), 3);
  });

  it('expires the trial: dashboard read-only except billing, galleries and website stay up', async () => {
    await setTrial(-0.01);
    assert.equal((await runTrials()).expired, 1);
    assert.equal((await org()).status, 'expired');
    assert.equal(await count('trial_expired'), 1);

    const studio = await as('studio@test.local');
    assert.equal((await studio.get(`/api/studios/${ctx.fx.studio.id}`)).status, 200, 'can still look');
    const write = await studio.post(`/api/events/studio/${ctx.fx.studio.id}`, { title: 'New wedding' });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, 'TRIAL_EXPIRED');
    const me = (await studio.get('/api/auth/me')).body.user;
    assert.ok(me.grace_ends_at, 'the banner can show when the grace period ends');

    const owner = await as('owner@test.local');
    assert.equal((await owner.put('/api/billing/profile', { legalName: 'Test Org', address: 'MG Road', city: 'Kochi', stateCode: '32', pincode: '682016', email: 'a@test.local' })).status, 200, 'billing still works');

    const couple = await as('couple@test.local');
    assert.equal((await couple.get(`/api/portal/events/${ctx.fx.event.id}`)).status, 200, 'clients keep access during the grace period');
    assert.equal((await client().get('/api/sites/test-studio')).status, 200, 'website stays online');
  });

  it('suspends after the grace period', async () => {
    await ctx.db.q(`UPDATE organizations SET expired_at = now() - interval '15 days' WHERE id = $1`, [ctx.fx.org.id]);
    assert.equal((await runTrials()).suspended, 1);
    assert.equal((await org()).status, 'suspended');
    assert.equal((await client().get('/api/sites/test-studio')).status, 404);
    assert.equal((await client().login('couple@test.local')).status, 403);
  });

  it('the Super Admin can extend a trial, which reopens everything', async () => {
    const admin = await as('admin@test.local');
    const r = await admin.patch(`/api/admin/orgs/${ctx.fx.org.id}`, { extendTrialDays: 14 });
    assert.equal(r.status, 200);
    const o = await org();
    assert.equal(o.status, 'trial');
    assert.equal(o.expired_at, null);
    assert.ok(new Date(o.trial_ends_at) - Date.now() > 13 * DAY);
    const studio = await as('studio@test.local');
    assert.equal((await studio.post(`/api/events/studio/${ctx.fx.studio.id}`, { title: 'Back in business' })).status, 201);
  });

  it('only trial, expired or suspended organizations can be extended', async () => {
    await ctx.db.q(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ctx.fx.org.id]);
    const admin = await as('admin@test.local');
    assert.equal((await admin.patch(`/api/admin/orgs/${ctx.fx.org.id}`, { extendTrialDays: 14 })).status, 400);
  });

  it('new organizations created by the Super Admin get a trial end date', async () => {
    const admin = await as('admin@test.local');
    const r = await admin.post('/api/admin/orgs', { name: 'Fresh Org', planId: 'starter', ownerName: 'Fresh Owner', ownerEmail: 'fresh@test.local', sendInvite: false });
    const days = (new Date(r.body.org.trial_ends_at) - Date.now()) / DAY;
    assert.ok(days > 13.9 && days < 14.1);
  });
});

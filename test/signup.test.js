import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, client, as, uploadPhoto, jpeg } from './helpers.js';

let ctx;
before(async () => (ctx = await start()));
after(stop);

const lastCode = async (email) => {
  const row = await ctx.db.one(`SELECT subject FROM notifications WHERE kind = 'signup_code' AND recipient = $1 ORDER BY created_at DESC LIMIT 1`, [email]);
  return row.subject.slice(0, 6);
};
const studioSignup = (over = {}) => ({ type: 'studio', studioName: 'Lens & Light', name: 'Meera Nair', email: 'meera@test.local', phone: '9811122233', password: 'Strong!pass1', planId: 'pro', acceptTerms: true, ...over });

describe('self sign-up', () => {
  it('lists the trial length and plans', async () => {
    const r = await client().get('/api/signup/options');
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.trialDays, 14);
    assert.equal(r.body.plans.length, 3);
  });

  it('validates the details and refuses an email that already has an account', async () => {
    const c = client();
    assert.equal((await c.post('/api/signup/start', studioSignup({ password: 'short' }))).status, 400);
    const noConsent = await c.post('/api/signup/start', studioSignup({ acceptTerms: false }));
    assert.equal(noConsent.status, 400, 'terms must be accepted');
    assert.match(noConsent.body.error, /Terms of Service/);
    assert.equal((await c.post('/api/signup/start', studioSignup({ planId: 'organization' }))).status, 400, 'Organization plan needs the organization flow');
    assert.equal((await c.post('/api/signup/start', studioSignup({ email: 'studio@test.local' }))).status, 409);
    assert.equal((await c.post('/api/signup/start', { ...studioSignup(), type: 'organization', planId: 'organization' })).status, 400, 'organization name required');
  });

  it('creates nothing until the emailed code is verified', async () => {
    const c = client();
    const r = await c.post('/api/signup/start', studioSignup());
    assert.equal(r.status, 201);
    assert.ok(r.body.requestId);
    assert.equal((await ctx.db.one(`SELECT count(*)::int AS n FROM accounts WHERE email = 'meera@test.local'`)).n, 0);
    const code = await lastCode('meera@test.local');
    assert.match(code, /^\d{6}$/);
    assert.equal(r.body.devCode, code, 'outside production with the "log" email provider, the code is shown for testing');
    const { config } = await import('../src/config.js');
    config.isProd = true;
    const prod = await c.post('/api/signup/start', studioSignup({ email: 'prod@test.local' }));
    config.isProd = false;
    assert.equal(prod.body.devCode, undefined, 'never shown in production');
  });

  it('rejects wrong codes and limits attempts', async () => {
    const c = client();
    const r = await c.post('/api/signup/start', studioSignup({ email: 'wrong@test.local' }));
    const real = await lastCode('wrong@test.local');
    const wrong = real === '000000' ? '111111' : '000000';
    const first = await c.post('/api/signup/verify', { requestId: r.body.requestId, code: wrong });
    assert.equal(first.status, 400);
    assert.match(first.body.error, /4 attempts left/);
    for (let i = 0; i < 4; i++) await c.post('/api/signup/verify', { requestId: r.body.requestId, code: wrong });
    const locked = await c.post('/api/signup/verify', { requestId: r.body.requestId, code: real });
    assert.equal(locked.status, 429, 'even the right code is refused after 5 wrong attempts');
  });

  it('asks to wait before resending a code', async () => {
    const c = client();
    const r = await c.post('/api/signup/start', studioSignup({ email: 'resend@test.local' }));
    assert.equal((await c.post('/api/signup/resend', { requestId: r.body.requestId })).status, 429);
    await ctx.db.q(`UPDATE signup_requests SET last_sent_at = now() - interval '2 minutes' WHERE id = $1`, [r.body.requestId]);
    assert.equal((await c.post('/api/signup/resend', { requestId: r.body.requestId })).status, 200);
  });

  it('a studio sign-up gets a trial, logs in, and only sees its studio (single mode)', async () => {
    const c = client();
    const r = await c.post('/api/signup/start', studioSignup({ studioName: 'Test Studio' }));
    const v = await c.post('/api/signup/verify', { requestId: r.body.requestId, code: await lastCode('meera@test.local') });
    assert.equal(v.status, 201);
    const me = (await c.get('/api/auth/me')).body.user;
    assert.equal(me.role, 'org_admin');
    assert.equal(me.org_status, 'trial');
    assert.equal(me.org_mode, 'single');
    assert.equal(me.home_studio_id, v.body.studioId);
    const days = (new Date(me.trial_ends_at) - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days < 14.1);
    const studio = await ctx.db.one('SELECT * FROM studios WHERE id = $1', [v.body.studioId]);
    assert.equal(studio.slug, 'test-studio-2', 'gets a free web address when the name is taken');
    const acct = await ctx.db.one(`SELECT terms_version, terms_accepted_at FROM accounts WHERE email = 'meera@test.local'`);
    assert.equal(acct.terms_version, me.terms_current_version, 'consent from the sign-up checkbox is recorded');
    assert.ok(acct.terms_accepted_at);
    const org = await ctx.db.one('SELECT * FROM organizations WHERE id = $1', [v.body.orgId]);
    assert.equal(org.signup_source, 'self');
    assert.equal(org.name, 'Test Studio');
    assert.equal((await c.get(`/api/studios/${studio.id}`)).status, 200, 'can manage its studio');
    assert.equal((await c.get('/api/billing/summary')).status, 200, 'can manage billing');
    assert.equal((await c.post('/api/org/studios', { name: 'Second' })).status, 402, 'Pro allows one studio');
  });

  it('moving to the Organization plan switches on the Organization dashboard', async () => {
    const meera = await as('meera@test.local', 'Strong!pass1');
    const { org_id } = (await meera.get('/api/auth/me')).body.user;
    await ctx.db.q(`UPDATE organizations SET plan_id = 'organization' WHERE id = $1`, [org_id]);
    assert.equal((await meera.get('/api/auth/me')).body.user.org_mode, 'multi');
    assert.equal((await meera.post('/api/org/studios', { name: 'Lens & Light Films', sendInvite: false })).status, 201);
    const renamed = await meera.patch('/api/org/me', { name: 'Lens & Light Group' });
    assert.equal(renamed.body.name, 'Lens & Light Group');
  });

  it('an organization sign-up starts in multi mode on the Organization plan', async () => {
    const c = client();
    const r = await c.post('/api/signup/start', { type: 'organization', orgName: 'Big Day Group', studioName: 'Big Day Kochi', name: 'Ravi', email: 'ravi@test.local', phone: '9822233344', password: 'Strong!pass1', planId: 'organization', acceptTerms: true });
    await c.post('/api/signup/verify', { requestId: r.body.requestId, code: await lastCode('ravi@test.local') });
    const me = (await c.get('/api/auth/me')).body.user;
    assert.equal(me.org_mode, 'multi');
    assert.equal(me.org_name, 'Big Day Group');
    assert.equal(me.plan_id, 'organization');
  });

  it('can be switched off', async () => {
    // config is read once at start-up, so flip the setting on the loaded config
    const { config } = await import('../src/config.js');
    config.signup.enabled = false;
    const r = await client().post('/api/signup/start', studioSignup({ email: 'closed@test.local' }));
    assert.equal(r.status, 403);
    config.signup.enabled = true;
  });
});

describe('getting-started checklist', () => {
  it('tracks a studio from empty to done', async () => {
    const owner = await as('owner@test.local');
    const studio = await as('studio@test.local');
    const sid = ctx.fx.studio.id;
    const first = (await owner.get(`/api/studios/${sid}/onboarding`)).body;
    const ids = first.steps.map((s) => s.id);
    assert.deepEqual(ids, ['website', 'publish', 'event', 'photos', 'client', 'notify', 'domain', 'billing', 'plan']);
    assert.equal(first.steps.find((s) => s.id === 'publish').done, true, 'fixture studio is published');
    assert.equal(first.steps.find((s) => s.id === 'event').done, true, 'fixture studio has an event');
    assert.equal(first.steps.find((s) => s.id === 'photos').done, false);

    const staffView = (await studio.get(`/api/studios/${sid}/onboarding`)).body;
    assert.ok(!staffView.steps.some((s) => s.id === 'plan'), 'billing steps are only for the owner');

    await studio.put(`/api/studios/${sid}/site`, { tagline: 'Hello' });
    await uploadPhoto(studio, ctx.fx.event.id, { name: 'x.jpg', type: 'image/jpeg', buffer: await jpeg() });
    await studio.post(`/api/events/${ctx.fx.event.id}/notify-clients`);
    const after = (await owner.get(`/api/studios/${sid}/onboarding`)).body;
    for (const id of ['website', 'photos', 'client', 'notify']) assert.equal(after.steps.find((s) => s.id === id).done, true, id);
    assert.equal(after.complete, false, 'billing details still to do (the fixture organization already has an active plan)');
    assert.equal(after.steps.find((s) => s.id === 'billing').done, false);
    assert.equal(after.done, after.total - 1);
  });

  it('organization checklist', async () => {
    const owner = await as('owner@test.local');
    const r = (await owner.get('/api/org/onboarding')).body;
    assert.deepEqual(r.steps.map((s) => [s.id, s.done]), [['studio', true], ['publish', true], ['billing', false], ['plan', true]]);
  });
});

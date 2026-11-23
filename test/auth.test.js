import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, client, as, PASSWORD } from './helpers.js';

let ctx;
before(async () => (ctx = await start()));
after(stop);

describe('auth', () => {
  it('logs in with the right password and returns the user', async () => {
    const c = client();
    const r = await c.login('studio@test.local');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'studio_admin');
    assert.equal(r.body.user.password_hash, undefined, 'never returns the password hash');
    const me = await c.get('/api/auth/me');
    assert.equal(me.body.user.email, 'studio@test.local');
  });

  it('refuses a wrong password', async () => {
    const r = await client().login('studio@test.local', 'nope');
    assert.equal(r.status, 401);
  });

  it('has no sign-up or forgot-password endpoints', async () => {
    const c = client();
    assert.equal((await c.post('/api/auth/register', { email: 'x@y.z' })).status, 404);
    assert.equal((await c.post('/api/auth/forgot-password', { email: 'x@y.z' })).status, 404);
  });

  it('changes the password, keeps this session and logs out other sessions', async () => {
    const a = await as('staff@test.local');
    const b = await as('staff@test.local');
    const r = await a.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Another!2026' });
    assert.equal(r.status, 200);
    assert.equal((await a.get('/api/auth/me')).body.user.email, 'staff@test.local');
    assert.equal((await b.get('/api/auth/me')).body.user, null, 'other device is logged out');
    assert.equal((await client().login('staff@test.local', 'Another!2026')).status, 200);
    await a.post('/api/auth/change-password', { currentPassword: 'Another!2026', newPassword: PASSWORD });
  });

  it('rejects a short or unchanged new password and a wrong current password', async () => {
    const c = await as('guest@test.local');
    assert.equal((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
    assert.equal((await c.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD })).status, 400);
    assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'wrong-one', newPassword: 'Brand!New2026' })).status, 400);
  });

  it('records acceptance of the current terms, and only the current version', async () => {
    const c = await as('couple@test.local');
    const me = (await c.get('/api/auth/me')).body.user;
    assert.ok(me.terms_current_version);
    assert.equal(me.terms_version, null, 'accounts created by a studio have not accepted yet');
    assert.equal((await c.post('/api/auth/accept-terms', { version: '1999-01-01' })).status, 409);
    assert.equal((await c.post('/api/auth/accept-terms', { version: me.terms_current_version })).status, 200);
    assert.equal((await c.get('/api/auth/me')).body.user.terms_version, me.terms_current_version);
    assert.equal((await client().post('/api/auth/accept-terms', { version: me.terms_current_version })).status, 401);
  });

  it('logs out', async () => {
    const c = await as('guest@test.local');
    await c.post('/api/auth/logout');
    assert.equal((await c.get('/api/auth/me')).body.user, null);
  });
});

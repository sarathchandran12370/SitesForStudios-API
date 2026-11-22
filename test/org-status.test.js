import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client } from './helpers.js';

let ctx;
let admin;
const setStatus = (status) => admin.patch(`/api/admin/orgs/${ctx.fx.org.id}`, { status });

before(async () => {
  ctx = await start();
  admin = await as('admin@test.local');
});
after(stop);

describe('suspended and cancelled organizations (item 9)', () => {
  it('past_due keeps everything working', async () => {
    await setStatus('past_due');
    const c = await as('studio@test.local');
    assert.equal((await c.get(`/api/studios/${ctx.fx.studio.id}`)).status, 200);
    assert.equal((await c.get('/api/auth/me')).body.user.org_status, 'past_due');
    assert.equal((await client().get('/api/sites/test-studio')).status, 200);
  });

  it('suspended: login is refused with a clear message', async () => {
    await setStatus('suspended');
    for (const email of ['owner@test.local', 'studio@test.local', 'couple@test.local']) {
      const r = await client().login(email);
      assert.equal(r.status, 403, email);
      assert.match(r.body.error, /suspended/);
    }
  });

  it('suspended: an existing session is blocked except /me and logout', async () => {
    await setStatus('active');
    const c = await as('studio@test.local');
    await setStatus('suspended');
    const r = await c.get(`/api/studios/${ctx.fx.studio.id}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ORG_BLOCKED');
    assert.equal((await c.get('/api/auth/me')).status, 200);
    assert.equal((await c.post('/api/auth/logout')).status, 200);
  });

  it('suspended: the website and enquiry form are offline', async () => {
    await setStatus('suspended');
    assert.equal((await client().get('/api/sites/test-studio')).status, 404);
    const e = await client().post('/api/sites/test-studio/enquiries', { name: 'Someone', phone: '9876543210' });
    assert.equal(e.status, 404);
  });

  it('cancelled: also blocked; Super Admin is never blocked', async () => {
    await setStatus('cancelled');
    const r = await client().login('owner@test.local');
    assert.equal(r.status, 403);
    assert.match(r.body.error, /closed/);
    assert.equal((await admin.get('/api/admin/orgs')).status, 200);
  });

  it('reactivating restores access', async () => {
    await setStatus('active');
    assert.equal((await client().login('owner@test.local')).status, 200);
    assert.equal((await client().get('/api/sites/test-studio')).status, 200);
  });
});

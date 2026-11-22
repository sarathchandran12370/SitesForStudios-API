import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client } from './helpers.js';

let ctx;
before(async () => (ctx = await start()));
after(stop);

describe('role checks', () => {
  it('blocks non-admins from Super Admin endpoints', async () => {
    for (const email of ['owner@test.local', 'studio@test.local', 'couple@test.local']) {
      const c = await as(email);
      assert.equal((await c.get('/api/admin/overview')).status, 403, email);
    }
    assert.equal((await client().get('/api/admin/overview')).status, 401);
  });

  it('keeps clients out of studio management', async () => {
    const c = await as('couple@test.local');
    assert.equal((await c.get(`/api/studios/${ctx.fx.studio.id}`)).status, 403);
    assert.equal((await c.get(`/api/events/${ctx.fx.event.id}`)).status, 403);
  });

  it("keeps a studio out of another organization's studio and events", async () => {
    const admin = await as('admin@test.local');
    const created = await admin.post('/api/admin/orgs', { name: 'Other Org', planId: 'starter', ownerName: 'Other', ownerEmail: 'other@test.local', sendInvite: false });
    assert.equal(created.status, 201);
    const other = await as('other@test.local', created.body.owner.temporaryPassword);
    assert.equal((await other.get(`/api/studios/${ctx.fx.studio.id}`)).status, 403);
    assert.equal((await other.get(`/api/events/${ctx.fx.event.id}`)).status, 403);
    assert.equal((await other.get(`/api/portal/events/${ctx.fx.event.id}`)).status, 404);
  });

  it('only shows a client the events assigned to them', async () => {
    const c = await as('couple@test.local');
    const r = await c.get('/api/portal/events');
    assert.deepEqual(r.body.map((e) => e.id), [ctx.fx.event.id]);
  });

  it('does not let staff add staff', async () => {
    const c = await as('staff@test.local');
    const r = await c.post(`/api/studios/${ctx.fx.studio.id}/accounts`, { name: 'New Staff', email: 'new-staff@test.local', role: 'staff', sendInvite: false });
    assert.equal(r.status, 403);
  });

  it('enforces the plan studio limit', async () => {
    const owner = await as('owner@test.local');
    const r = await owner.post('/api/org/studios', { name: 'Second Studio' });
    assert.equal(r.status, 402, 'Pro allows 1 studio');
  });
});

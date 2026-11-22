import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, uploadPhoto, jpeg } from './helpers.js';
import { runRetention } from '../src/services/retention.js';

let ctx;
let studio;
let couple;
const DAY = 24 * 3600 * 1000;
const setExpiry = (days) => ctx.db.q(`UPDATE events SET expires_at = now() + make_interval(secs => $2) WHERE id = $1`, [ctx.fx.event.id, days * 86400]);
const event = () => ctx.db.one('SELECT * FROM events WHERE id = $1', [ctx.fx.event.id]);
const count = async (kind) => (await ctx.db.one('SELECT count(*)::int AS n FROM notifications WHERE kind = $1', [kind])).n;

before(async () => {
  ctx = await start();
  studio = await as('studio@test.local');
  couple = await as('couple@test.local');
  await uploadPhoto(studio, ctx.fx.event.id, { name: 'keep.jpg', type: 'image/jpeg', buffer: await jpeg() });
});
after(stop);

describe('event retention (item 12)', () => {
  it('does nothing for events far from expiry', async () => {
    const r = await runRetention();
    assert.deepEqual(r, { warnings: 0, archived: 0, restored: 0 });
  });

  it('sends the 30-day warning once', async () => {
    await setExpiry(20);
    assert.equal((await runRetention()).warnings, 1);
    assert.ok((await event()).warned_30_at);
    assert.equal((await runRetention()).warnings, 0, 'not repeated');
    assert.ok((await count('retention_warning')) >= 2, 'studio + couple');
  });

  it('sends the 7-day warning once', async () => {
    await setExpiry(5);
    assert.equal((await runRetention()).warnings, 1);
    assert.ok((await event()).warned_7_at);
    assert.equal((await runRetention()).warnings, 0);
  });

  it('archives at expiry: clients lose access, uploads pause', async () => {
    await setExpiry(-0.01);
    const r = await runRetention();
    assert.equal(r.archived, 1);
    const e = await event();
    assert.equal(e.status, 'archived');
    assert.ok(e.archived_at);
    assert.equal((await count('archived')) >= 1, true);

    const view = await couple.get(`/api/portal/events/${ctx.fx.event.id}`);
    assert.equal(view.status, 410);
    assert.match(view.body.error, /archived/);
    const list = await couple.get('/api/portal/events');
    assert.equal(list.body[0].status, 'archived');
    const zip = await couple.get(`/api/portal/events/${ctx.fx.event.id}/download?type=all`);
    assert.equal(zip.status, 410);

    const up = await studio.post(`/api/events/${ctx.fx.event.id}/uploads`, { files: [{ name: 'x.jpg', type: 'image/jpeg', size: 100 }] });
    assert.equal(up.status, 400);
    const notify = await studio.post(`/api/events/${ctx.fx.event.id}/notify-clients`);
    assert.equal(notify.status, 400);
  });

  it('only studio admins can restore', async () => {
    const staff = await as('staff@test.local');
    assert.equal((await staff.post(`/api/events/${ctx.fx.event.id}/restore`)).status, 403);
  });

  it('restores: back online with a new expiry, restore recorded, everyone told', async () => {
    const r = await studio.post(`/api/events/${ctx.fx.event.id}/restore`);
    assert.equal(r.status, 200);
    assert.equal(r.body.amountInr, 499);
    // Locally the restore completes right away (S3 waits for Deep Archive).
    let e;
    for (let i = 0; i < 50; i++) {
      e = await event();
      if (e.status === 'active') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal(e.status, 'active');
    const months = (new Date(e.expires_at) - Date.now()) / (30.44 * DAY);
    assert.ok(months > 5.5 && months < 6.5, `~6 months, got ${months}`);
    assert.equal(e.warned_30_at, null);
    const restore = await ctx.db.one('SELECT * FROM event_restores WHERE event_id = $1', [ctx.fx.event.id]);
    assert.equal(restore.status, 'done');
    assert.equal(restore.amount_inr, 499);
    assert.ok((await count('restored')) >= 2);
    assert.equal((await couple.get(`/api/portal/events/${ctx.fx.event.id}`)).status, 200);
  });

  it('refuses to restore an event that is not archived', async () => {
    assert.equal((await studio.post(`/api/events/${ctx.fx.event.id}/restore`)).status, 400);
  });
});

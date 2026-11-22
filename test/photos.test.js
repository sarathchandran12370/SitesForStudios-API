import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client, uploadPhoto, jpeg, fixture } from './helpers.js';
import { isHeic } from '../src/services/processing.js';

let ctx;
let studio;
before(async () => {
  ctx = await start();
  studio = await as('studio@test.local');
});
after(stop);

describe('uploads, processing and downloads (incl. HEIC, item 13)', () => {
  it('detects HEIC files by their header', async () => {
    assert.equal(isHeic(fixture('sample.heic')), true);
    assert.equal(isHeic(await jpeg(10, 10)), false);
  });

  it('processes a JPEG into thumbnail and web versions', async () => {
    const p = await uploadPhoto(studio, ctx.fx.event.id, { name: 'IMG_1.jpg', type: 'image/jpeg', buffer: await jpeg(3000, 2000) });
    assert.equal(p.status, 'ready');
    assert.equal(p.width, 3000);
    assert.equal(p.height, 2000);
    assert.ok(p.variants.thumb.endsWith('.webp') && p.variants.web.endsWith('.webp'));
  });

  it('processes an iPhone HEIC uploaded with an empty file type', async () => {
    const p = await uploadPhoto(studio, ctx.fx.event.id, { name: 'IMG_0001.HEIC', type: '', buffer: fixture('sample.heic'), ceremony: 'Reception' });
    assert.equal(p.status, 'ready', p.error);
    assert.equal(p.width, 1600);
    assert.equal(p.height, 1200);
    assert.ok(p.originalKey.endsWith('.heic'), 'the original HEIC is kept for download');
  });

  it('rejects unsupported files and RAW when RAW delivery is off', async () => {
    const r = await studio.post(`/api/events/${ctx.fx.event.id}/uploads`, { files: [{ name: 'notes.pdf', type: 'application/pdf', size: 10 }] });
    assert.equal(r.body.files[0].error, 'Unsupported file type');
    await studio.patch(`/api/events/${ctx.fx.event.id}`, { rawEnabled: false });
    const raw = await studio.post(`/api/events/${ctx.fx.event.id}/uploads`, { files: [{ name: 'A.CR3', type: '', size: 10 }] });
    assert.match(raw.body.files[0].error, /RAW/);
    await studio.patch(`/api/events/${ctx.fx.event.id}`, { rawEnabled: true });
  });

  it('refuses an upload URL with a bad signature', async () => {
    const r = await fetch(`${ctx.url}/api/uploads/studios/x/y.jpg?exp=9999999999&sig=bad`, { method: 'PUT', body: 'x' });
    assert.equal(r.status, 403);
  });

  it('lets the couple download a ZIP and RAW files, but not guests', async () => {
    await uploadPhoto(studio, ctx.fx.event.id, { name: 'IMG_1.CR3', type: '', buffer: Buffer.alloc(2048, 1) });
    const couple = await as('couple@test.local');
    const zip = await couple.get(`/api/portal/events/${ctx.fx.event.id}/download?type=all`);
    assert.equal(zip.status, 200);
    assert.equal(zip.body.subarray(0, 2).toString(), 'PK', 'a zip file');
    const raw = await couple.get(`/api/portal/events/${ctx.fx.event.id}/download?type=raw`);
    assert.equal(raw.status, 200);
    const guest = await as('guest@test.local');
    assert.equal((await guest.get(`/api/portal/events/${ctx.fx.event.id}/download?type=raw`)).status, 403);
    assert.equal((await guest.get(`/api/portal/events/${ctx.fx.event.id}/download?type=all`)).status, 200);
  });

  it('redirects a single photo download to a signed URL', async () => {
    const couple = await as('couple@test.local');
    const photos = await couple.get(`/api/portal/events/${ctx.fx.event.id}/photos`);
    const r = await couple.get(`/api/portal/photos/${photos.body[0].id}/download`);
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /\/api\/media\/.+sig=/);
  });

  it('shows highlights on the public website once marked', async () => {
    const photos = await studio.get(`/api/events/${ctx.fx.event.id}/photos`);
    await studio.patch(`/api/events/${ctx.fx.event.id}/photos`, { photoIds: photos.body.map((p) => p.id), isHighlight: true });
    const site = await client().get('/api/sites/test-studio');
    assert.equal(site.status, 200);
    assert.ok(site.body.portfolio[0].photos.length >= 2);
  });
});

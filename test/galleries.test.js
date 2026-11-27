import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { start, stop, as, client, uploadPhoto, jpeg } from './helpers.js';

let ctx;
let studio;
let couple;
let guest;
let ev;
let photos;
before(async () => {
  ctx = await start();
  ev = ctx.fx.event.id;
  studio = await as('studio@test.local');
  couple = await as('couple@test.local');
  guest = await as('guest@test.local');
  for (const [i, color] of ['#a0522d', '#336699', '#669933'].entries()) {
    await uploadPhoto(studio, ev, { name: `IMG_${i + 1}.jpg`, type: 'image/jpeg', buffer: await jpeg(1600, 1000, color) });
  }
  photos = (await couple.get(`/api/portal/events/${ev}/photos`)).body;
});
after(stop);

const fetchFollow = async (url, headers = {}) => fetch(ctx.url + url, { headers });

describe('album selection', () => {
  it('lets each client pick photos up to the limit, send them, and locks until the studio reopens', async () => {
    assert.equal((await studio.put(`/api/events/${ev}/gallery`, { selectionLimit: 2 })).status, 200);
    const add = await couple.put(`/api/portal/events/${ev}/selection`, { photoIds: [photos[0].id, photos[1].id], picked: true });
    assert.equal(add.status, 200);
    assert.equal(add.body.ids.length, 2);
    assert.equal(add.body.limit, 2);
    const over = await couple.put(`/api/portal/events/${ev}/selection`, { photoIds: [photos[2].id], picked: true });
    assert.equal(over.status, 409);

    const picked = await couple.get(`/api/portal/events/${ev}/photos?picked=1`);
    assert.equal(picked.body.length, 2);

    const sent = await couple.post(`/api/portal/events/${ev}/selection/submit`, { note: 'Album of 2' });
    assert.equal(sent.status, 200);
    assert.ok(sent.body.submittedAt);
    assert.equal((await couple.put(`/api/portal/events/${ev}/selection`, { photoIds: [photos[0].id], picked: false })).status, 409);

    const list = await studio.get(`/api/events/${ev}/selections`);
    const mine = list.body.find((c) => c.email === 'couple@test.local');
    assert.equal(mine.count, 2);
    assert.equal(mine.note, 'Album of 2');
    assert.deepEqual(mine.photos.map((p) => p.filename).sort(), ['IMG_1.jpg', 'IMG_2.jpg']);

    assert.equal((await studio.post(`/api/events/${ev}/selections/${ctx.fx.client.id}/reopen`)).status, 200);
    assert.equal((await couple.put(`/api/portal/events/${ev}/selection`, { photoIds: [photos[0].id], picked: false })).status, 200);
  });

  it('keeps guests’ picks separate and refuses picks from studio staff', async () => {
    const g = await guest.get(`/api/portal/events/${ev}/selection`);
    assert.deepEqual(g.body.ids, []);
    assert.equal((await studio.put(`/api/portal/events/${ev}/selection`, { photoIds: [photos[0].id], picked: true })).status, 403);
  });
});

describe('photo comments', () => {
  it('keeps each client’s thread private between them and the studio', async () => {
    const c = await couple.post(`/api/portal/photos/${photos[0].id}/comments`, { body: 'Please brighten this one' });
    assert.equal(c.status, 201);
    assert.equal((await guest.get(`/api/portal/photos/${photos[0].id}/comments`)).body.length, 0);

    const threads = await studio.get(`/api/events/${ev}/comments`);
    assert.equal(threads.body.length, 1);
    assert.equal(threads.body[0].awaitingReply, true);
    const reply = await studio.post(`/api/events/${ev}/photos/${photos[0].id}/comments`, { clientAccountId: ctx.fx.client.id, body: 'Done!' });
    assert.equal(reply.status, 201);
    const t = await couple.get(`/api/portal/photos/${photos[0].id}/comments`);
    assert.deepEqual(t.body.map((x) => x.from_studio), [false, true]);
    const info = await couple.get(`/api/portal/events/${ev}`);
    assert.deepEqual(info.body.commented, [photos[0].id]);
  });
});

describe('videos', () => {
  it('uploads an MP4 and shows it in the Videos tab, but rejects other video formats', async () => {
    const plan = await studio.post(`/api/events/${ev}/uploads`, { ceremony: 'Wedding', files: [{ name: 'Film.mp4', type: 'video/mp4', size: 2048 }, { name: 'clip.avi', type: 'video/x-msvideo', size: 10 }] });
    assert.match(plan.body.files[1].error, /MP4/);
    const f = plan.body.files[0];
    await fetch(ctx.url + f.upload.url, { method: 'PUT', headers: f.upload.headers, body: Buffer.alloc(2048, 7) });
    await studio.post(`/api/events/${ev}/uploads/complete`, { photoIds: [f.photoId] });
    for (let i = 0; i < 50; i++) {
      const p = await ctx.models.Photo.findById(f.photoId).lean();
      if (p.status === 'ready') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const vids = await couple.get(`/api/portal/events/${ev}/photos?videos=1`);
    assert.equal(vids.body.length, 1);
    assert.equal(vids.body[0].kind, 'video');
    assert.match(vids.body[0].src, /sig=/);
    assert.equal((await couple.get(`/api/portal/events/${ev}`)).body.videoCount, 1);
    assert.equal((await couple.get(`/api/portal/events/${ev}/download?type=videos`)).status, 200);
  });
});

describe('download protection and watermarks', () => {
  it('serves web-size JPEGs only when downloads are web size', async () => {
    await studio.put(`/api/events/${ev}/gallery`, { downloads: 'web' });
    const one = await couple.get(`/api/portal/photos/${photos[0].id}/download`);
    assert.equal(one.status, 200);
    assert.equal(one.headers.get('content-type'), 'image/jpeg');
    assert.equal((await couple.get(`/api/portal/events/${ev}/download?type=raw`)).status, 403);
    assert.equal((await couple.get(`/api/portal/events/${ev}/download?type=videos`)).status, 403);
    const zip = await couple.get(`/api/portal/events/${ev}/download?type=all`);
    assert.equal(zip.status, 200);
  });

  it('refuses every download when downloads are off', async () => {
    await studio.put(`/api/events/${ev}/gallery`, { downloads: 'none' });
    assert.equal((await couple.get(`/api/portal/photos/${photos[0].id}/download`)).status, 403);
    assert.equal((await couple.get(`/api/portal/events/${ev}/download?type=all`)).status, 403);
    assert.equal((await couple.get(`/api/portal/events/${ev}`)).body.downloads, 'none');
    await studio.put(`/api/events/${ev}/gallery`, { downloads: 'full' });
  });

  it('serves a watermarked preview when watermarks are on', async () => {
    await studio.put(`/api/events/${ev}/gallery`, { watermark: true });
    const list = await couple.get(`/api/portal/events/${ev}/photos`);
    assert.equal(list.body[0].web, `/api/portal/photos/${list.body[0].id}/preview`);
    const r = await couple.get(list.body[0].web);
    assert.equal(r.status, 302);
    const img = await fetchFollow(r.headers.get('location'));
    const buf = Buffer.from(await img.arrayBuffer());
    const plainKey = (await ctx.models.Photo.findById(list.body[0].id).lean()).variants;
    assert.ok(plainKey.wm.includes('/wm/'));
    const { channels } = await sharp(buf).stats();
    assert.ok(channels.length >= 3, 'an image');
    await studio.put(`/api/events/${ev}/gallery`, { watermark: false });
  });

  it('saves the gallery design and refuses unknown values', async () => {
    const ok = await studio.put(`/api/events/${ev}/gallery`, { design: { layout: 'grid', theme: 'dark' } });
    assert.equal(ok.body.design.layout, 'grid');
    assert.equal(ok.body.design.font, 'classic');
    assert.equal((await studio.put(`/api/events/${ev}/gallery`, { design: { layout: 'wavy' } })).status, 400);
    assert.equal((await couple.get(`/api/portal/events/${ev}`)).body.design.theme, 'dark');
  });
});

describe('guest share links', () => {
  let token;
  it('creates a link, never returns the password hash, and needs the password', async () => {
    const r = await studio.put(`/api/events/${ev}/share`, { enabled: true, password: 'mehndi2026' });
    assert.equal(r.status, 200);
    assert.equal(r.body.share_password_hash, undefined);
    assert.equal(r.body.share_has_password, true);
    token = r.body.share_token;
    assert.match(r.body.share_url, new RegExp(`/g/${token}$`));

    const anon = client();
    const locked = await anon.get(`/api/share/${token}`);
    assert.equal(locked.body.locked, true);
    assert.equal(locked.body.studio.name, 'Test Studio');
    assert.equal((await anon.get(`/api/share/${token}/photos`)).status, 401);
    assert.equal((await anon.post(`/api/share/${token}/unlock`, { password: 'wrong' })).status, 401);
  });

  it('unlocks with the password (cookie scoped to the link) and shows photos without RAW', async () => {
    const res = await fetch(`${ctx.url}/api/share/${token}/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'mehndi2026' }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie()[0];
    assert.match(cookie, new RegExp(`Path=/api/share/${token}`));
    const h = { cookie: cookie.split(';')[0] };
    const info = await (await fetchFollow(`/api/share/${token}`, h)).json();
    assert.equal(info.locked, false);
    const list = await (await fetchFollow(`/api/share/${token}/photos`, h)).json();
    assert.equal(list.length, 3);
    assert.equal((await fetchFollow(`/api/share/${token}/download?type=raw`, h)).status, 403);
    assert.equal((await fetchFollow(`/api/share/${token}/download?type=all`, h)).status, 200);

    await studio.put(`/api/events/${ev}/share`, { downloads: false });
    assert.equal((await fetchFollow(`/api/share/${token}/download?type=all`, h)).status, 403);

    // Changing the password signs guests out.
    await studio.put(`/api/events/${ev}/share`, { password: 'another1' });
    assert.equal((await fetchFollow(`/api/share/${token}/photos`, h)).status, 401);
  });

  it('stops working when turned off or regenerated', async () => {
    await studio.put(`/api/events/${ev}/share`, { password: null });
    assert.equal((await client().get(`/api/share/${token}/photos`)).status, 200);
    const re = await studio.put(`/api/events/${ev}/share`, { regenerate: true });
    assert.notEqual(re.body.share_token, token);
    assert.equal((await client().get(`/api/share/${token}`)).status, 404);
    await studio.put(`/api/events/${ev}/share`, { enabled: false });
    assert.equal((await client().get(`/api/share/${re.body.share_token}`)).status, 404);
  });
});

describe('reviews and the studio contact card', () => {
  it('shows the studio contact card in the gallery', async () => {
    const info = await couple.get(`/api/portal/events/${ev}`);
    assert.equal(info.body.studio.name, 'Test Studio');
    assert.equal(info.body.studio.whatsapp, '919800000000');
    assert.match(info.body.studio.website, /\/s\/test-studio$/);
  });

  it('publishes a client review on the website only after the studio approves it', async () => {
    const r = await couple.put(`/api/portal/events/${ev}/review`, { rating: 5, body: 'They captured every moment beautifully.' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending');
    assert.equal((await client().get('/api/sites/test-studio')).body.reviews.length, 0);

    const list = await studio.get(`/api/studios/${ctx.fx.studio.id}/reviews`);
    assert.equal(list.body.length, 1);
    await studio.patch(`/api/studios/${ctx.fx.studio.id}/reviews/${list.body[0].id}`, { status: 'published' });
    const site = await client().get('/api/sites/test-studio');
    assert.equal(site.body.reviews[0].author, 'Anu & Vivek');
    assert.equal(site.body.reviews[0].rating, 5);

    // Editing sends it back for approval.
    await couple.put(`/api/portal/events/${ev}/review`, { rating: 4, body: 'Lovely photos, a little late.' });
    assert.equal((await client().get('/api/sites/test-studio')).body.reviews.length, 0);
  });
});

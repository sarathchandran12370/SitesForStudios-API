import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client } from './helpers.js';

let ctx;
before(async () => (ctx = await start()));
after(stop);

describe('website templates', () => {
  it('lists six templates: four standard, two premium', async () => {
    const studio = await as('studio@test.local');
    const r = await studio.get('/api/studios/templates');
    const tiers = Object.fromEntries(r.body.map((t) => [t.id, t.tier]));
    assert.deepEqual(tiers, { editorial: 'standard', luxe: 'standard', boho: 'standard', grid: 'standard', cinematic: 'premium', indian: 'premium' });
  });

  it('a Pro studio can switch to Indian Traditional and the website uses it', async () => {
    const studio = await as('studio@test.local');
    const r = await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'indian', theme: { accent: '#b8862b', fontPair: 'template' } });
    assert.equal(r.status, 200);
    const site = await client().get('/api/sites/test-studio');
    assert.equal(site.body.templateId, 'indian');
    assert.equal(site.body.site.theme.fontPair, 'template');
  });

  it('website data is never served stale from the browser cache', async () => {
    const r = await client().get('/api/sites/test-studio');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  });

  it('premium templates need the Pro plan; standard ones work on Starter', async () => {
    await ctx.db.q(`UPDATE organizations SET plan_id = 'starter' WHERE id = $1`, [ctx.fx.org.id]);
    const studio = await as('studio@test.local');
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'indian' })).status, 402);
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'boho' })).status, 200);
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'grid' })).status, 200);
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'unknown' })).status, 400);
  });

  it('studios can upload their own hero and about photos', async () => {
    await ctx.db.q(`UPDATE organizations SET plan_id = 'pro' WHERE id = $1`, [ctx.fx.org.id]);
    const studio = await as('studio@test.local');
    const id = ctx.fx.studio.id;
    const up = await studio.post(`/api/studios/${id}/site-image-upload`, { contentType: 'image/jpeg' });
    assert.equal(up.status, 200);
    assert.ok(up.body.key.startsWith(`studios/${id}/site/`));
    assert.ok(up.body.upload.url);
    assert.equal((await studio.post(`/api/studios/${id}/site-image-upload`, { contentType: 'image/svg+xml' })).status, 400);

    const put = await studio.put(`/api/studios/${id}/site`, { heroImages: [{ key: up.body.key }], aboutImage: { key: up.body.key } });
    assert.equal(put.status, 200);
    const site = await client().get('/api/sites/test-studio');
    assert.equal(site.body.hero.length, 1);
    assert.ok(site.body.hero[0].includes(up.body.key));
    assert.ok(site.body.aboutImage.includes(up.body.key));

    const editor = await studio.get(`/api/studios/${id}/site`);
    assert.equal(editor.body.site.heroImages[0].key, up.body.key);
    assert.ok(editor.body.site.heroImages[0].url);

    // Back to the automatic about photo.
    assert.equal((await studio.put(`/api/studios/${id}/site`, { aboutImage: null })).status, 200);
    assert.equal((await client().get('/api/sites/test-studio')).body.aboutImage, null);
  });

  it("rejects another studio's files and images with both or neither source", async () => {
    const studio = await as('studio@test.local');
    const id = ctx.fx.studio.id;
    assert.equal((await studio.put(`/api/studios/${id}/site`, { heroImages: [{ key: 'studios/other/site/x.jpg' }] })).status, 400);
    assert.equal((await studio.put(`/api/studios/${id}/site`, { aboutImage: { key: 'studios/other/site/x.jpg' } })).status, 400);
    assert.equal((await studio.put(`/api/studios/${id}/site`, { heroImages: [{}] })).status, 400);
    assert.equal((await studio.put(`/api/studios/${id}/site`, { heroImages: [{ photoId: 'a', key: `studios/${id}/site/x.jpg` }] })).status, 400);
  });
});

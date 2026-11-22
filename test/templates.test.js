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

  it('premium templates need the Pro plan; standard ones work on Starter', async () => {
    await ctx.db.q(`UPDATE organizations SET plan_id = 'starter' WHERE id = $1`, [ctx.fx.org.id]);
    const studio = await as('studio@test.local');
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'indian' })).status, 402);
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'boho' })).status, 200);
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'grid' })).status, 200);
    assert.equal((await studio.put(`/api/studios/${ctx.fx.studio.id}/site`, { templateId: 'unknown' })).status, 400);
  });
});

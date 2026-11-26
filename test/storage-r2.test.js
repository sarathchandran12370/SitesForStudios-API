// R2 driver: signed links point at the R2 account endpoint and carry nothing R2 rejects.
// No network: signing happens locally with fake credentials.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let storage;
before(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    STORAGE_DRIVER: 'r2',
    R2_ACCOUNT_ID: 'abc123',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET: 'sfs-photos',
  });
  ({ storage } = await import('../src/services/storage.js'));
});

describe('Cloudflare R2 storage', () => {
  it('upload links are signed PUTs to the R2 endpoint, without tags or checksum headers', async () => {
    const up = await storage.uploadUrl('events/e1/originals/p1.jpg', { contentType: 'image/jpeg' });
    const u = new URL(up.url);
    assert.equal(up.method, 'PUT');
    assert.equal(u.hostname, 'sfs-photos.abc123.r2.cloudflarestorage.com');
    assert.equal(u.pathname, '/events/e1/originals/p1.jpg');
    assert.ok(u.searchParams.get('X-Amz-Signature'));
    assert.match(u.searchParams.get('X-Amz-Credential'), /^test-key\/\d{8}\/auto\/s3\/aws4_request$/);
    assert.equal(u.searchParams.get('x-amz-tagging'), null);
    assert.equal(u.searchParams.get('x-amz-sdk-checksum-algorithm'), null);
    assert.equal(u.searchParams.get('x-amz-checksum-crc32'), null);
    assert.deepEqual(up.headers, { 'Content-Type': 'image/jpeg' });
  });

  it('download links are short-lived signed GETs and can force a file name', async () => {
    const link = new URL(await storage.url('events/e1/originals/p1.jpg', { expiresIn: 900, download: 'Haldi 001.jpg' }));
    assert.equal(link.hostname, 'sfs-photos.abc123.r2.cloudflarestorage.com');
    assert.equal(link.searchParams.get('X-Amz-Expires'), '900');
    assert.equal(link.searchParams.get('response-content-disposition'), 'attachment; filename="Haldi 001.jpg"');
  });

  it('has no archive or restore functions', () => {
    for (const fn of ['archive', 'requestRestore', 'isRestored', 'unarchive']) assert.equal(storage[fn], undefined, fn);
  });
});

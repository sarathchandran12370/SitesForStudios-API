// Test harness: an isolated PostgreSQL + MongoDB test database, local file storage in a temp folder,
// the real Express app on a random port, and a small cookie-aware HTTP client per user.
// Environment is set BEFORE any app module is imported, because config is read at import time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/sitesforstudios_test';
const TEST_MONGO = process.env.TEST_MONGO_URL || 'mongodb://127.0.0.1:27017/sitesforstudios_test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DB,
  MONGO_URL: TEST_MONGO,
  JWT_SECRET: 'test-jwt-secret',
  MEDIA_SIGNING_SECRET: 'test-media-secret',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sfs-test-storage-')),
  FACE_PROVIDER: 'none',
  EMAIL_PROVIDER: 'log',
  WHATSAPP_PROVIDER: 'none',
  JOBS_CHECK_HOURS: '0',
  PROCESSING_CONCURRENCY: '1',
  APP_URL: 'http://app.test',
});
for (const k of ['ORIGIN_VERIFY_SECRET', 'DATABASE_SSL_CA', 'S3_BUCKET', 'S3_BUCKET_NAME', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) delete process.env[k];

// Silence the "log" email provider and request noise in test output.
const quiet = process.env.TEST_VERBOSE ? null : console.log;
if (quiet) console.log = () => {};

export const PASSWORD = 'Test!2026pw';

async function ensureDatabase() {
  const url = new URL(TEST_DB);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
}

let server;
let baseUrl;
let mods;

/**
 * Fresh databases + running app. Returns { url, db, fx } where fx holds fixture ids.
 * Call once per test file in before(); call stop() in after().
 */
export async function start() {
  await ensureDatabase();
  const { pool, q, one } = await import('../src/db/pg.js');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrate } = await import('../src/db/migrations.js');
  await migrate(pool, { log: () => {} });
  const { seedPlansAndTemplates } = await import('../src/db/seedBase.js');
  await seedPlansAndTemplates();

  const mongoose = (await import('mongoose')).default;
  const { connectMongo } = await import('../src/db/mongo.js');
  if (mongoose.connection.readyState !== 1) await connectMongo();
  await mongoose.connection.dropDatabase();
  const models = await import('../src/models/index.js');
  await Promise.all(Object.values(models).map((m) => m.syncIndexes?.()));

  const { createApp } = await import('../src/app.js');
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  mods = { pool, q, one, mongoose, models };
  const fx = await fixtures();
  return { url: baseUrl, db: { q, one }, models, fx };
}

export async function stop() {
  await new Promise((r) => server?.close(r));
  // Let queued photo processing settle before closing connections.
  await new Promise((r) => setTimeout(r, 200));
  await mods?.mongoose.disconnect();
  await mods?.pool.end();
  if (quiet) console.log = quiet;
}

/** Super admin, one active Pro organization with a studio, studio admin, staff, client and an event. */
async function fixtures() {
  const { one, q } = mods;
  const { hashPassword } = await import('../src/util.js');
  const hash = await hashPassword(PASSWORD);
  const admin = await one(`INSERT INTO accounts(email,name,password_hash,role,must_change_password) VALUES ('admin@test.local','Admin',$1,'super_admin',false) RETURNING *`, [hash]);
  const org = await one(`INSERT INTO organizations(name, plan_id, status) VALUES ('Test Org','pro','active') RETURNING *`);
  const studio = await one(`INSERT INTO studios(org_id,name,slug,published_at) VALUES ($1,'Test Studio','test-studio',now()) RETURNING *`, [org.id]);
  const mk = (email, name, role, extra = {}) =>
    one(
      `INSERT INTO accounts(email,name,phone,password_hash,role,org_id,studio_id,must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [email, name, extra.phone || null, hash, role, org.id, role === 'org_admin' ? null : studio.id, extra.mustChange || false]
    );
  const owner = await mk('owner@test.local', 'Owner', 'org_admin');
  const studioAdmin = await mk('studio@test.local', 'Studio Admin', 'studio_admin');
  const staff = await mk('staff@test.local', 'Staff', 'staff');
  const client = await mk('couple@test.local', 'Anu & Vivek', 'client', { phone: '9800000001' });
  const guest = await mk('guest@test.local', 'Guest', 'client');
  const event = await one(
    `INSERT INTO events(studio_id,title,event_date,venue,raw_enabled,show_in_portfolio) VALUES ($1,'Anu & Vivek','2026-12-20','Kochi',true,true) RETURNING *`,
    [studio.id]
  );
  await q(`INSERT INTO event_access(event_id,account_id,access_level) VALUES ($1,$2,'primary'),($1,$3,'guest')`, [event.id, client.id, guest.id]);
  await mods.models.SiteConfig.create({ studioId: studio.id, contact: { email: 'hello@test-studio.in', whatsapp: '919800000000' } });
  return { admin, org, studio, owner, studioAdmin, staff, client, guest, event };
}

/** Cookie-keeping HTTP client. `as(email)` logs in and returns a client for that user. */
export function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(baseUrl + p, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) if (c.startsWith('sfs_session=')) cookie = c.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : type.includes('zip') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  };
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    put: (p, b, h) => call('PUT', p, b, h),
    patch: (p, b, h) => call('PATCH', p, b, h),
    del: (p, b, h) => call('DELETE', p, b, h),
    async login(email, password = PASSWORD) {
      return call('POST', '/api/auth/login', { email, password });
    },
  };
}

export async function as(email, password) {
  const c = client();
  const r = await c.login(email, password);
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

/** Full upload flow through the API: signed URL -> PUT -> complete -> wait until processed. */
export async function uploadPhoto(c, eventId, { name, type, buffer, ceremony = 'Wedding' }) {
  const plan = await c.post(`/api/events/${eventId}/uploads`, { ceremony, files: [{ name, type, size: buffer.length }] });
  if (plan.status !== 200) throw new Error(`upload plan failed ${plan.status} ${JSON.stringify(plan.body)}`);
  const f = plan.body.files[0];
  if (f.error) throw new Error(f.error);
  const put = await fetch(baseUrl + f.upload.url, { method: 'PUT', headers: f.upload.headers, body: buffer });
  if (!put.ok) throw new Error(`PUT failed ${put.status}`);
  await c.post(`/api/events/${eventId}/uploads/complete`, { photoIds: [f.photoId] });
  const { Photo } = mods.models;
  for (let i = 0; i < 100; i++) {
    const p = await Photo.findById(f.photoId).lean();
    if (p.status === 'ready' || p.status === 'failed') return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('processing timed out');
}

export async function jpeg(width = 1200, height = 800, color = '#a0522d') {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

export const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client, uploadPhoto, jpeg } from './helpers.js';
import { normalizePhone } from '../src/services/notify.js';

let ctx;
before(async () => (ctx = await start()));
after(stop);

const sent = (kind, recipient) =>
  ctx.db.q(`SELECT * FROM notifications WHERE kind = $1 AND ($2::text IS NULL OR recipient = $2) ORDER BY created_at DESC`, [kind, recipient ?? null]);

describe('notifications (item 11)', () => {
  it('normalizes Indian phone numbers for WhatsApp', () => {
    assert.equal(normalizePhone('98470 00000'), '919847000000');
    assert.equal(normalizePhone('09847000000'), '919847000000');
    assert.equal(normalizePhone('+91 98470-00000'), '919847000000');
    assert.equal(normalizePhone('+1 415 555 0100'), '14155550100');
    assert.equal(normalizePhone('123'), null);
    assert.equal(normalizePhone(''), null);
  });

  it('emails login details when a studio creates a client', async () => {
    const studio = await as('studio@test.local');
    const r = await studio.post(`/api/studios/${ctx.fx.studio.id}/accounts`, { name: 'Priya Nair', email: 'priya@test.local', phone: '9811111111', events: [{ eventId: ctx.fx.event.id, accessLevel: 'primary' }] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.invited, { email: 'logged', whatsapp: 'skipped' });
    const [mail] = await sent('invite', 'priya@test.local');
    assert.equal(mail.status, 'logged');
    assert.match(mail.body, new RegExp(r.body.temporaryPassword), 'email contains the temporary password');
    assert.match(mail.subject, /Test Studio/);
    const [wa] = await sent('invite', '919811111111');
    assert.equal(wa.status, 'skipped', 'WhatsApp is recorded as skipped when not configured');
  });

  it('can skip the invite', async () => {
    const studio = await as('studio@test.local');
    const r = await studio.post(`/api/studios/${ctx.fx.studio.id}/accounts`, { name: 'Quiet', email: 'quiet@test.local', sendInvite: false });
    assert.equal(r.body.invited, null);
    assert.equal((await sent('invite', 'quiet@test.local')).length, 0);
  });

  it('emails a password reset with the new temporary password', async () => {
    const studio = await as('studio@test.local');
    const r = await studio.post(`/api/studios/accounts/${ctx.fx.guest.id}/reset-password`, { sendInvite: true });
    assert.equal(r.status, 200);
    const [mail] = await sent('password_reset', 'guest@test.local');
    assert.match(mail.body, new RegExp(r.body.temporaryPassword));
  });

  it('tells the studio about a new enquiry', async () => {
    const r = await client().post('/api/sites/test-studio/enquiries', { name: 'Riya & Sam', phone: '9876543210', eventDate: '2026-12-20', message: 'Two days' });
    assert.equal(r.status, 201);
    assert.equal(r.body.dateAvailable, false, 'the studio already has an event that day');
    const mails = await sent('enquiry');
    const to = mails.filter((m) => m.channel === 'email').map((m) => m.recipient).sort();
    assert.deepEqual(to, ['hello@test-studio.in', 'studio@test.local']);
    assert.match(mails.find((m) => m.channel === 'email').body, /9876543210/);
    assert.ok(mails.some((m) => m.channel === 'whatsapp' && m.recipient === '919800000000'));
  });

  it('notifies clients that photos are ready, only once there are photos', async () => {
    const studio = await as('studio@test.local');
    const empty = await studio.post(`/api/events/${ctx.fx.event.id}/notify-clients`);
    assert.equal(empty.status, 400);
    await uploadPhoto(studio, ctx.fx.event.id, { name: 'a.jpg', type: 'image/jpeg', buffer: await jpeg() });
    const r = await studio.post(`/api/events/${ctx.fx.event.id}/notify-clients`);
    assert.equal(r.status, 200);
    assert.ok(r.body.clients >= 2);
    assert.equal(r.body.emails, r.body.clients);
    const [mail] = await sent('photos_ready', 'couple@test.local');
    assert.match(mail.body, /app\.test\/portal\/events\//);
    const ev = await studio.get(`/api/events/${ctx.fx.event.id}`);
    assert.ok(ev.body.clients_notified_at);
  });

  it('lists sent messages for the Super Admin only', async () => {
    const admin = await as('admin@test.local');
    const r = await admin.get('/api/admin/notifications');
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 5);
    assert.equal((await (await as('studio@test.local')).get('/api/admin/notifications')).status, 403);
  });
});

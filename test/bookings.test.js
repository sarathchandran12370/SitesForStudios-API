import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, as, client } from './helpers.js';

let ctx;
let staff;
let sid;

before(async () => {
  ctx = await start();
  staff = await as('staff@test.local');
  sid = ctx.fx.studio.id;
});
after(stop);

const wedding = (extra = {}) => ({
  title: 'Anu & Vivek wedding',
  client: { name: 'Anu & Vivek', phone: '9800000001', email: 'couple@test.local' },
  clientAccountId: ctx.fx.client.id,
  packageAmount: 185000,
  team: [ctx.fx.staff.id],
  sessions: [
    { label: 'Haldi', date: '2027-01-14', startTime: '09:00', endTime: '12:00', venue: 'Home, Kochi' },
    { label: 'Wedding', date: '2027-01-15', startTime: '10:30', venue: 'Bolgatty Palace' },
    { label: 'Reception', date: '2027-01-15', startTime: '19:00', endTime: '01:00', venue: 'Bolgatty Palace' },
  ],
  ...extra,
});

describe('Bookings', () => {
  let main;

  it('creates a multi-day booking with sessions, team and package', async () => {
    const r = await staff.post(`/api/bookings/studio/${sid}`, wedding({ notifyClient: true }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    main = r.body;
    assert.equal(r.body.status, 'confirmed');
    assert.equal(r.body.start_date, '2027-01-14');
    assert.equal(r.body.end_date, '2027-01-15');
    assert.deepEqual(r.body.sessions.map((s) => s.label), ['Haldi', 'Wedding', 'Reception']);
    assert.equal(r.body.package_paise, 18500000);
    assert.deepEqual(r.body.team_members.map((t) => t.name), ['Staff']);
    assert.deepEqual(r.body.conflicts, []);
    assert.equal(r.body.emailed, 'logged');
    const mail = await ctx.db.one(`SELECT * FROM notifications WHERE kind = 'booking_confirmed'`);
    assert.equal(mail.recipient, 'couple@test.local');
    assert.match(mail.body, /Bolgatty Palace/);
  });

  it('shows on the calendar for any range that touches a session', async () => {
    const jan = await staff.get(`/api/bookings/studio/${sid}?from=2027-01-01&to=2027-01-31`);
    assert.equal(jan.body.bookings.length, 1);
    const dec = await staff.get(`/api/bookings/studio/${sid}?from=2026-12-01&to=2026-12-31`);
    assert.equal(dec.body.bookings.length, 0);
    assert.equal((await staff.get(`/api/bookings/studio/${sid}?from=2027-02-01&to=2027-01-01`)).status, 400);
  });

  it('warns about double bookings on the same date but still saves', async () => {
    const r = await staff.post(`/api/bookings/studio/${sid}`, wedding({ title: 'Second wedding', clientAccountId: null, team: [], client: { name: 'Riya' }, sessions: [{ label: 'Wedding', date: '2027-01-15' }] }));
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.conflicts.map((c) => c.title), ['Anu & Vivek wedding']);
    await staff.patch(`/api/bookings/${r.body.id}/status`, { status: 'cancelled' });
    assert.deepEqual((await staff.get(`/api/bookings/${main.id}`)).body.conflicts, [], 'cancelled bookings free the date');
  });

  it('the website enquiry form sees booked dates as taken, and tentative holds count', async () => {
    const taken = await client().post('/api/sites/test-studio/enquiries', { name: 'Asha', phone: '9876543210', eventDate: '2027-01-14' });
    assert.equal(taken.body.dateAvailable, false);
    const free = await client().post('/api/sites/test-studio/enquiries', { name: 'Asha', phone: '9876543210', eventDate: '2027-02-20' });
    assert.equal(free.body.dateAvailable, true);
    await staff.post(`/api/bookings/studio/${sid}`, wedding({ title: 'On hold', status: 'tentative', clientAccountId: null, team: [], client: { name: 'Hold' }, sessions: [{ label: 'Wedding', date: '2027-02-21' }] }));
    const held = await client().post('/api/sites/test-studio/enquiries', { name: 'Asha', phone: '9876543210', eventDate: '2027-02-21' });
    assert.equal(held.body.dateAvailable, false);
  });

  it('booking an enquiry marks it as booked', async () => {
    const enq = await ctx.db.one(`INSERT INTO enquiries(studio_id, name, phone, event_date) VALUES ($1,'Nila','9811111111','2027-03-05') RETURNING id`, [sid]);
    const r = await staff.post(`/api/bookings/studio/${sid}`, wedding({ title: 'Nila wedding', enquiryId: enq.id, clientAccountId: null, team: [], client: { name: 'Nila' }, sessions: [{ label: 'Wedding', date: '2027-03-05' }] }));
    assert.equal(r.status, 201);
    assert.equal((await ctx.db.one('SELECT status FROM enquiries WHERE id = $1', [enq.id])).status, 'booked');
  });

  it('editing replaces the sessions; invoices raised for the booking add up', async () => {
    const edited = await staff.put(`/api/bookings/${main.id}`, wedding({ sessions: [{ label: 'Wedding', date: '2027-01-15', startTime: '10:30' }] }));
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.start_date, '2027-01-15');
    assert.equal(edited.body.sessions.length, 1);

    const inv = await staff.post(`/api/invoices/studio/${sid}`, { bookingId: main.id, customer: { name: 'Anu & Vivek' }, lines: [{ description: 'Advance', qty: 1, rate: 50000 }] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    await staff.post(`/api/invoices/${inv.body.id}/send`, { email: false });
    await staff.post(`/api/invoices/${inv.body.id}/payments`, { amount: 20000, method: 'upi', notifyClient: false });
    const b = (await staff.get(`/api/bookings/${main.id}`)).body;
    assert.equal(b.billed_paise, 5000000);
    assert.equal(b.paid_paise, 2000000);
    assert.equal(b.invoices.length, 1);
  });

  it('checks that clients, team, events and enquiries belong to the studio', async () => {
    const bad = await staff.post(`/api/bookings/studio/${sid}`, wedding({ team: [ctx.fx.client.id] }));
    assert.equal(bad.status, 400);
    assert.equal((await staff.post(`/api/bookings/studio/${sid}`, wedding({ sessions: [] }))).status, 400);
    assert.equal((await staff.post(`/api/bookings/studio/${sid}`, wedding({ sessions: [{ label: 'X', date: '2027-1-5' }] }))).status, 400);
  });

  it('only this studio’s team can see or change its bookings', async () => {
    const couple = await as('couple@test.local');
    assert.equal((await couple.get(`/api/bookings/studio/${sid}`)).status, 403);
    const org2 = await ctx.db.one(`INSERT INTO organizations(name, plan_id, status) VALUES ('Other','pro','active') RETURNING id`);
    const s2 = await ctx.db.one(`INSERT INTO studios(org_id,name,slug) VALUES ($1,'Other Studio','other-studio') RETURNING id`, [org2.id]);
    const { hashPassword } = await import('../src/util.js');
    await ctx.db.q(`INSERT INTO accounts(email,name,password_hash,role,org_id,studio_id,must_change_password) VALUES ('other@test.local','Other',$1,'studio_admin',$2,$3,false)`, [await hashPassword('Test!2026pw'), org2.id, s2.id]);
    const other = await as('other@test.local');
    assert.equal((await other.get(`/api/bookings/${main.id}`)).status, 403);
    assert.equal((await other.del(`/api/bookings/${main.id}`)).status, 403);
    assert.equal((await other.get(`/api/bookings/studio/${sid}`)).status, 403);
  });

  it('deletes a booking', async () => {
    assert.equal((await staff.del(`/api/bookings/${main.id}`)).status, 200);
    assert.equal((await staff.get(`/api/bookings/${main.id}`)).status, 404);
  });
});

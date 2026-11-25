// Studio role: bookings on the studio's calendar. A booking can come from a website enquiry,
// have several sessions (haldi, wedding, reception), a team, a gallery event and invoices.
import { Router } from 'express';
import { z } from 'zod';
import { q, one, tx } from '../db/pg.js';
import { requireRole, studioGuard, STUDIO_MANAGERS } from '../middleware/auth.js';
import { parse, HttpError } from '../util.js';
import { notify, studioBrand } from '../services/notify.js';
import { bookingConfirmedMessage } from '../services/messages.js';
import { BOOKING_STATUSES, EVENT_TYPES, conflictsFor, bookingsInRange, loadBooking, bookingInvoices } from '../services/bookings.js';

const r = Router();
r.use(requireRole(...STUDIO_MANAGERS));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use a date like 2026-12-20');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use a time like 18:30');
const blankToNull = (s) => s.optional().nullable().or(z.literal('').transform(() => null));

const bookingSchema = z.object({
  title: z.string().min(2, 'give the booking a name').max(120),
  eventType: z.enum(EVENT_TYPES).default('wedding'),
  status: z.enum(BOOKING_STATUSES).default('confirmed'),
  client: z.object({
    name: z.string().min(1, 'enter the client’s name').max(120),
    phone: z.string().max(20).optional().default(''),
    email: blankToNull(z.string().email()),
  }),
  clientAccountId: z.string().uuid().optional().nullable(),
  enquiryId: z.string().uuid().optional().nullable(),
  eventId: z.string().uuid().optional().nullable(),
  packageAmount: z.number().min(0).max(100000000).optional().nullable(),
  team: z.array(z.string().uuid()).max(30).default([]),
  notes: z.string().max(4000).optional().default(''),
  sessions: z
    .array(
      z.object({
        label: z.string().min(1, 'name each session').max(60),
        date,
        startTime: blankToNull(time),
        endTime: blankToNull(time),
        venue: z.string().max(200).optional().default(''),
      })
    )
    .min(1, 'add at least one date')
    .max(15),
  notifyClient: z.boolean().default(false),
});

async function checkRefs(studio, b) {
  const inStudio = async (sql, id, msg) => {
    if (id && !(await one(sql, [id, studio.id]))) throw new HttpError(400, msg);
  };
  await inStudio(`SELECT 1 FROM accounts WHERE id = $1 AND studio_id = $2 AND role = 'client'`, b.clientAccountId, 'That client is not in this studio');
  await inStudio('SELECT 1 FROM enquiries WHERE id = $1 AND studio_id = $2', b.enquiryId, 'That enquiry is not in this studio');
  await inStudio('SELECT 1 FROM events WHERE id = $1 AND studio_id = $2', b.eventId, 'That event is not in this studio');
  if (b.team.length) {
    const ok = await q(`SELECT id FROM accounts WHERE id = ANY($1) AND studio_id = $2 AND role IN ('studio_admin','staff')`, [b.team, studio.id]);
    if (ok.length !== new Set(b.team).size) throw new HttpError(400, 'Only this studio’s team can be assigned');
  }
}

/** Insert or replace a booking and its sessions in one transaction. Returns the booking id. */
async function save(studio, b, userId, bookingId = null) {
  const dates = b.sessions.map((s) => s.date).sort();
  const fields = [b.title, b.eventType, b.status, b.client.name, b.client.phone || null, b.client.email || null, b.clientAccountId || null,
    b.enquiryId || null, b.eventId || null, b.packageAmount == null ? null : Math.round(b.packageAmount * 100), [...new Set(b.team)], b.notes || null, dates[0], dates.at(-1)];
  return tx(async (c) => {
    let id = bookingId;
    if (id) {
      await c.query(
        `UPDATE bookings SET title=$2, event_type=$3, status=$4, client_name=$5, client_phone=$6, client_email=$7, client_account_id=$8,
           enquiry_id=$9, event_id=$10, package_paise=$11, team=$12, notes=$13, start_date=$14, end_date=$15, updated_at=now() WHERE id=$1`,
        [id, ...fields]
      );
      await c.query('DELETE FROM booking_sessions WHERE booking_id = $1', [id]);
    } else {
      const { rows } = await c.query(
        `INSERT INTO bookings(studio_id, created_by, title, event_type, status, client_name, client_phone, client_email, client_account_id,
           enquiry_id, event_id, package_paise, team, notes, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [studio.id, userId, ...fields]
      );
      id = rows[0].id;
    }
    for (const [i, s] of b.sessions.entries()) {
      await c.query(`INSERT INTO booking_sessions(booking_id, label, date, start_time, end_time, venue, position) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        id, s.label, s.date, s.startTime || null, s.endTime || null, s.venue || null, i,
      ]);
    }
    // A booking made from an enquiry closes the enquiry as booked.
    if (b.enquiryId && b.status !== 'cancelled') await c.query(`UPDATE enquiries SET status = 'booked' WHERE id = $1`, [b.enquiryId]);
    return id;
  });
}

async function respond(studio, booking, extra = {}) {
  const dates = [...new Set(booking.sessions.map((s) => s.date))];
  const conflicts = ['tentative', 'confirmed'].includes(booking.status) ? await conflictsFor(studio.id, dates, booking.id) : [];
  return { ...booking, ...(await bookingInvoices(booking.id)), conflicts, ...extra };
}

async function confirmToClient(studio, booking, updated) {
  if (!booking.client_email || booking.status !== 'confirmed') return null;
  const msg = bookingConfirmedMessage({ brand: await studioBrand(studio.id), booking, updated });
  const out = await notify({ orgId: studio.org_id, kind: 'booking_confirmed', email: { to: booking.client_email, ...msg.email } });
  return out.email?.status || null;
}

async function bookingGuard(req, res) {
  const booking = await loadBooking(req.params.id);
  if (!booking) {
    res.status(404).json({ error: 'Booking not found' });
    return null;
  }
  const studio = await studioGuard(req, res, booking.studio_id);
  if (!studio) return null;
  return { booking, studio };
}

// Calendar: bookings with a session between from and to (default: this month).
r.get('/studio/:studioId', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  const { from, to } = parse(z.object({ from: date.optional(), to: date.optional() }), req.query);
  const now = new Date();
  const start = from || new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString().slice(0, 10);
  const end = to || new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0)).toISOString().slice(0, 10);
  if (end < start) throw new HttpError(400, '"to" is before "from"');
  if ((new Date(end) - new Date(start)) / 86400000 > 400) throw new HttpError(400, 'Ask for at most about a year at a time');
  res.json({ from: start, to: end, bookings: await bookingsInRange(studio.id, start, end) });
});

r.post('/studio/:studioId', async (req, res) => {
  const studio = await studioGuard(req, res, req.params.studioId);
  if (!studio) return;
  const b = parse(bookingSchema, req.body);
  await checkRefs(studio, b);
  const booking = await loadBooking(await save(studio, b, req.user.id));
  const emailed = b.notifyClient ? await confirmToClient(studio, booking, false) : null;
  res.status(201).json(await respond(studio, booking, { emailed }));
});

r.get('/:id', async (req, res) => {
  const g = await bookingGuard(req, res);
  if (!g) return;
  res.json(await respond(g.studio, g.booking));
});

r.put('/:id', async (req, res) => {
  const g = await bookingGuard(req, res);
  if (!g) return;
  const b = parse(bookingSchema, req.body);
  await checkRefs(g.studio, b);
  const booking = await loadBooking(await save(g.studio, b, req.user.id, g.booking.id));
  const emailed = b.notifyClient ? await confirmToClient(g.studio, booking, g.booking.status === 'confirmed') : null;
  res.json(await respond(g.studio, booking, { emailed }));
});

// Quick status change from the calendar (confirm a tentative date, mark as done, cancel).
r.patch('/:id/status', async (req, res) => {
  const g = await bookingGuard(req, res);
  if (!g) return;
  const { status, notifyClient } = parse(z.object({ status: z.enum(BOOKING_STATUSES), notifyClient: z.boolean().default(false) }), req.body);
  await q('UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1', [g.booking.id, status]);
  const booking = await loadBooking(g.booking.id);
  const emailed = notifyClient ? await confirmToClient(g.studio, booking, false) : null;
  res.json(await respond(g.studio, booking, { emailed }));
});

r.delete('/:id', async (req, res) => {
  const g = await bookingGuard(req, res);
  if (!g) return;
  await q('DELETE FROM bookings WHERE id = $1', [g.booking.id]);
  res.json({ ok: true });
});

export default r;

// Studio bookings. Shared by the studio routes (calendar) and the public enquiry form (is this date free?).
import { q, one } from '../db/pg.js';

export const BOOKING_STATUSES = ['tentative', 'confirmed', 'completed', 'cancelled'];
export const EVENT_TYPES = ['wedding', 'engagement', 'pre_wedding', 'reception', 'birthday', 'maternity', 'baby', 'corporate', 'other'];
// Bookings that hold the date: a tentative booking is a date on hold.
export const HOLDING = ['tentative', 'confirmed'];

/** True when the studio already has a tentative or confirmed session on this date. */
export async function dateTaken(studioId, date) {
  const row = await one(
    `SELECT 1 FROM booking_sessions s JOIN bookings b ON b.id = s.booking_id
     WHERE b.studio_id = $1 AND b.status = ANY($2) AND s.date = $3 LIMIT 1`,
    [studioId, HOLDING, date]
  );
  return !!row;
}

/** Other bookings holding any of these dates (for a "double booking" warning). */
export async function conflictsFor(studioId, dates, exceptBookingId = null) {
  if (!dates.length) return [];
  return q(
    `SELECT DISTINCT s.date::text AS date, b.id AS booking_id, b.title, b.status
     FROM booking_sessions s JOIN bookings b ON b.id = s.booking_id
     WHERE b.studio_id = $1 AND b.status = ANY($2) AND s.date = ANY($3::date[]) AND ($4::uuid IS NULL OR b.id <> $4)
     ORDER BY 1`,
    [studioId, HOLDING, dates, exceptBookingId]
  );
}

const SESSION_JSON = `coalesce((SELECT json_agg(json_build_object('id', s.id, 'label', s.label, 'date', s.date::text, 'start_time', s.start_time,
  'end_time', s.end_time, 'venue', s.venue) ORDER BY s.date, s.start_time NULLS FIRST, s.position) FROM booking_sessions s WHERE s.booking_id = b.id), '[]')`;

const TEAM_JSON = `coalesce((SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY a.name) FROM accounts a WHERE a.id = ANY(b.team)), '[]')`;

/** Bookings with any session between `from` and `to` (inclusive), each with its sessions and team. */
export function bookingsInRange(studioId, from, to) {
  return q(
    `SELECT b.*, b.start_date::text AS start_date, b.end_date::text AS end_date, ${SESSION_JSON} AS sessions, ${TEAM_JSON} AS team_members,
       e.title AS event_title
     FROM bookings b LEFT JOIN events e ON e.id = b.event_id
     WHERE b.studio_id = $1 AND b.start_date <= $3 AND b.end_date >= $2
       AND EXISTS (SELECT 1 FROM booking_sessions s WHERE s.booking_id = b.id AND s.date BETWEEN $2 AND $3)
     ORDER BY b.start_date, b.created_at`,
    [studioId, from, to]
  ).then((rows) => rows.map(presentBooking));
}

export async function loadBooking(id) {
  const b = await one(
    `SELECT b.*, b.start_date::text AS start_date, b.end_date::text AS end_date, ${SESSION_JSON} AS sessions, ${TEAM_JSON} AS team_members,
       e.title AS event_title
     FROM bookings b LEFT JOIN events e ON e.id = b.event_id WHERE b.id = $1`,
    [id]
  );
  return b ? presentBooking(b) : null;
}

export function presentBooking(b) {
  return { ...b, package_paise: b.package_paise === null ? null : Number(b.package_paise) };
}

/** Invoices raised for a booking, with what has been billed and paid. */
export async function bookingInvoices(bookingId) {
  const rows = await q(
    `SELECT id, number, status, total_paise, paid_paise, issue_date FROM client_invoices WHERE booking_id = $1 ORDER BY created_at`,
    [bookingId]
  );
  const list = rows.map((r) => ({ ...r, total_paise: Number(r.total_paise), paid_paise: Number(r.paid_paise) }));
  const live = list.filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  return {
    invoices: list,
    billed_paise: live.reduce((s, i) => s + i.total_paise, 0),
    paid_paise: live.reduce((s, i) => s + i.paid_paise, 0),
  };
}

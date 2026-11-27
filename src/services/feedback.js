// Album selections and photo comments, shared by the client portal (/api/portal) and the studio (/api/events).
import { q, one } from '../db/pg.js';
import { Photo } from '../models/index.js';
import { HttpError } from '../util.js';

// ---------- Album selection ----------

/** Photo ids this client picked for the album. */
export async function pickedIds(eventId, accountId) {
  return (await q('SELECT photo_id FROM photo_picks WHERE event_id = $1 AND account_id = $2 ORDER BY created_at', [eventId, accountId])).map((r) => r.photo_id);
}

/** The client's selection: picks, limit and whether it was sent to the studio. */
export async function selectionState(event, accountId) {
  const a = await one('SELECT selection_submitted_at, selection_note FROM event_access WHERE event_id = $1 AND account_id = $2', [event.id, accountId]);
  return {
    ids: await pickedIds(event.id, accountId),
    limit: event.selection_limit || null,
    submittedAt: a?.selection_submitted_at || null,
    note: a?.selection_note || '',
  };
}

/**
 * Add or remove picks. Refused once the selection is sent (the studio reopens it), and past the event's limit.
 * Only ready images of this event can be picked.
 */
export async function setPicks(event, accountId, photoIds, picked) {
  const state = await selectionState(event, accountId);
  if (state.submittedAt) throw new HttpError(409, 'Your selection was sent to the studio. Ask them to reopen it to make changes.');
  if (!picked) {
    await q('DELETE FROM photo_picks WHERE event_id = $1 AND account_id = $2 AND photo_id = ANY($3)', [event.id, accountId, photoIds]);
  } else {
    const valid = (await Photo.find({ _id: { $in: photoIds }, eventId: event.id, kind: 'image', status: 'ready' }, { _id: 1 }).lean().catch(() => [])).map((p) => String(p._id));
    const fresh = valid.filter((id) => !state.ids.includes(id));
    if (state.limit && state.ids.length + fresh.length > state.limit) {
      throw new HttpError(409, `You can pick up to ${state.limit} photos. Remove some before adding more.`);
    }
    for (const id of fresh) {
      await q('INSERT INTO photo_picks(event_id, account_id, photo_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [event.id, accountId, id]);
    }
  }
  return selectionState(event, accountId);
}

export async function submitSelection(event, accountId, note) {
  const ids = await pickedIds(event.id, accountId);
  if (!ids.length) throw new HttpError(400, 'Pick at least one photo first');
  await q('UPDATE event_access SET selection_submitted_at = now(), selection_note = $3 WHERE event_id = $1 AND account_id = $2', [event.id, accountId, note || null]);
  return selectionState(event, accountId);
}

/** Every client's selection for the studio, with file names for Lightroom / Capture One. */
export async function selectionsForStudio(event) {
  const clients = await q(
    `SELECT a.id, a.name, a.email, ea.access_level, ea.selection_submitted_at, ea.selection_note,
            (SELECT count(*) FROM photo_picks pp WHERE pp.event_id = ea.event_id AND pp.account_id = a.id)::int AS pick_count
     FROM event_access ea JOIN accounts a ON a.id = ea.account_id WHERE ea.event_id = $1 ORDER BY ea.access_level, a.name`,
    [event.id]
  );
  const out = [];
  for (const c of clients) {
    const ids = await pickedIds(event.id, c.id);
    const photos = ids.length ? await Photo.find({ _id: { $in: ids } }, { filename: 1, ceremony: 1 }).sort({ ceremony: 1, filename: 1 }).lean() : [];
    out.push({
      accountId: c.id,
      name: c.name,
      email: c.email,
      accessLevel: c.access_level,
      submittedAt: c.selection_submitted_at,
      note: c.selection_note || '',
      count: c.pick_count,
      photos: photos.map((p) => ({ id: String(p._id), filename: p.filename, ceremony: p.ceremony })),
    });
  }
  return out;
}

export async function reopenSelection(eventId, accountId) {
  const r = await q('UPDATE event_access SET selection_submitted_at = NULL WHERE event_id = $1 AND account_id = $2 RETURNING account_id', [eventId, accountId]);
  if (!r.length) throw new HttpError(404, 'Client not found on this event');
}

// ---------- Comments ----------

/** One thread: this photo, this client and the studio. */
export async function thread(eventId, photoId, clientAccountId) {
  return q(
    `SELECT c.id, c.body, c.from_studio, c.created_at, a.name AS author_name
     FROM photo_comments c LEFT JOIN accounts a ON a.id = c.author_account_id
     WHERE c.event_id = $1 AND c.photo_id = $2 AND c.client_account_id = $3 ORDER BY c.created_at`,
    [eventId, photoId, clientAccountId]
  );
}

export async function addComment({ event, photoId, clientAccountId, authorAccountId, fromStudio, body }) {
  const photo = await Photo.findOne({ _id: photoId, eventId: event.id }, { _id: 1 }).lean().catch(() => null);
  if (!photo) throw new HttpError(404, 'Photo not found');
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, 'Write a comment first');
  await q(
    `INSERT INTO photo_comments(event_id, photo_id, client_account_id, author_account_id, from_studio, body) VALUES ($1,$2,$3,$4,$5,$6)`,
    [event.id, photoId, clientAccountId, authorAccountId, !!fromStudio, text.slice(0, 2000)]
  );
  return thread(event.id, photoId, clientAccountId);
}

/** Photo ids that have comments in this client's threads (to mark them in the grid). */
export async function commentedPhotoIds(eventId, clientAccountId) {
  return (await q('SELECT DISTINCT photo_id FROM photo_comments WHERE event_id = $1 AND client_account_id = $2', [eventId, clientAccountId])).map((r) => r.photo_id);
}

/** All threads on an event for the studio, newest activity first, one entry per photo and client. */
export async function threadsForStudio(eventId) {
  const rows = await q(
    `SELECT c.photo_id, c.client_account_id, ca.name AS client_name, c.body, c.from_studio, c.created_at, au.name AS author_name
     FROM photo_comments c JOIN accounts ca ON ca.id = c.client_account_id LEFT JOIN accounts au ON au.id = c.author_account_id
     WHERE c.event_id = $1 ORDER BY c.created_at`,
    [eventId]
  );
  const map = new Map();
  for (const r of rows) {
    const k = `${r.photo_id}:${r.client_account_id}`;
    if (!map.has(k)) map.set(k, { photoId: r.photo_id, clientAccountId: r.client_account_id, clientName: r.client_name, comments: [] });
    map.get(k).comments.push({ body: r.body, fromStudio: r.from_studio, createdAt: r.created_at, authorName: r.author_name });
  }
  const threads = [...map.values()];
  for (const t of threads) {
    const last = t.comments[t.comments.length - 1];
    t.lastAt = last.createdAt;
    t.awaitingReply = !last.fromStudio;
  }
  return threads.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}

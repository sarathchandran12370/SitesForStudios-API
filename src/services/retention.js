// Event retention: warn before expiry, archive at expiry, finish restores.
// Runs every RETENTION_CHECK_HOURS from index.js; runRetention() is also callable directly (tests, Super Admin).
import { q, one } from '../db/pg.js';
import { config } from '../config.js';
import { Photo } from '../models/index.js';
import { storage } from './storage.js';
import { notify, studioBrand, studioRecipients } from './notify.js';
import { retentionWarningMessage, archivedMessage, restoredMessage } from './messages.js';
import { addRestoreAddon } from './billing.js';

const DAY = 24 * 3600 * 1000;
let running = false;

async function primaryClients(eventId) {
  return q(
    `SELECT a.name, a.email, a.phone FROM event_access ea JOIN accounts a ON a.id = ea.account_id
     WHERE ea.event_id = $1 AND ea.access_level = 'primary'`,
    [eventId]
  );
}

async function originalKeys(eventId) {
  const photos = await Photo.find({ eventId, originalKey: { $exists: true }, status: 'ready' }, { originalKey: 1, kind: 1 }).lean();
  return photos.map((p) => ({ key: p.originalKey, kind: p.kind }));
}

async function sendWarning(event, daysLeft) {
  const brand = await studioBrand(event.studio_id);
  const to = await studioRecipients(brand);
  for (const email of to.emails) {
    const msg = retentionWarningMessage({ brand, name: brand.name, event, daysLeft, forStudio: true });
    await notify({ orgId: brand.org_id, kind: 'retention_warning', email: { to: email, ...msg.email } });
  }
  for (const c of await primaryClients(event.id)) {
    const msg = retentionWarningMessage({ brand, name: c.name, event, daysLeft, forStudio: false });
    await notify({ orgId: brand.org_id, kind: 'retention_warning', email: { to: c.email, ...msg.email }, whatsapp: c.phone ? { to: c.phone, ...msg.whatsapp } : undefined });
  }
}

/** 30- and 7-day warnings. An event first seen inside 7 days only gets the 7-day one. */
async function warn(now) {
  const due = await q(
    `SELECT e.* FROM events e JOIN studios s ON s.id = e.studio_id JOIN organizations o ON o.id = s.org_id
     WHERE e.status = 'active' AND e.expires_at IS NOT NULL AND e.expires_at > $1 AND e.expires_at <= $1::timestamptz + interval '30 days'
       AND o.status NOT IN ('suspended','cancelled')
       AND (e.warned_7_at IS NULL AND (e.expires_at <= $1::timestamptz + interval '7 days' OR e.warned_30_at IS NULL))`,
    [now]
  );
  let sent = 0;
  for (const e of due) {
    const daysLeft = Math.max(1, Math.ceil((new Date(e.expires_at) - now) / DAY));
    const seven = daysLeft <= 7;
    await sendWarning(e, daysLeft);
    await q(
      seven
        ? 'UPDATE events SET warned_7_at = $2, warned_30_at = coalesce(warned_30_at, $2) WHERE id = $1'
        : 'UPDATE events SET warned_30_at = $2 WHERE id = $1',
      [e.id, now]
    );
    sent++;
  }
  return sent;
}

/** Archive expired events. An event only becomes "archived" once every file was moved; failures retry next run. */
async function archive(now) {
  const expired = await q(`SELECT * FROM events WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1`, [now]);
  let archived = 0;
  for (const e of expired) {
    let failed = 0;
    for (const { key } of await originalKeys(e.id)) {
      try {
        await storage.archive(key);
      } catch (err) {
        failed++;
        console.error('archive failed', key, err.message);
      }
    }
    if (failed) continue;
    await q(`UPDATE events SET status = 'archived', archived_at = $2 WHERE id = $1`, [e.id, now]);
    archived++;
    const brand = await studioBrand(e.studio_id);
    const to = await studioRecipients(brand);
    const msg = archivedMessage({ brand, event: e });
    for (const email of to.emails) await notify({ orgId: brand.org_id, kind: 'archived', email: { to: email, ...msg.email } });
  }
  return archived;
}

/** Restores whose files are all back: copy them to normal storage, reopen the event, tell everyone. */
async function finishRestores(now) {
  const restoring = await q(`SELECT * FROM events WHERE status = 'restoring'`);
  let restored = 0;
  for (const e of restoring) {
    const keys = await originalKeys(e.id);
    const ready = await Promise.all(keys.map(({ key }) => storage.isRestored(key).catch(() => false)));
    if (!ready.every(Boolean)) continue;
    for (const { key, kind } of keys) await storage.unarchive(key, kind === 'raw' ? 'GLACIER_IR' : 'STANDARD_IA');
    const event = await one(
      `UPDATE events SET status = 'active', archived_at = NULL, warned_30_at = NULL, warned_7_at = NULL,
         expires_at = $2::timestamptz + make_interval(months => $3)
       WHERE id = $1 RETURNING *`,
      [e.id, now, config.retention.restoreExtendsMonths]
    );
    await q(`UPDATE event_restores SET status = 'done', completed_at = $2 WHERE event_id = $1 AND status = 'pending'`, [e.id, now]);
    restored++;
    const brand = await studioBrand(e.studio_id);
    const to = await studioRecipients(brand);
    for (const email of to.emails) {
      const msg = restoredMessage({ brand, name: brand.name, event, forStudio: true });
      await notify({ orgId: brand.org_id, kind: 'restored', email: { to: email, ...msg.email } });
    }
    for (const c of await primaryClients(e.id)) {
      const msg = restoredMessage({ brand, name: c.name, event, forStudio: false });
      await notify({ orgId: brand.org_id, kind: 'restored', email: { to: c.email, ...msg.email }, whatsapp: c.phone ? { to: c.phone, ...msg.whatsapp } : undefined });
    }
  }
  return restored;
}

/** Studio asks to restore an archived event (the restore add-on). */
export async function requestEventRestore({ event, orgId, accountId }) {
  for (const { key } of await originalKeys(event.id)) await storage.requestRestore(key);
  await q(`UPDATE events SET status = 'restoring' WHERE id = $1`, [event.id]);
  const row = await one(
    `INSERT INTO event_restores(event_id, org_id, requested_by, amount_inr) VALUES ($1,$2,$3,$4) RETURNING *`,
    [event.id, orgId, accountId, config.retention.restorePriceInr]
  );
  // Bill it on the next subscription charge (Razorpay add-on). If that fails it stays "unbilled" for the Super Admin.
  await addRestoreAddon(row).catch((e) => console.error('restore add-on failed', e.message));
  // Locally (no S3) the files are already "back"; finish right away instead of waiting for the scheduler.
  if (config.storageDriver !== 's3') setImmediate(() => runRetention().catch((e) => console.error('retention', e)));
  return row;
}

export async function runRetention(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  try {
    const warnings = await warn(now);
    const archived = await archive(now);
    const restored = await finishRestores(now);
    if (warnings || archived || restored) console.log(`retention: ${warnings} warned, ${archived} archived, ${restored} restored`);
    return { warnings, archived, restored };
  } finally {
    running = false;
  }
}

export function startRetentionScheduler() {
  const hours = config.retention.checkEveryHours;
  if (!hours) return;
  const tick = () => runRetention().catch((e) => console.error('retention failed', e));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, hours * 3600 * 1000).unref();
}

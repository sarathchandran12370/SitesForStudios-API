// Free trials: reminders 7/3/1 days before the end, "expired" (read-only, billing still works) at the end,
// "suspended" when the grace period is over. Paying (billing) sets the organization back to "active".
import { q } from '../db/pg.js';
import { config } from '../config.js';
import { notify } from './notify.js';

const DAY = 24 * 3600 * 1000;
let running = false;

async function tellOwners(org, kind, subject, lines) {
  const owners = await q(`SELECT email, name FROM accounts WHERE org_id = $1 AND role = 'org_admin'`, [org.id]);
  const url = `${config.appUrl}/org/billing`;
  for (const o of owners) {
    await notify({
      orgId: org.id,
      kind,
      email: {
        to: o.email,
        subject,
        html: `<p>Hi ${o.name.split(' ')[0]},</p>${lines.map((l) => `<p>${l}</p>`).join('')}<p><a href="${url}">Choose a plan</a></p>`,
        text: [`Hi ${o.name.split(' ')[0]},`, ...lines, `Choose a plan: ${url}`].join('\n\n'),
      },
    });
  }
}

const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

export async function runTrials(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  try {
    let reminders = 0;
    const ending = await q(
      `SELECT * FROM organizations WHERE status = 'trial' AND trial_ends_at > $1 AND trial_ends_at <= $1::timestamptz + interval '7 days'`,
      [now]
    );
    for (const org of ending) {
      const daysLeft = Math.ceil((new Date(org.trial_ends_at) - now) / DAY);
      const bucket = daysLeft <= 1 ? 1 : daysLeft <= 3 ? 3 : 7;
      if (org.trial_reminder_days !== null && org.trial_reminder_days <= bucket) continue;
      await tellOwners(org, 'trial_reminder', `Your SitesForStudios trial ends in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`, [
        `Your free trial for <b>${org.name}</b> ends on ${fmt(org.trial_ends_at)}.`,
        'Choose a plan to keep your website, galleries and uploads running without interruption.',
      ]);
      await q('UPDATE organizations SET trial_reminder_days = $2 WHERE id = $1', [org.id, bucket]);
      reminders++;
    }

    const expiredRows = await q(
      `UPDATE organizations SET status = 'expired', expired_at = $1 WHERE status = 'trial' AND trial_ends_at <= $1 RETURNING *`,
      [now]
    );
    for (const org of expiredRows) {
      const graceEnd = new Date(now.getTime() + config.signup.graceDays * DAY);
      await tellOwners(org, 'trial_expired', 'Your SitesForStudios trial has ended', [
        `The free trial for <b>${org.name}</b> has ended. Your dashboard is read-only and uploads are paused.`,
        `Your website and client galleries stay online until ${fmt(graceEnd)}. Choose a plan before then to keep everything running.`,
      ]);
    }

    const suspendedRows = await q(
      `UPDATE organizations SET status = 'suspended'
       WHERE status = 'expired' AND expired_at <= $1::timestamptz - make_interval(days => $2) RETURNING *`,
      [now, config.signup.graceDays]
    );
    for (const org of suspendedRows) {
      await tellOwners(org, 'trial_suspended', 'Your SitesForStudios account is suspended', [
        `No plan was chosen for <b>${org.name}</b>, so its website and client galleries are now offline.`,
        'Your photos are kept safe. Contact us or choose a plan to bring everything back.',
      ]);
    }
    return { reminders, expired: expiredRows.length, suspended: suspendedRows.length };
  } finally {
    running = false;
  }
}

export function startTrialScheduler() {
  const hours = config.jobsEveryHours;
  if (!hours) return;
  const tick = () => runTrials().catch((e) => console.error('trials failed', e));
  setTimeout(tick, 90 * 1000).unref();
  setInterval(tick, hours * 3600 * 1000).unref();
}

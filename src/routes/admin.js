// Super Admin: plans, organizations, platform overview.
import { Router } from 'express';
import { z } from 'zod';
import { q, one, tx } from '../db/pg.js';
import { requireRole } from '../middleware/auth.js';
import { parse, tempPassword, hashPassword, HttpError } from '../util.js';
import { notify } from '../services/notify.js';
import { inviteMessage } from '../services/messages.js';
import { runRetention } from '../services/retention.js';
import { runTrials } from '../services/trials.js';
import { config } from '../config.js';

const r = Router();
r.use(requireRole('super_admin'));

r.get('/overview', async (_req, res) => {
  const [counts] = await q(`SELECT
      (SELECT count(*) FROM organizations)::int AS organizations,
      (SELECT count(*) FROM studios)::int AS studios,
      (SELECT count(*) FROM events)::int AS events,
      (SELECT coalesce(sum(storage_bytes),0) FROM events)::bigint AS storage_bytes,
      (SELECT count(*) FROM enquiries WHERE created_at > now() - interval '30 days')::int AS enquiries_30d`);
  const mrr = await one(`SELECT coalesce(sum(p.price_monthly_inr),0)::int AS mrr_inr
     FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.status = 'active'`);
  res.json({ ...counts, storage_bytes: Number(counts.storage_bytes), ...mrr });
});

r.get('/plans', async (_req, res) => res.json(await q('SELECT * FROM plans ORDER BY price_monthly_inr')));

r.put('/plans/:id', async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().min(2).max(40),
      price_monthly_inr: z.number().int().positive(),
      price_yearly_inr: z.number().int().positive(),
      storage_gb: z.number().int().positive(),
      max_studios: z.number().int().positive(),
      face_events_per_month: z.number().int().min(0),
      staff_seats: z.number().int().positive(),
      raw_delivery: z.boolean(),
      premium_templates: z.boolean(),
      retention_months: z.number().int().min(1).max(120),
      client_galleries: z.boolean().default(true),
      razorpay_plan_id: z.string().max(60).optional().nullable(),
      razorpay_plan_id_yearly: z.string().max(60).optional().nullable(),
    }),
    req.body
  );
  const row = await one(
    `UPDATE plans SET name=$2, price_monthly_inr=$3, price_yearly_inr=$4, storage_gb=$5, max_studios=$6,
       face_events_per_month=$7, staff_seats=$8, raw_delivery=$9, premium_templates=$10, retention_months=$11,
       razorpay_plan_id=$12, razorpay_plan_id_yearly=$13, client_galleries=$14
     WHERE id=$1 RETURNING *`,
    [
      req.params.id, body.name, body.price_monthly_inr, body.price_yearly_inr, body.storage_gb, body.max_studios,
      body.face_events_per_month, body.staff_seats, body.raw_delivery, body.premium_templates, body.retention_months,
      body.razorpay_plan_id || null, body.razorpay_plan_id_yearly || null, body.client_galleries,
    ]
  );
  if (!row) throw new HttpError(404, 'Plan not found');
  // Price changes apply to the next billing cycle; existing Razorpay subscriptions keep their plan until changed.
  res.json(row);
});

r.get('/orgs', async (_req, res) => {
  res.json(
    await q(`SELECT o.*, p.name AS plan_name,
        (SELECT count(*) FROM studios s WHERE s.org_id = o.id)::int AS studio_count,
        (SELECT coalesce(sum(e.storage_bytes),0) FROM events e JOIN studios s ON s.id = e.studio_id WHERE s.org_id = o.id)::bigint AS storage_bytes,
        (SELECT email FROM accounts a WHERE a.org_id = o.id AND a.role = 'org_admin' ORDER BY created_at LIMIT 1) AS owner_email
      FROM organizations o JOIN plans p ON p.id = o.plan_id ORDER BY o.created_at DESC`)
  );
});

// Create an organization together with its owner account. Returns a one-time temporary password.
r.post('/orgs', async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().min(2).max(120),
      planId: z.enum(['website', 'starter', 'pro', 'organization']),
      ownerName: z.string().min(2).max(120),
      ownerEmail: z.string().email(),
      ownerPhone: z.string().max(20).optional(),
      sendInvite: z.boolean().default(true),
    }),
    req.body
  );
  const password = tempPassword();
  const result = await tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM accounts WHERE lower(email)=lower($1)', [body.ownerEmail]);
    if (exists.rowCount) throw new HttpError(409, 'An account with this email already exists');
    const org = (
      await c.query(`INSERT INTO organizations(name, plan_id, trial_ends_at) VALUES ($1,$2, now() + make_interval(days => $3)) RETURNING *`, [body.name, body.planId, config.signup.trialDays])
    ).rows[0];
    await c.query(
      `INSERT INTO accounts(email, name, phone, password_hash, role, org_id, created_by)
       VALUES ($1,$2,$3,$4,'org_admin',$5,$6)`,
      [body.ownerEmail, body.ownerName, body.ownerPhone || null, await hashPassword(password), org.id, req.user.id]
    );
    return org;
  });
  let invited = false;
  if (body.sendInvite) {
    const msg = inviteMessage({ brand: { name: body.name }, name: body.ownerName, email: body.ownerEmail, password, role: 'org_admin' });
    const r = await notify({ orgId: result.id, kind: 'invite', email: { to: body.ownerEmail, ...msg.email }, whatsapp: body.ownerPhone ? { to: body.ownerPhone, ...msg.whatsapp } : undefined });
    invited = ['sent', 'logged'].includes(r.email?.status);
  }
  res.status(201).json({ org: result, owner: { email: body.ownerEmail, temporaryPassword: password }, invited });
});

r.patch('/orgs/:id', async (req, res) => {
  const body = parse(
    z.object({
      planId: z.enum(['website', 'starter', 'pro', 'organization']).optional(),
      status: z.enum(['trial', 'active', 'past_due', 'expired', 'suspended', 'cancelled']).optional(),
      name: z.string().min(2).max(120).optional(),
      extendTrialDays: z.number().int().min(1).max(90).optional(),
    }),
    req.body
  );
  if (body.extendTrialDays) {
    // Extending puts an expired trial back to "trial" and restarts the reminders.
    const row = await one(
      `UPDATE organizations SET status = 'trial', expired_at = NULL, trial_reminder_days = NULL,
         trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => $2)
       WHERE id = $1 AND status IN ('trial', 'expired', 'suspended') RETURNING *`,
      [req.params.id, body.extendTrialDays]
    );
    if (!row) throw new HttpError(400, 'Only trial, expired or suspended organizations can get a longer trial');
    return res.json(row);
  }
  const row = await one(
    `UPDATE organizations SET plan_id = coalesce($2, plan_id), status = coalesce($3, status), name = coalesce($4, name)
     WHERE id = $1 RETURNING *`,
    [req.params.id, body.planId ?? null, body.status ?? null, body.name ?? null]
  );
  if (!row) throw new HttpError(404, 'Organization not found');
  res.json(row);
});

// Latest invoices across all organizations.
r.get('/invoices', async (_req, res) => {
  res.json(
    await q(
      `SELECT i.id, i.number, i.issued_at, i.total_paise, i.status, o.name AS org_name
       FROM invoices i JOIN organizations o ON o.id = i.org_id ORDER BY i.issued_at DESC LIMIT 100`
    )
  );
});

// Run the retention job now (normally hourly): warnings, archiving, finished restores.
r.post('/retention/run', async (_req, res) => res.json(await runRetention()));
r.post('/trials/run', async (_req, res) => res.json(await runTrials()));

// Latest emails / WhatsApp messages across the platform (in development, "log" emails land here).
r.get('/notifications', async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  res.json(
    await q(
      `SELECT n.id, n.channel, n.recipient, n.kind, n.subject, n.status, n.error, n.created_at, o.name AS org_name
       FROM notifications n LEFT JOIN organizations o ON o.id = n.org_id ORDER BY n.created_at DESC LIMIT $1`,
      [limit]
    )
  );
});

export default r;

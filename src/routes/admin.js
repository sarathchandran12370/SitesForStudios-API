// Super Admin: plans, organizations, platform overview.
import { Router } from 'express';
import { z } from 'zod';
import { q, one, tx } from '../db/pg.js';
import { requireRole } from '../middleware/auth.js';
import { parse, tempPassword, hashPassword, HttpError } from '../util.js';

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
      price_monthly_inr: z.number().int().positive(),
      price_yearly_inr: z.number().int().positive(),
      storage_gb: z.number().int().positive(),
      max_studios: z.number().int().positive(),
      face_events_per_month: z.number().int().min(0),
      staff_seats: z.number().int().positive(),
      razorpay_plan_id: z.string().optional().nullable(),
    }),
    req.body
  );
  const row = await one(
    `UPDATE plans SET price_monthly_inr=$2, price_yearly_inr=$3, storage_gb=$4, max_studios=$5,
       face_events_per_month=$6, staff_seats=$7, razorpay_plan_id=$8 WHERE id=$1 RETURNING *`,
    [req.params.id, body.price_monthly_inr, body.price_yearly_inr, body.storage_gb, body.max_studios, body.face_events_per_month, body.staff_seats, body.razorpay_plan_id ?? null]
  );
  if (!row) throw new HttpError(404, 'Plan not found');
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
      planId: z.enum(['starter', 'pro', 'organization']),
      ownerName: z.string().min(2).max(120),
      ownerEmail: z.string().email(),
      ownerPhone: z.string().max(20).optional(),
    }),
    req.body
  );
  const password = tempPassword();
  const result = await tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM accounts WHERE lower(email)=lower($1)', [body.ownerEmail]);
    if (exists.rowCount) throw new HttpError(409, 'An account with this email already exists');
    const org = (await c.query('INSERT INTO organizations(name, plan_id) VALUES ($1,$2) RETURNING *', [body.name, body.planId])).rows[0];
    await c.query(
      `INSERT INTO accounts(email, name, phone, password_hash, role, org_id, created_by)
       VALUES ($1,$2,$3,$4,'org_admin',$5,$6)`,
      [body.ownerEmail, body.ownerName, body.ownerPhone || null, await hashPassword(password), org.id, req.user.id]
    );
    return org;
  });
  res.status(201).json({ org: result, owner: { email: body.ownerEmail, temporaryPassword: password } });
});

r.patch('/orgs/:id', async (req, res) => {
  const body = parse(
    z.object({
      planId: z.enum(['starter', 'pro', 'organization']).optional(),
      status: z.enum(['trial', 'active', 'past_due', 'suspended', 'cancelled']).optional(),
      name: z.string().min(2).max(120).optional(),
    }),
    req.body
  );
  const row = await one(
    `UPDATE organizations SET plan_id = coalesce($2, plan_id), status = coalesce($3, status), name = coalesce($4, name)
     WHERE id = $1 RETURNING *`,
    [req.params.id, body.planId ?? null, body.status ?? null, body.name ?? null]
  );
  if (!row) throw new HttpError(404, 'Organization not found');
  res.json(row);
});

export default r;

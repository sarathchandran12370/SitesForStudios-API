// Organization owner: their plan, usage and studios (partners).
import { Router } from 'express';
import { z } from 'zod';
import { q, one, tx } from '../db/pg.js';
import { requireRole } from '../middleware/auth.js';
import { SiteConfig } from '../models/index.js';
import { parse, slugify, tempPassword, hashPassword, HttpError } from '../util.js';

const r = Router();
r.use(requireRole('org_admin', 'super_admin'));

function orgIdFor(req) {
  const id = req.user.role === 'super_admin' ? req.query.orgId || req.body?.orgId : req.user.org_id;
  if (!id) throw new HttpError(400, 'orgId is required');
  return id;
}

r.get('/me', async (req, res) => {
  const orgId = orgIdFor(req);
  const org = await one(
    `SELECT o.*, row_to_json(p.*) AS plan FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`,
    [orgId]
  );
  if (!org) throw new HttpError(404, 'Organization not found');
  const usage = await one(
    `SELECT coalesce(sum(e.storage_bytes),0)::bigint AS storage_bytes, count(e.id)::int AS events
     FROM events e JOIN studios s ON s.id = e.studio_id WHERE s.org_id = $1`,
    [orgId]
  );
  res.json({ ...org, usage: { storage_bytes: Number(usage.storage_bytes), events: usage.events } });
});

r.get('/studios', async (req, res) => {
  res.json(
    await q(
      `SELECT s.*, (SELECT count(*) FROM events e WHERE e.studio_id = s.id)::int AS event_count,
         (SELECT count(*) FROM enquiries n WHERE n.studio_id = s.id AND n.status = 'new')::int AS new_enquiries
       FROM studios s WHERE s.org_id = $1 ORDER BY s.created_at`,
      [orgIdFor(req)]
    )
  );
});

// Create a studio (partner). Optionally creates a studio admin login for it.
r.post('/studios', async (req, res) => {
  const orgId = orgIdFor(req);
  const body = parse(
    z.object({
      name: z.string().min(2).max(120),
      slug: z.string().max(48).optional(),
      templateId: z.string().default('editorial'),
      adminName: z.string().min(2).max(120).optional(),
      adminEmail: z.string().email().optional(),
    }),
    req.body
  );
  const org = await one('SELECT o.*, p.max_studios FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1', [orgId]);
  if (!org) throw new HttpError(404, 'Organization not found');
  const { count } = await one('SELECT count(*)::int AS count FROM studios WHERE org_id = $1', [orgId]);
  if (count >= org.max_studios) throw new HttpError(402, `Your plan allows ${org.max_studios} studio(s). Upgrade to add more.`);

  const slug = slugify(body.slug || body.name);
  if (!slug) throw new HttpError(400, 'Invalid name');
  const password = body.adminEmail ? tempPassword() : null;

  const studio = await tx(async (c) => {
    if ((await c.query('SELECT 1 FROM studios WHERE slug=$1', [slug])).rowCount) throw new HttpError(409, `The address "${slug}" is taken`);
    const s = (
      await c.query('INSERT INTO studios(org_id, name, slug, template_id) VALUES ($1,$2,$3,$4) RETURNING *', [orgId, body.name, slug, body.templateId])
    ).rows[0];
    if (body.adminEmail) {
      if ((await c.query('SELECT 1 FROM accounts WHERE lower(email)=lower($1)', [body.adminEmail])).rowCount)
        throw new HttpError(409, 'An account with this email already exists');
      await c.query(
        `INSERT INTO accounts(email, name, password_hash, role, org_id, studio_id, created_by)
         VALUES ($1,$2,$3,'studio_admin',$4,$5,$6)`,
        [body.adminEmail, body.adminName || body.name, await hashPassword(password), orgId, s.id, req.user.id]
      );
    }
    return s;
  });
  await SiteConfig.create({
    studioId: studio.id,
    templateId: studio.template_id,
    seo: { title: `${studio.name} | Wedding Photography`, description: `${studio.name} captures weddings with a timeless, documentary style.` },
  });
  res.status(201).json({ studio, admin: body.adminEmail ? { email: body.adminEmail, temporaryPassword: password } : null });
});

export default r;

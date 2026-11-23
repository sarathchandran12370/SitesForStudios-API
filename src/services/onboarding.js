// Creating organizations + studios (self sign-up), single-studio vs organization mode, getting-started checklist.
import { q, one, tx } from '../db/pg.js';
import { config } from '../config.js';
import { SiteConfig, Photo } from '../models/index.js';
import { slugify, HttpError } from '../util.js';

/** A free web address for a studio: arjun-photography, arjun-photography-2, … */
export async function uniqueSlug(name, client = null) {
  const base = slugify(name) || 'studio';
  const run = (sql, params) => (client ? client.query(sql, params).then((r) => r.rows) : q(sql, params));
  for (let i = 1; i <= 50; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 44)}-${i}`;
    if (!(await run('SELECT 1 FROM studios WHERE slug = $1', [slug])).length) return slug;
  }
  return `${base.slice(0, 40)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Organization + first studio + owner account in one transaction, on a free trial.
 * The owner is an org_admin linked to the studio, so single-studio owners land straight in their studio.
 */
export async function createOrganizationWithStudio({ orgName, studioName, planId, owner, source = 'self' }) {
  const result = await tx(async (c) => {
    if ((await c.query('SELECT 1 FROM accounts WHERE lower(email) = lower($1)', [owner.email])).rowCount)
      throw new HttpError(409, 'An account with this email already exists. Log in instead.');
    const org = (
      await c.query(
        `INSERT INTO organizations(name, plan_id, status, trial_ends_at, signup_source)
         VALUES ($1, $2, 'trial', now() + make_interval(days => $3), $4) RETURNING *`,
        [orgName, planId, config.signup.trialDays, source]
      )
    ).rows[0];
    const slug = await uniqueSlug(studioName, c);
    const studio = (await c.query('INSERT INTO studios(org_id, name, slug, template_id) VALUES ($1,$2,$3,$4) RETURNING *', [org.id, studioName, slug, 'editorial'])).rows[0];
    const account = (
      await c.query(
        `INSERT INTO accounts(email, name, phone, password_hash, role, org_id, studio_id, must_change_password)
         VALUES ($1,$2,$3,$4,'org_admin',$5,$6,false) RETURNING *`,
        [owner.email, owner.name, owner.phone || null, owner.passwordHash, org.id, studio.id]
      )
    ).rows[0];
    return { org, studio, account };
  });
  await SiteConfig.create({
    studioId: result.studio.id,
    templateId: 'editorial',
    theme: { accent: '#9a6b3c', fontPair: 'template' },
    contact: { email: owner.email, phone: owner.phone || undefined },
    seo: { title: `${studioName} | Wedding Photography`, description: `${studioName} captures weddings with a timeless, documentary style.` },
  });
  return result;
}

/**
 * "single": only the Studio dashboard is shown (the organization works in the background).
 * "multi": the Organization dashboard is shown — the plan allows several studios, or there already are several.
 */
export async function orgMode(orgId) {
  const row = await one(
    `SELECT p.max_studios, (SELECT count(*) FROM studios s WHERE s.org_id = o.id)::int AS studios,
            (SELECT id FROM studios s WHERE s.org_id = o.id ORDER BY created_at LIMIT 1) AS first_studio
     FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`,
    [orgId]
  );
  if (!row) return { mode: 'multi', homeStudioId: null };
  return { mode: row.max_studios > 1 || row.studios > 1 ? 'multi' : 'single', homeStudioId: row.first_studio };
}

/** Getting-started steps for a studio (plus organization steps when the user owns the organization). */
export async function studioChecklist(studio, user) {
  const [site, counts, org, profile] = await Promise.all([
    SiteConfig.findOne({ studioId: studio.id }, { createdAt: 1, updatedAt: 1 }).lean(),
    one(
      `SELECT (SELECT count(*) FROM events WHERE studio_id = $1)::int AS events,
              (SELECT count(*) FROM accounts WHERE studio_id = $1 AND role = 'client')::int AS clients,
              (SELECT count(*) FROM events WHERE studio_id = $1 AND clients_notified_at IS NOT NULL)::int AS notified`,
      [studio.id]
    ),
    one('SELECT status FROM organizations WHERE id = $1', [studio.org_id]),
    one('SELECT 1 AS ok FROM billing_profiles WHERE org_id = $1', [studio.org_id]),
  ]);
  const photos = await Photo.countDocuments({ studioId: studio.id, status: 'ready' });
  const base = `/studio/${studio.id}`;
  const steps = [
    { id: 'website', label: 'Customise your website: template, logo, colours, contact details', done: !!site && site.updatedAt > site.createdAt, to: `${base}/website` },
    { id: 'publish', label: 'Publish your website', done: !!studio.published_at, to: `${base}/website` },
    { id: 'event', label: 'Create your first event', done: counts.events > 0, to: `${base}/events` },
    { id: 'photos', label: 'Upload photos to an event', done: photos > 0, to: `${base}/events` },
    { id: 'client', label: 'Add the couple as a client', done: counts.clients > 0, to: `${base}/clients` },
    { id: 'notify', label: 'Tell your clients their photos are ready', done: counts.notified > 0, to: `${base}/events` },
    { id: 'domain', label: 'Connect your own domain (optional)', done: ['verified', 'live'].includes(studio.domain_status), to: `${base}/domain`, optional: true },
  ];
  if (user.role === 'org_admin' || user.role === 'super_admin') {
    steps.push({ id: 'billing', label: 'Add billing details for GST invoices', done: !!profile, to: '/org/billing' });
    steps.push({ id: 'plan', label: 'Choose a plan', done: org?.status === 'active', to: '/org/billing' });
  }
  const required = steps.filter((s) => !s.optional);
  return { steps, done: required.filter((s) => s.done).length, total: required.length, complete: required.every((s) => s.done) };
}

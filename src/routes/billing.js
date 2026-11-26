// Billing: plans + Razorpay Checkout for organization owners, GST invoices, Razorpay webhook.
import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { one, q } from '../db/pg.js';
import { requireRole } from '../middleware/auth.js';
import { config } from '../config.js';
import { HttpError, parse } from '../util.js';
import { GST_STATES, isValidGstin, withGst } from '../services/gst.js';
import {
  razorpay,
  razorpayEnabled,
  gstEnabled,
  gstRate,
  razorpayPlanId,
  planPriceInr,
  isUpgrade,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  planForRazorpayPlan,
  createInvoiceForPayment,
  syncSubscription,
} from '../services/billing.js';
import { renderInvoiceHtml } from '../services/invoiceHtml.js';

const r = Router();

r.get('/config', (_req, res) =>
  res.json({ enabled: razorpayEnabled(), keyId: config.razorpay.keyId || null, gst: gstEnabled(), gstRate: gstRate(), states: GST_STATES })
);

const orgOf = (req) => one(`SELECT o.*, row_to_json(p.*) AS plan FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1`, [req.user.org_id]);

// Everything the billing page needs in one call.
r.get('/summary', requireRole('org_admin'), async (req, res) => {
  const org = await orgOf(req);
  const plans = await q('SELECT * FROM plans ORDER BY price_monthly_inr');
  const rate = gstRate();
  res.json({
    org: {
      id: org.id,
      name: org.name,
      status: org.status,
      planId: org.plan_id,
      cycle: org.billing_cycle,
      currentPeriodEnd: org.current_period_end,
      cancelAtPeriodEnd: org.cancel_at_period_end,
      pendingPlanId: org.pending_plan_id,
      pendingCycle: org.pending_cycle,
      hasSubscription: !!org.razorpay_subscription_id && ['active', 'past_due'].includes(org.status),
    },
    plans: plans.map((p) => ({
      ...p,
      monthlyTotalPaise: withGst(p.price_monthly_inr, rate),
      yearlyTotalPaise: withGst(p.price_yearly_inr, rate),
      payable: { monthly: !!p.razorpay_plan_id, yearly: !!p.razorpay_plan_id_yearly },
    })),
    profile: await one('SELECT * FROM billing_profiles WHERE org_id = $1', [org.id]),
    invoices: await q(
      `SELECT id, number, issued_at, total_paise, status FROM invoices WHERE org_id = $1 ORDER BY issued_at DESC LIMIT 36`,
      [org.id]
    ),
    billing: { enabled: razorpayEnabled(), keyId: config.razorpay.keyId || null, gst: gstEnabled(), gstRate: rate },
  });
});

const profileSchema = z.object({
  legalName: z.string().trim().min(2).max(150),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .optional()
    .or(z.literal(''))
    .refine((g) => !g || isValidGstin(g), 'is not a valid GSTIN'),
  address: z.string().trim().min(5).max(300),
  city: z.string().trim().min(2).max(80),
  stateCode: z.string().refine((s) => !!GST_STATES[s], 'choose a state'),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'must be a 6-digit PIN code'),
  email: z.string().trim().email(),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
});

r.put('/profile', requireRole('org_admin'), async (req, res) => {
  const p = parse(profileSchema, req.body);
  if (p.gstin && p.gstin.slice(0, 2) !== p.stateCode) throw new HttpError(400, `gstin: belongs to ${GST_STATES[p.gstin.slice(0, 2)]}, but the state chosen is ${GST_STATES[p.stateCode]}`);
  const row = await one(
    `INSERT INTO billing_profiles(org_id, legal_name, gstin, address, city, state_code, pincode, email, phone, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (org_id) DO UPDATE SET legal_name=$2, gstin=$3, address=$4, city=$5, state_code=$6, pincode=$7, email=$8, phone=$9, updated_at=now()
     RETURNING *`,
    [req.user.org_id, p.legalName, p.gstin || null, p.address, p.city, p.stateCode, p.pincode, p.email, p.phone || null]
  );
  res.json(row);
});

/**
 * Subscribe or change plan.
 * - No active subscription: create a Razorpay subscription; the browser opens Checkout with it.
 * - Active subscription: upgrades apply now, downgrades at the end of the paid period.
 */
r.post('/checkout', requireRole('org_admin'), async (req, res) => {
  if (!razorpayEnabled()) throw new HttpError(503, 'Online payments are not set up yet. Please contact SitesForStudios support.');
  const { planId, cycle } = parse(z.object({ planId: z.string(), cycle: z.enum(['monthly', 'yearly']) }), req.body);
  const org = await orgOf(req);
  const plan = await one('SELECT * FROM plans WHERE id = $1', [planId]);
  if (!plan) throw new HttpError(404, 'Plan not found');
  const rzpPlan = razorpayPlanId(plan, cycle);
  if (!rzpPlan) throw new HttpError(400, `The ${plan.name} ${cycle} plan is not available for online payment yet`);
  const profile = await one('SELECT * FROM billing_profiles WHERE org_id = $1', [org.id]);
  if (!profile) throw new HttpError(400, 'Add your billing details first (needed for the GST invoice)');

  const active = org.razorpay_subscription_id && ['active', 'past_due'].includes(org.status);
  if (active) {
    if (plan.id === org.plan_id && cycle === org.billing_cycle) throw new HttpError(400, 'You are already on this plan');
    if (org.cancel_at_period_end) throw new HttpError(400, 'Your subscription is set to cancel. Contact support to change plans.');
    const now = isUpgrade(org.plan_id, plan.id) || (plan.id === org.plan_id && cycle === 'yearly');
    const sub = await razorpay('PATCH', `/subscriptions/${org.razorpay_subscription_id}`, {
      plan_id: rzpPlan,
      schedule_change_at: now ? 'now' : 'cycle_end',
      customer_notify: 1,
    });
    if (now) await syncSubscription(sub, 'active');
    else await q('UPDATE organizations SET pending_plan_id = $2, pending_cycle = $3 WHERE id = $1', [org.id, plan.id, cycle]);
    return res.json({ changed: true, when: now ? 'now' : 'cycle_end', periodEnd: org.current_period_end });
  }

  const sub = await razorpay('POST', '/subscriptions', {
    plan_id: rzpPlan,
    total_count: cycle === 'yearly' ? 10 : 120,
    customer_notify: 1,
    notes: { org_id: org.id, plan: plan.id, cycle },
  });
  await q(
    `UPDATE organizations SET razorpay_subscription_id = $2, pending_plan_id = $3, pending_cycle = $4, cancel_at_period_end = false WHERE id = $1`,
    [org.id, sub.id, plan.id, cycle]
  );
  res.json({
    subscriptionId: sub.id,
    keyId: config.razorpay.keyId,
    name: config.billing.sellerName,
    description: `${plan.name} plan, ${cycle}`,
    amountPaise: withGst(planPriceInr(plan, cycle), gstRate()),
    prefill: { name: profile.legal_name, email: profile.email, contact: profile.phone || req.user.phone || '' },
  });
});

// After Checkout succeeds: verify the signature, activate the plan, issue the invoice.
r.post('/verify', requireRole('org_admin'), async (req, res) => {
  const body = parse(
    z.object({ razorpay_payment_id: z.string(), razorpay_subscription_id: z.string(), razorpay_signature: z.string() }),
    req.body
  );
  const org = await orgOf(req);
  if (body.razorpay_subscription_id !== org.razorpay_subscription_id) throw new HttpError(400, 'This payment is for a different subscription');
  if (!verifyCheckoutSignature(body)) throw new HttpError(400, 'Payment could not be verified');
  const [payment, sub] = await Promise.all([
    razorpay('GET', `/payments/${body.razorpay_payment_id}`),
    razorpay('GET', `/subscriptions/${body.razorpay_subscription_id}`),
  ]);
  if (!['captured', 'authorized'].includes(payment.status)) throw new HttpError(400, `Payment is ${payment.status}`);
  const mapped = await planForRazorpayPlan(sub.plan_id);
  await q(
    `UPDATE organizations SET status = 'active', plan_id = coalesce($2, plan_id), billing_cycle = coalesce($3, billing_cycle),
       current_period_end = coalesce(to_timestamp($4), current_period_end), pending_plan_id = NULL, pending_cycle = NULL, cancel_at_period_end = false
     WHERE id = $1`,
    [org.id, mapped?.plan.id || null, mapped?.cycle || null, sub.current_end || null]
  );
  const invoice = await createInvoiceForPayment({
    orgId: org.id,
    paymentId: payment.id,
    subscriptionId: sub.id,
    amountPaise: payment.amount,
    plan: mapped?.plan,
    cycle: mapped?.cycle,
    periodStart: sub.current_start ? new Date(sub.current_start * 1000) : null,
    periodEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
  });
  res.json({ ok: true, invoiceId: invoice.id, invoiceNumber: invoice.number });
});

// Cancel at the end of the paid period (access continues until then).
r.post('/cancel', requireRole('org_admin'), async (req, res) => {
  const org = await orgOf(req);
  if (!org.razorpay_subscription_id || !['active', 'past_due'].includes(org.status)) throw new HttpError(400, 'There is no active subscription');
  await razorpay('POST', `/subscriptions/${org.razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: 1 });
  await q('UPDATE organizations SET cancel_at_period_end = true WHERE id = $1', [org.id]);
  res.json({ ok: true, endsAt: org.current_period_end });
});

// Printable GST invoice (open in the browser, then Print → Save as PDF).
r.get('/invoices/:id/document', requireRole('org_admin', 'super_admin'), async (req, res) => {
  const inv = await one('SELECT * FROM invoices WHERE id = $1', [req.params.id]).catch(() => null);
  if (!inv || (req.user.role !== 'super_admin' && inv.org_id !== req.user.org_id)) throw new HttpError(404, 'Invoice not found');
  res.type('html').set('Cache-Control', 'private, no-store').send(renderInvoiceHtml(inv));
});

// Razorpay webhook: verify the signature on the raw body, keep the subscription in sync, invoice renewals.
export const webhook = [
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!verifyWebhookSignature(req.body, req.get('x-razorpay-signature'))) return res.status(400).json({ error: 'Bad signature' });
    const evt = JSON.parse(req.body.toString('utf8'));
    const sub = evt.payload?.subscription?.entity;
    if (!sub?.id) return res.json({ ok: true });
    const statusFor = {
      'subscription.activated': 'active',
      'subscription.charged': 'active',
      'subscription.resumed': 'active',
      'subscription.pending': 'past_due',
      'subscription.halted': 'past_due',
      'subscription.cancelled': 'cancelled',
      'subscription.completed': 'cancelled',
    }[evt.event];
    const org = await syncSubscription(sub, statusFor);
    if (org && ['subscription.cancelled', 'subscription.completed'].includes(evt.event)) {
      await q('UPDATE organizations SET cancel_at_period_end = false WHERE id = $1', [org.id]);
    }
    const payment = evt.payload?.payment?.entity;
    if (org && evt.event === 'subscription.charged' && payment?.id) {
      const mapped = sub.plan_id ? await planForRazorpayPlan(sub.plan_id) : null;
      await createInvoiceForPayment({
        orgId: org.id,
        paymentId: payment.id,
        subscriptionId: sub.id,
        amountPaise: payment.amount,
        plan: mapped?.plan,
        cycle: mapped?.cycle,
        periodStart: sub.current_start ? new Date(sub.current_start * 1000) : null,
        periodEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
      });
    }
    res.json({ ok: true });
  },
];

export default r;

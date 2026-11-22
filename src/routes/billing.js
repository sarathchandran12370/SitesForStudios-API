// Razorpay subscriptions. Organization owners subscribe; a webhook keeps status in sync.
import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { one, q } from '../db/pg.js';
import { requireRole } from '../middleware/auth.js';
import { config } from '../config.js';
import { HttpError } from '../util.js';

const r = Router();
const enabled = () => !!(config.razorpay.keyId && config.razorpay.keySecret);

async function razorpay(path, body) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, data?.error?.description || 'Razorpay error');
  return data;
}

r.get('/config', (_req, res) => res.json({ enabled: enabled(), keyId: config.razorpay.keyId || null }));

// Creates a Razorpay subscription for the org's plan; the browser opens Razorpay Checkout with it.
r.post('/subscribe', requireRole('org_admin'), async (req, res) => {
  if (!enabled()) throw new HttpError(503, 'Billing is not configured yet');
  const org = await one('SELECT o.*, p.razorpay_plan_id, p.name AS plan_name FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id = $1', [req.user.org_id]);
  if (!org.razorpay_plan_id) throw new HttpError(400, 'This plan is not linked to a Razorpay plan yet');
  const sub = await razorpay('/subscriptions', {
    plan_id: org.razorpay_plan_id,
    total_count: 120,
    customer_notify: 1,
    notes: { org_id: org.id },
  });
  await q('UPDATE organizations SET razorpay_subscription_id = $2 WHERE id = $1', [org.id, sub.id]);
  res.json({ subscriptionId: sub.id, keyId: config.razorpay.keyId, planName: org.plan_name });
});

// Razorpay webhook: verify signature on the raw body, then update the organization's status.
export const webhook = [
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.get('x-razorpay-signature') || '';
    const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret || 'unset').update(req.body).digest('hex');
    if (!config.razorpay.webhookSecret || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      return res.status(400).json({ error: 'Bad signature' });
    const evt = JSON.parse(req.body.toString('utf8'));
    const sub = evt.payload?.subscription?.entity;
    if (sub?.id) {
      const map = { 'subscription.activated': 'active', 'subscription.charged': 'active', 'subscription.pending': 'past_due', 'subscription.halted': 'past_due', 'subscription.cancelled': 'cancelled' };
      const status = map[evt.event];
      if (status)
        await q('UPDATE organizations SET status = $2, current_period_end = to_timestamp($3) WHERE razorpay_subscription_id = $1', [sub.id, status, sub.current_end || null]);
    }
    res.json({ ok: true });
  },
];

export default r;

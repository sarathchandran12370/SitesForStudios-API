// Razorpay subscriptions + GST invoices. Shared by the billing routes and the webhook.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, tx } from '../db/pg.js';
import { HttpError } from '../util.js';
import { GST_STATES, splitInclusive, financialYear } from './gst.js';
import { notify } from './notify.js';

const b = config.billing;
export const gstEnabled = () => !!b.sellerGstin;
export const gstRate = () => (gstEnabled() ? b.gstRatePercent : 0);
export const razorpayEnabled = () => !!(config.razorpay.keyId && config.razorpay.keySecret);

/** Call the Razorpay REST API. */
export async function razorpay(method, path, body) {
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const res = await fetch(`${config.razorpay.apiBase}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Razorpay: ${data?.error?.description || res.status}`);
  return data;
}

/** Checkout signature: HMAC-SHA256(payment_id|subscription_id, key_secret). */
export function verifyCheckoutSignature({ razorpay_payment_id, razorpay_subscription_id, razorpay_signature }) {
  const expected = crypto.createHmac('sha256', config.razorpay.keySecret).update(`${razorpay_payment_id}|${razorpay_subscription_id}`).digest('hex');
  const given = String(razorpay_signature || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret) return false;
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  const given = String(signature || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export const razorpayPlanId = (plan, cycle) => (cycle === 'yearly' ? plan.razorpay_plan_id_yearly : plan.razorpay_plan_id);
export const planPriceInr = (plan, cycle) => (cycle === 'yearly' ? plan.price_yearly_inr : plan.price_monthly_inr);

/** Our plan + cycle for a Razorpay plan id. */
export async function planForRazorpayPlan(rzpPlanId) {
  const plan = await one('SELECT * FROM plans WHERE razorpay_plan_id = $1 OR razorpay_plan_id_yearly = $1', [rzpPlanId]);
  if (!plan) return null;
  return { plan, cycle: plan.razorpay_plan_id_yearly === rzpPlanId ? 'yearly' : 'monthly' };
}

const PLAN_RANK = { website: 0, starter: 1, pro: 2, organization: 3 };
export const isUpgrade = (fromPlan, toPlan) => (PLAN_RANK[toPlan] || 0) > (PLAN_RANK[fromPlan] || 0);

async function nextInvoiceNumber(client, date) {
  const fy = financialYear(date);
  const { rows } = await client.query(
    `INSERT INTO invoice_sequences(fy, last) VALUES ($1, 1)
     ON CONFLICT (fy) DO UPDATE SET last = invoice_sequences.last + 1 RETURNING last`,
    [fy]
  );
  return `${b.invoicePrefix}/${fy}/${String(rows[0].last).padStart(4, '0')}`;
}

function sellerSnapshot() {
  return { name: b.sellerName, gstin: b.sellerGstin || null, address: b.sellerAddress, stateCode: b.sellerStateCode, state: GST_STATES[b.sellerStateCode] || '', email: b.sellerEmail };
}

/**
 * Create the invoice for one Razorpay payment (idempotent per payment id).
 * The amount actually paid is the source of truth.
 */
export async function createInvoiceForPayment({ orgId, paymentId, subscriptionId, amountPaise, plan, cycle, periodStart, periodEnd, issuedAt = new Date() }) {
  const existing = await one('SELECT * FROM invoices WHERE razorpay_payment_id = $1', [paymentId]);
  if (existing) return existing;
  const profile = await one('SELECT * FROM billing_profiles WHERE org_id = $1', [orgId]);
  const org = await one('SELECT name FROM organizations WHERE id = $1', [orgId]);
  const buyer = profile
    ? { legalName: profile.legal_name, gstin: profile.gstin, address: profile.address, city: profile.city, stateCode: profile.state_code, state: GST_STATES[profile.state_code] || '', pincode: profile.pincode, email: profile.email, phone: profile.phone }
    : { legalName: org?.name || 'Customer', gstin: null, address: '', city: '', stateCode: b.sellerStateCode, state: GST_STATES[b.sellerStateCode] || '', pincode: '', email: '' };
  const placeOfSupply = buyer.gstin ? buyer.gstin.slice(0, 2) : buyer.stateCode;
  const rate = gstRate();

  const split = splitInclusive(amountPaise, rate, b.sellerStateCode, placeOfSupply);
  const planLine = {
    description: `${plan ? `${plan.name} plan` : 'Subscription'} (${cycle === 'yearly' ? 'yearly' : 'monthly'})${periodStart && periodEnd ? `, ${fmtDay(periodStart)} to ${fmtDay(periodEnd)}` : ''}`,
    sac: b.sac,
    taxable_paise: split.taxable,
  };

  const invoice = await tx(async (client) => {
    const number = await nextInvoiceNumber(client, issuedAt);
    const { rows } = await client.query(
      `INSERT INTO invoices(org_id, number, issued_at, period_start, period_end, lines, taxable_paise, cgst_paise, sgst_paise, igst_paise,
         total_paise, gst_rate, place_of_supply, buyer, seller, razorpay_payment_id, razorpay_subscription_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (razorpay_payment_id) DO NOTHING RETURNING *`,
      [orgId, number, issuedAt, periodStart || null, periodEnd || null, JSON.stringify([planLine]), split.taxable, split.cgst, split.sgst, split.igst,
        amountPaise, rate, placeOfSupply, JSON.stringify(buyer), JSON.stringify(sellerSnapshot()), paymentId, subscriptionId || null]
    );
    if (!rows[0]) return null; // another request created it at the same moment
    return rows[0];
  });
  const inv = invoice || (await one('SELECT * FROM invoices WHERE razorpay_payment_id = $1', [paymentId]));
  if (invoice && buyer.email) {
    const url = `${config.appUrl}/org/billing`;
    await notify({
      orgId,
      kind: 'invoice',
      email: {
        to: buyer.email,
        subject: `Invoice ${inv.number} from ${b.sellerName}`,
        html: `<p>Thank you for your payment of <b>₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</b>.</p><p>Invoice <b>${inv.number}</b> is available in your billing page: <a href="${url}">${url}</a></p>`,
        text: `Thank you for your payment of Rs ${(amountPaise / 100).toFixed(2)}. Invoice ${inv.number} is available at ${url}`,
      },
    });
  }
  return inv;
}

const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Apply a Razorpay subscription entity to the organization (plan, cycle, status, period end). */
export async function syncSubscription(sub, statusOverride) {
  const org = await one('SELECT * FROM organizations WHERE razorpay_subscription_id = $1', [sub.id]);
  if (!org) return null;
  const mapped = sub.plan_id ? await planForRazorpayPlan(sub.plan_id) : null;
  const statusMap = { active: 'active', authenticated: org.status, pending: 'past_due', halted: 'past_due', cancelled: 'cancelled', completed: 'cancelled', expired: 'cancelled' };
  const status = statusOverride || statusMap[sub.status] || org.status;
  const planChanged = mapped && mapped.plan.id !== org.plan_id;
  return one(
    `UPDATE organizations SET status = $2, current_period_end = coalesce(to_timestamp($3), current_period_end),
       plan_id = coalesce($4, plan_id), billing_cycle = coalesce($5, billing_cycle),
       pending_plan_id = CASE WHEN $6::boolean THEN NULL ELSE pending_plan_id END,
       pending_cycle = CASE WHEN $6::boolean THEN NULL ELSE pending_cycle END
     WHERE id = $1 RETURNING *`,
    [org.id, status, sub.current_end || null, mapped?.plan.id || null, mapped?.cycle || null, !!planChanged || (mapped && org.pending_plan_id === mapped.plan.id)]
  );
}

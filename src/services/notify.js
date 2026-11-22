// Email + WhatsApp notifications, shared by every role's routes and the retention job.
// Every message is recorded in the `notifications` table. Sending never throws: a failure is
// recorded with status "failed" so the action that triggered it (creating a client, an enquiry…) still succeeds.
import { config } from '../config.js';
import { q, one } from '../db/pg.js';
import { SiteConfig } from '../models/index.js';

const n = config.notifications;

let ses = null;
async function sesClient() {
  if (!ses) {
    const { SESv2Client } = await import('@aws-sdk/client-sesv2');
    ses = new SESv2Client({ region: config.awsRegion });
  }
  return ses;
}

/** Indian numbers without a country code get +91. Returns digits only, or null. */
export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
}

async function record(row) {
  return one(
    `INSERT INTO notifications(org_id, channel, recipient, kind, subject, body, status, error, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7 IN ('sent','logged') THEN now() END) RETURNING id, status`,
    [row.orgId || null, row.channel, row.recipient, row.kind, row.subject || null, row.body || null, row.status, row.error || null]
  );
}

async function sendEmail({ orgId, kind, to, subject, html, text }) {
  if (!to) return null;
  if (n.emailProvider !== 'ses') {
    console.log(`[email:${kind}] to=${to} subject="${subject}"\n${text}\n`);
    return record({ orgId, channel: 'email', recipient: to, kind, subject, body: text, status: 'logged' });
  }
  try {
    const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    await (await sesClient()).send(
      new SendEmailCommand({
        FromEmailAddress: n.emailFrom,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Html: { Data: html }, Text: { Data: text } } } },
      })
    );
    return record({ orgId, channel: 'email', recipient: to, kind, subject, body: text, status: 'sent' });
  } catch (e) {
    console.error('email failed', kind, to, e.message);
    return record({ orgId, channel: 'email', recipient: to, kind, subject, body: text, status: 'failed', error: e.message });
  }
}

/** WhatsApp only allows business-initiated messages from approved templates; params fill {{1}}, {{2}}… */
async function sendWhatsApp({ orgId, kind, to, template, params, preview }) {
  const phone = normalizePhone(to);
  const templateName = n.whatsappTemplates[template];
  if (!phone) return null;
  if (n.whatsappProvider !== 'meta' || !templateName || !n.whatsappToken || !n.whatsappPhoneNumberId) {
    return record({ orgId, channel: 'whatsapp', recipient: phone, kind, subject: template, body: preview, status: 'skipped', error: 'WhatsApp not configured' });
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${n.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${n.whatsappToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: n.whatsappLanguage },
          components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }],
        },
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message || `HTTP ${res.status}`);
    return record({ orgId, channel: 'whatsapp', recipient: phone, kind, subject: template, body: preview, status: 'sent' });
  } catch (e) {
    console.error('whatsapp failed', kind, phone, e.message);
    return record({ orgId, channel: 'whatsapp', recipient: phone, kind, subject: template, body: preview, status: 'failed', error: e.message });
  }
}

/**
 * Send one message by email and/or WhatsApp.
 * @param {{orgId?:string, kind:string, email?:{to,subject,html,text}, whatsapp?:{to,template,params,preview}}} m
 * @returns {Promise<{email:object|null, whatsapp:object|null}>}
 */
export async function notify(m) {
  const [email, whatsapp] = await Promise.all([
    m.email ? sendEmail({ orgId: m.orgId, kind: m.kind, ...m.email }) : null,
    m.whatsapp ? sendWhatsApp({ orgId: m.orgId, kind: m.kind, ...m.whatsapp }) : null,
  ]);
  return { email, whatsapp };
}

/** Branding + contacts of a studio, used by the message templates. */
export async function studioBrand(studioId) {
  const studio = await one('SELECT id, org_id, name, slug FROM studios WHERE id = $1', [studioId]);
  if (!studio) return null;
  const site = await SiteConfig.findOne({ studioId }, { theme: 1, contact: 1 }).lean();
  return { ...studio, accent: site?.theme?.accent || '#9a6b3c', contact: site?.contact || {} };
}

/** People who should hear about studio business: studio admins + the website contact details. */
export async function studioRecipients(studio) {
  const admins = await q(`SELECT email, phone FROM accounts WHERE studio_id = $1 AND role = 'studio_admin'`, [studio.id]);
  const emails = [...new Set([studio.contact?.email, ...admins.map((a) => a.email)].filter(Boolean).map((e) => e.toLowerCase()))];
  const whatsapp = studio.contact?.whatsapp || studio.contact?.phone || admins.find((a) => a.phone)?.phone || null;
  return { emails, whatsapp };
}

// Message templates. Each returns { email: {subject, html, text}, whatsapp: {template, params, preview} }.
// WhatsApp template bodies must be approved in Meta Business Manager with the same {{n}} order (see DEPLOYMENT.md).
import { config } from '../config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) =>
  d ? new Date(`${String(d instanceof Date ? d.toISOString() : d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

function layout({ brand, title, paragraphs, cta, footnote }) {
  const accent = /^#[0-9a-f]{6}$/i.test(brand?.accent || '') ? brand.accent : '#9a6b3c';
  const name = esc(brand?.name || 'SitesForStudios');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f3ee;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="padding:24px 32px;border-bottom:3px solid ${accent};font-family:Georgia,serif;font-size:22px">${name}</td></tr>
<tr><td style="padding:28px 32px">
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:26px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px">${p}</p>`).join('\n')}
${cta ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:${accent};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${esc(cta.label)}</a></p>` : ''}
${footnote ? `<p style="font-size:12px;color:#78716c;line-height:1.5;margin:20px 0 0">${footnote}</p>` : ''}
</td></tr></table>
<p style="font-size:11px;color:#a8a29e;margin:16px 0 0">Sent by ${name} via SitesForStudios</p>
</td></tr></table></body></html>`;
  return html;
}

const strip = (s) => String(s).replace(/<[^>]+>/g, '');
const text = (title, paragraphs, cta, footnote) =>
  [title, '', ...paragraphs.map(strip), cta ? `${cta.label}: ${cta.url}` : '', footnote ? strip(footnote) : ''].filter((x) => x !== '').join('\n');

const loginUrl = () => `${config.appUrl}/login`;

/** Login details for a new account (client, staff, studio admin, organization owner). */
export function inviteMessage({ brand, name, email, password, role }) {
  const who = role === 'client' ? `${esc(brand.name)} has created an account for you to view and download your photos.` : `You have been given access to ${esc(brand.name)} on SitesForStudios.`;
  const title = `Welcome, ${name.split(' ')[0]}`;
  const paragraphs = [who, `Email: <b>${esc(email)}</b><br>Temporary password: <b>${esc(password)}</b>`, 'You will be asked to choose your own password the first time you log in.'];
  const cta = { label: 'Log in', url: loginUrl() };
  const footnote = 'If you did not expect this email, you can ignore it.';
  return {
    email: { subject: `Your login for ${brand.name}`, html: layout({ brand, title, paragraphs, cta, footnote }), text: text(title, paragraphs, cta, footnote) },
    whatsapp: { template: 'invite', params: [name, brand.name, loginUrl(), email, password], preview: `Login for ${brand.name}: ${email} / temporary password` },
  };
}

export function passwordResetMessage({ brand, name, email, password }) {
  const title = 'Your password was reset';
  const paragraphs = [`${esc(brand.name)} reset the password for your account.`, `Email: <b>${esc(email)}</b><br>Temporary password: <b>${esc(password)}</b>`, 'Log in and choose a new password. You have been logged out of other devices.'];
  const cta = { label: 'Log in', url: loginUrl() };
  return {
    email: { subject: `New temporary password for ${brand.name}`, html: layout({ brand, title, paragraphs, cta }), text: text(title, paragraphs, cta) },
    whatsapp: { template: 'invite', params: [name, brand.name, loginUrl(), email, password], preview: `Password reset for ${brand.name}` },
  };
}

export function photosReadyMessage({ brand, name, event, photoCount }) {
  const url = `${config.appUrl}/portal/events/${event.id}`;
  const title = 'Your photos are ready';
  const paragraphs = [
    `Hi ${esc(name.split(' ')[0])},`,
    `${photoCount} photos from <b>${esc(event.title)}</b>${event.event_date ? ` (${fmtDate(event.event_date)})` : ''} are ready to view and download in full resolution.`,
  ];
  const cta = { label: 'View your photos', url };
  return {
    email: { subject: `Your photos from ${event.title} are ready`, html: layout({ brand, title, paragraphs, cta }), text: text(title, paragraphs, cta) },
    whatsapp: { template: 'photosReady', params: [name, event.title, brand.name, url], preview: `Photos ready: ${event.title}` },
  };
}

export function enquiryMessage({ brand, enquiry }) {
  const url = `${config.appUrl}/studio/${brand.id}/enquiries`;
  const title = `New enquiry from ${enquiry.name}`;
  const details = [
    `Phone: <b>${esc(enquiry.phone)}</b>`,
    enquiry.email && `Email: ${esc(enquiry.email)}`,
    enquiry.event_date && `Date: ${fmtDate(enquiry.event_date)}${enquiry.date_available === false ? ' (you already have an event that day)' : ''}`,
    enquiry.city && `Venue / city: ${esc(enquiry.city)}`,
    enquiry.event_type && `Event: ${esc(enquiry.event_type)}`,
    enquiry.budget && `Budget: ${esc(enquiry.budget)}`,
  ].filter(Boolean);
  const paragraphs = [details.join('<br>'), enquiry.message ? `“${esc(enquiry.message)}”` : ''].filter(Boolean);
  const cta = { label: 'Open enquiries', url };
  return {
    email: { subject: `New enquiry: ${enquiry.name}${enquiry.event_date ? `, ${fmtDate(enquiry.event_date)}` : ''}`, html: layout({ brand, title, paragraphs, cta }), text: text(title, paragraphs, cta) },
    whatsapp: { template: 'enquiry', params: [enquiry.name, enquiry.phone, enquiry.event_date ? fmtDate(enquiry.event_date) : 'not given', url], preview: `Enquiry from ${enquiry.name}` },
  };
}

/** Sent to the studio and the couple N days before an event is archived. */
export function retentionWarningMessage({ brand, name, event, daysLeft, forStudio }) {
  const url = forStudio ? `${config.appUrl}/events/${event.id}` : `${config.appUrl}/portal/events/${event.id}`;
  const title = `${daysLeft} days left to download`;
  const paragraphs = forStudio
    ? [`The gallery <b>${esc(event.title)}</b> will be archived on ${fmtDate(event.expires_at)}. Clients will no longer be able to view or download it.`, 'To keep it online longer, upgrade your plan or restore it later from the event page.']
    : [`Hi ${esc(name.split(' ')[0])},`, `Your gallery <b>${esc(event.title)}</b> will be archived on ${fmtDate(event.expires_at)}. Please download any photos you want to keep before then.`];
  const cta = { label: forStudio ? 'Open event' : 'Download your photos', url };
  return {
    email: { subject: `${event.title}: gallery will be archived in ${daysLeft} days`, html: layout({ brand, title, paragraphs, cta }), text: text(title, paragraphs, cta) },
    whatsapp: { template: 'retention', params: [name, event.title, fmtDate(event.expires_at), url], preview: `${event.title} archives in ${daysLeft} days` },
  };
}

export function archivedMessage({ brand, event }) {
  const url = `${config.appUrl}/events/${event.id}`;
  const title = 'Gallery archived';
  const paragraphs = [
    `<b>${esc(event.title)}</b> reached the end of its retention period and has been archived. Clients can no longer view or download it.`,
    `You can restore it from the event page for ₹${config.retention.restorePriceInr}. Restoring takes up to 12 hours and keeps it online for ${config.retention.restoreExtendsMonths} more months.`,
  ];
  const cta = { label: 'Open event', url };
  return { email: { subject: `${event.title} has been archived`, html: layout({ brand, title, paragraphs, cta }), text: text(title, paragraphs, cta) } };
}

export function restoredMessage({ brand, name, event, forStudio }) {
  const url = forStudio ? `${config.appUrl}/events/${event.id}` : `${config.appUrl}/portal/events/${event.id}`;
  const title = 'Gallery available again';
  const paragraphs = [
    forStudio ? `<b>${esc(event.title)}</b> has been restored.` : `Hi ${esc(name.split(' ')[0])}, your gallery <b>${esc(event.title)}</b> is available again.`,
    `It stays online until ${fmtDate(event.expires_at)}.`,
  ];
  const cta = { label: forStudio ? 'Open event' : 'View your photos', url };
  return {
    email: { subject: `${event.title} is available again`, html: layout({ brand, title, paragraphs, cta }), text: text(title, paragraphs, cta) },
    whatsapp: { template: 'photosReady', params: [name, event.title, brand.name, url], preview: `Restored: ${event.title}` },
  };
}

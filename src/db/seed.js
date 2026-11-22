// Seeds plans, templates and the super admin. With --demo, also creates a demo organization,
// studio, staff login, client login and an event with generated sample photos.
import sharp from 'sharp';
import { pool, one, q } from './pg.js';
import { connectMongo } from './mongo.js';
import mongoose from 'mongoose';
import { SiteConfig, Photo } from '../models/index.js';
import { hashPassword } from '../util.js';
import { processPhoto } from '../services/processing.js';
import { storage } from '../services/storage.js';

const plans = [
  ['starter', 'Starter', 3499, 34990, 500, 1, 3, 1, false, false, 12],
  ['pro', 'Pro', 6999, 69990, 1536, 1, 8, 3, true, true, 24],
  ['organization', 'Organization', 14999, 149990, 4096, 3, 20, 10, true, true, 36],
];
for (const p of plans) {
  await q(
    `INSERT INTO plans(id, name, price_monthly_inr, price_yearly_inr, storage_gb, max_studios, face_events_per_month, staff_seats, raw_delivery, premium_templates, retention_months)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    p
  );
}

const templates = [
  ['editorial', 'Editorial Minimal', 'Clean white space, serif headlines and a story-led portfolio.', 'standard'],
  ['luxe', 'Classic Luxe', 'Ivory and gold tones with elegant script accents for traditional weddings.', 'standard'],
  ['cinematic', 'Dark Cinematic', 'Full-bleed imagery on a dark canvas, made for films and dramatic photos.', 'premium'],
];
for (const t of templates) {
  await q(
    `INSERT INTO templates(id, name, description, tier) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, tier = EXCLUDED.tier`,
    t
  );
}

const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@sitesforstudios.local';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe!2026';
if (!(await one('SELECT 1 FROM accounts WHERE email = $1', [adminEmail]))) {
  await q(`INSERT INTO accounts(email, name, password_hash, role, must_change_password) VALUES ($1,'Platform Admin',$2,'super_admin',false)`, [
    adminEmail,
    await hashPassword(adminPassword),
  ]);
  console.log(`super admin: ${adminEmail} / ${adminPassword}`);
}

if (process.argv.includes('--demo')) await seedDemo();

console.log('seed complete');
await pool.end();
await mongoose.disconnect();

async function seedDemo() {
  await connectMongo();
  if (await one(`SELECT 1 FROM studios WHERE slug = 'arjun-photography'`)) {
    console.log('demo data already present');
    return;
  }
  const org = await one(`INSERT INTO organizations(name, plan_id, status) VALUES ('Arjun Creative Group','pro','active') RETURNING *`);
  const studio = await one(`INSERT INTO studios(org_id, name, slug, template_id, published_at) VALUES ($1,'Arjun Photography','arjun-photography','editorial', now()) RETURNING *`, [org.id]);
  const pw = await hashPassword('Demo!2026');
  await q(`INSERT INTO accounts(email, name, password_hash, role, org_id, must_change_password) VALUES ('owner@demo.local','Arjun Menon',$1,'org_admin',$2,false)`, [pw, org.id]);
  await q(`INSERT INTO accounts(email, name, password_hash, role, org_id, studio_id, must_change_password) VALUES ('studio@demo.local','Arjun (Studio)',$1,'studio_admin',$2,$3,false)`, [pw, org.id, studio.id]);
  const client = await one(
    `INSERT INTO accounts(email, name, password_hash, role, org_id, studio_id, must_change_password) VALUES ('couple@demo.local','Anjali & Rahul',$1,'client',$2,$3,false) RETURNING *`,
    [pw, org.id, studio.id]
  );
  const event = await one(
    `INSERT INTO events(studio_id, title, event_date, venue, raw_enabled, show_in_portfolio, expires_at)
     VALUES ($1,'Anjali & Rahul','2026-11-08','Kumarakom Lake Resort, Kerala', true, true, now() + interval '24 months') RETURNING *`,
    [studio.id]
  );
  await q(`INSERT INTO event_access(event_id, account_id, access_level) VALUES ($1,$2,'primary')`, [event.id, client.id]);

  await SiteConfig.create({
    studioId: studio.id,
    templateId: 'editorial',
    tagline: 'Wedding stories from Kerala and beyond',
    about: 'We are a small team of photographers and filmmakers who love quiet moments, big celebrations and everything in between. Based in Kochi, we travel across India for weddings.',
    theme: { accent: '#9a6b3c', fontPair: 'editorial' },
    packages: [
      { name: 'Essential', price: '₹85,000', features: ['1 day, 1 photographer', '400+ edited photos', 'Online gallery'] },
      { name: 'Signature', price: '₹1,60,000', features: ['2 days, 2 photographers', 'Highlight film', 'Premium album'] },
      { name: 'Grand', price: '₹2,75,000', features: ['3 days, full team', 'Cinematic film + teaser', 'Two albums, drone'] },
    ],
    testimonials: [
      { quote: 'They captured every ritual without ever getting in the way. Our album feels like reliving the day.', author: 'Meera & Karthik' },
      { quote: 'Calm, kind and incredibly talented. Our families still talk about the photos.', author: 'Sneha & Joel' },
    ],
    faq: [
      { q: 'How soon do we get our photos?', a: 'A sneak peek within 3 days, the full gallery within 4 weeks.' },
      { q: 'Do you travel?', a: 'Yes, anywhere in India and abroad. Travel and stay are billed at cost.' },
    ],
    contact: { email: 'hello@arjunphotography.in', phone: '+91 98470 00000', whatsapp: '919847000000', city: 'Kochi, Kerala', instagram: 'https://instagram.com/' },
    seo: { title: 'Arjun Photography | Kerala Wedding Photographers', description: 'Documentary wedding photography and films from Kochi, Kerala.' },
  });

  // Generated placeholder photos (soft gradients) so the site and portal have something to show.
  const palettes = [
    ['#d9b99b', '#7c4a2d'], ['#e8d5c4', '#a0522d'], ['#c9d6df', '#52616b'], ['#f3e0dc', '#9e6b55'],
    ['#dfe7d8', '#5b7553'], ['#f1e3c6', '#b5833c'], ['#e4d4e8', '#6d4c7d'], ['#d6e4ea', '#3f6c80'],
  ];
  const ceremonies = ['Haldi', 'Wedding', 'Wedding', 'Reception'];
  for (let i = 0; i < 16; i++) {
    const [a, b] = palettes[i % palettes.length];
    const landscape = i % 3 !== 1;
    const [w, h] = landscape ? [3000, 2000] : [2000, 3000];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.62}" cy="${h * 0.4}" r="${Math.min(w, h) * 0.18}" fill="#fff" fill-opacity="0.18"/><text x="50%" y="88%" font-family="Georgia" font-size="${Math.min(w, h) * 0.05}" fill="#fff" fill-opacity="0.75" text-anchor="middle">Sample ${String(i + 1).padStart(2, '0')}</text></svg>`;
    const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
    const photo = await Photo.create({
      eventId: event.id,
      studioId: studio.id,
      kind: 'image',
      ceremony: ceremonies[i % 4],
      filename: `AR_${String(1000 + i)}.jpg`,
      isHighlight: i % 2 === 0,
      status: 'uploaded',
    });
    photo.originalKey = `studios/${studio.id}/events/${event.id}/original/${photo.id}.jpg`;
    await photo.save();
    await storage.put(photo.originalKey, jpg, 'image/jpeg');
    await processPhoto(photo.id);
  }
  // One fake RAW file to demonstrate RAW delivery.
  const raw = await Photo.create({ eventId: event.id, studioId: studio.id, kind: 'raw', ceremony: 'Wedding', filename: 'AR_1000.CR3', status: 'uploaded' });
  raw.originalKey = `studios/${studio.id}/events/${event.id}/raw/${raw.id}.cr3`;
  await raw.save();
  await storage.put(raw.originalKey, Buffer.alloc(1024 * 64, 7), 'application/octet-stream');
  await processPhoto(raw.id);

  console.log('demo logins (password Demo!2026): owner@demo.local, studio@demo.local, couple@demo.local');
  console.log('demo site: /s/arjun-photography');
}

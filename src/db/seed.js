// Seeds plans, templates and the super admin. With --demo, also creates a demo organization,
// studio, staff login, client login and an event with generated sample photos.
import sharp from 'sharp';
import { pool, one, q } from './pg.js';
import { seedPlansAndTemplates } from './seedBase.js';
import { connectMongo } from './mongo.js';
import mongoose from 'mongoose';
import { SiteConfig, Photo } from '../models/index.js';
import { hashPassword } from '../util.js';
import { processPhoto } from '../services/processing.js';
import { storage } from '../services/storage.js';

await seedPlansAndTemplates();

const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@sitesforstudios.local';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe!2026';
if (!(await one('SELECT 1 FROM accounts WHERE email = $1', [adminEmail]))) {
  await q(`INSERT INTO accounts(email, name, password_hash, role, must_change_password) VALUES ($1,'Platform Admin',$2,'super_admin',false)`, [
    adminEmail,
    await hashPassword(adminPassword),
  ]);
  // Never print the password in production (it would end up in deploy logs).
  console.log(process.env.NODE_ENV === 'production' ? `super admin created: ${adminEmail}` : `super admin: ${adminEmail} / ${adminPassword}`);
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
  // Local development uses the well-known Demo!2026. On a server, set DEMO_PASSWORD to something private.
  const demoPassword = process.env.DEMO_PASSWORD || 'Demo!2026';
  const pw = await hashPassword(demoPassword);
  await q(`INSERT INTO accounts(email, name, password_hash, role, org_id, must_change_password) VALUES ('owner@demo.local','Arjun Menon',$1,'org_admin',$2,false)`, [pw, org.id]);
  await q(`INSERT INTO accounts(email, name, password_hash, role, org_id, studio_id, must_change_password) VALUES ('studio@demo.local','Arjun (Studio)',$1,'studio_admin',$2,$3,false)`, [pw, org.id, studio.id]);
  const client = await one(
    `INSERT INTO accounts(email, name, password_hash, role, org_id, studio_id, must_change_password) VALUES ('couple@demo.local','Anjali & Rahul',$1,'client',$2,$3,false) RETURNING *`,
    [pw, org.id, studio.id]
  );
  const event = await one(
    `INSERT INTO events(studio_id, title, event_date, venue, raw_enabled, show_in_portfolio)
     VALUES ($1,'Anjali & Rahul','2026-11-08','Kumarakom Lake Resort, Kerala', true, true) RETURNING *`,
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

  console.log(
    `demo logins${process.env.DEMO_PASSWORD ? '' : ' (password Demo!2026)'}: owner@demo.local, studio@demo.local, couple@demo.local`
  );
  console.log('demo site: /s/arjun-photography');
}

// Plans and website templates every environment needs (idempotent).
import { q } from './pg.js';

export async function seedPlansAndTemplates() {
  // id, name, monthly, yearly, storage GB, studios, face events/month, staff, RAW, premium templates, retention months, client galleries
  const plans = [
    ['website', 'Website', 999, 9990, 10, 1, 0, 1, false, false, 120, false],
    ['starter', 'Starter', 3499, 34990, 500, 1, 3, 1, false, false, 12],
    ['pro', 'Pro', 6999, 69990, 1536, 1, 8, 3, true, true, 24],
    ['organization', 'Organization', 14999, 149990, 4096, 3, 20, 10, true, true, 36],
  ];
  for (const [...p] of plans) {
    const clientGalleries = p.length > 11 ? p.pop() : true;
    // New plans are created with these values; existing plans keep what the Super Admin set.
    await q(
      `INSERT INTO plans(id, name, price_monthly_inr, price_yearly_inr, storage_gb, max_studios, face_events_per_month, staff_seats, raw_delivery, premium_templates, retention_months, client_galleries)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [...p, clientGalleries]
    );
  }

  const templates = [
    ['editorial', 'Editorial Minimal', 'Clean white space, serif headlines and a story-led portfolio.', 'standard'],
    ['luxe', 'Classic Luxe', 'Ivory and gold tones with elegant script accents for traditional weddings.', 'standard'],
    ['cinematic', 'Dark Cinematic', 'Full-bleed imagery on a dark canvas, made for films and dramatic photos.', 'premium'],
    ['boho', 'Boho Film', 'Warm, earthy and relaxed: film grain, handwritten accents and polaroid-style prints.', 'standard'],
    ['indian', 'Indian Traditional', 'Ivory, maroon and gold with ornamental frames, made for grand multi-day Indian weddings.', 'premium'],
    ['grid', 'Modern Grid', 'Bold type, clean white space and a strict photo grid for contemporary studios.', 'standard'],
  ];
  for (const t of templates) {
    await q(
      `INSERT INTO templates(id, name, description, tier) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, tier = EXCLUDED.tier`,
      t
    );
  }
}

// Plans and website templates every environment needs (idempotent).
import { q } from './pg.js';

export async function seedPlansAndTemplates() {
  // id, name, monthly, yearly, storage GB, studios, face events/month, staff, RAW, premium templates, client galleries
  const plans = [
    // Face search is not offered for now (0 face events in every plan).
    ['website', 'Website', 999, 9990, 10, 1, 0, 1, false, false, false],
    ['starter', 'Starter', 3499, 34990, 500, 1, 0, 1, false, false, true],
    ['pro', 'Pro', 6999, 69990, 1536, 1, 0, 3, true, true, true],
    ['organization', 'Organization', 14999, 149990, 4096, 3, 0, 10, true, true, true],
  ];
  for (const p of plans) {
    // New plans are created with these values; existing plans keep what the Super Admin set.
    await q(
      `INSERT INTO plans(id, name, price_monthly_inr, price_yearly_inr, storage_gb, max_studios, face_events_per_month, staff_seats, raw_delivery, premium_templates, client_galleries)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      p
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

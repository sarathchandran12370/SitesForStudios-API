// Plans and website templates every environment needs (idempotent).
import { q } from './pg.js';

export async function seedPlansAndTemplates() {
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
}

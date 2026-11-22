-- Plan options editable by the Super Admin
-- (raw_delivery, premium_templates, retention_months already exist on plans)

-- Event retention: active -> archived (originals moved to deep archive, clients lose access)
-- -> restoring (studio asked for a restore) -> active again with a new expiry date.
ALTER TABLE events
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'restoring')),
  ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN warned_30_at TIMESTAMPTZ,
  ADD COLUMN warned_7_at TIMESTAMPTZ,
  ADD COLUMN clients_notified_at TIMESTAMPTZ;

CREATE TABLE event_restores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by  UUID REFERENCES accounts(id) ON DELETE SET NULL,
  amount_inr    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX event_restores_org_idx ON event_restores(org_id, created_at DESC);

-- Every email / WhatsApp message the platform sends (audit trail; in dev this is where "log" emails go).
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient   TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- invite | password_reset | photos_ready | enquiry | retention_warning | archived | restored
  subject     TEXT,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'logged', 'skipped', 'failed')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);
CREATE INDEX notifications_created_idx ON notifications(created_at DESC);
CREATE INDEX notifications_org_idx ON notifications(org_id, created_at DESC);

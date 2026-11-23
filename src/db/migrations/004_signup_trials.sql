-- Self sign-up and trials.
-- New organization status "expired": trial over and no plan chosen. Dashboards become read-only
-- (billing still works), websites and client galleries keep working until the grace period ends.
ALTER TABLE organizations DROP CONSTRAINT organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('trial', 'active', 'past_due', 'expired', 'suspended', 'cancelled'));

ALTER TABLE organizations
  ADD COLUMN trial_ends_at TIMESTAMPTZ,
  ADD COLUMN trial_reminder_days INTEGER,      -- smallest "days left" reminder already sent (7, 3, 1)
  ADD COLUMN expired_at TIMESTAMPTZ,
  ADD COLUMN signup_source TEXT NOT NULL DEFAULT 'admin' CHECK (signup_source IN ('admin', 'self'));

-- Existing trials get a trial end date from today.
UPDATE organizations SET trial_ends_at = now() + interval '14 days' WHERE status = 'trial' AND trial_ends_at IS NULL;

-- Pending self sign-ups waiting for the emailed code. Nothing is created until the code is verified.
CREATE TABLE signup_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL,
  data         JSONB NOT NULL,          -- names, phone, plan, password hash
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX signup_requests_email_idx ON signup_requests(lower(email));

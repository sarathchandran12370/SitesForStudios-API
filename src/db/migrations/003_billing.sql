-- Billing: yearly Razorpay plans, subscription state, GST billing details and invoices.
-- plans.razorpay_plan_id remains the MONTHLY Razorpay plan.
ALTER TABLE plans ADD COLUMN razorpay_plan_id_yearly TEXT;

ALTER TABLE organizations
  ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  ADD COLUMN pending_plan_id TEXT REFERENCES plans(id),
  ADD COLUMN pending_cycle TEXT CHECK (pending_cycle IN ('monthly', 'yearly')),
  ADD COLUMN cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;

-- Who the invoice is addressed to. GSTIN optional (B2C invoice without it).
CREATE TABLE billing_profiles (
  org_id      UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  legal_name  TEXT NOT NULL,
  gstin       TEXT,
  address     TEXT NOT NULL,
  city        TEXT NOT NULL,
  state_code  TEXT NOT NULL,          -- GST state code, e.g. '32' Kerala
  pincode     TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gap-free invoice numbers per financial year (April to March).
CREATE TABLE invoice_sequences (
  fy    TEXT PRIMARY KEY,               -- '2026-27'
  last  INTEGER NOT NULL
);

CREATE TABLE invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  number             TEXT NOT NULL UNIQUE,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_start       TIMESTAMPTZ,
  period_end         TIMESTAMPTZ,
  lines              JSONB NOT NULL,     -- [{description, sac, taxable_paise}]
  taxable_paise      INTEGER NOT NULL,
  cgst_paise         INTEGER NOT NULL DEFAULT 0,
  sgst_paise         INTEGER NOT NULL DEFAULT 0,
  igst_paise         INTEGER NOT NULL DEFAULT 0,
  total_paise        INTEGER NOT NULL,
  gst_rate           NUMERIC(5,2) NOT NULL,
  place_of_supply    TEXT NOT NULL,      -- state code
  buyer              JSONB NOT NULL,     -- billing profile snapshot
  seller             JSONB NOT NULL,     -- seller snapshot
  razorpay_payment_id      TEXT UNIQUE,
  razorpay_subscription_id TEXT,
  status             TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'void'))
);
CREATE INDEX invoices_org_idx ON invoices(org_id, issued_at DESC);

ALTER TABLE event_restores
  ADD COLUMN razorpay_addon_id TEXT,
  ADD COLUMN invoice_id UUID REFERENCES invoices(id);

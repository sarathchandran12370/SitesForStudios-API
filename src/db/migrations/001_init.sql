CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,               -- 'starter' | 'pro' | 'organization'
  name          TEXT NOT NULL,
  price_monthly_inr INTEGER NOT NULL,
  price_yearly_inr  INTEGER NOT NULL,
  storage_gb    INTEGER NOT NULL,
  max_studios   INTEGER NOT NULL,
  face_events_per_month INTEGER NOT NULL,
  staff_seats   INTEGER NOT NULL,
  raw_delivery  BOOLEAN NOT NULL DEFAULT false,
  premium_templates BOOLEAN NOT NULL DEFAULT false,
  retention_months INTEGER NOT NULL,
  razorpay_plan_id TEXT
);

CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  status      TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','suspended','cancelled')),
  razorpay_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id          TEXT PRIMARY KEY,                 -- 'editorial' | 'luxe' | 'cinematic'
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard','premium')),
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE studios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  template_id   TEXT NOT NULL DEFAULT 'editorial' REFERENCES templates(id),
  custom_domain TEXT UNIQUE,
  domain_status TEXT NOT NULL DEFAULT 'none' CHECK (domain_status IN ('none','pending','verified','live','failed')),
  domain_verify_token TEXT,
  certificate_arn TEXT,
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super_admin','org_admin','studio_admin','staff','client')),
  org_id        UUID REFERENCES organizations(id) ON DELETE CASCADE,
  studio_id     UUID REFERENCES studios(id) ON DELETE CASCADE,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  token_version INTEGER NOT NULL DEFAULT 0,      -- bump to log out everywhere
  created_by    UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role = 'super_admin' OR org_id IS NOT NULL),
  CHECK (role NOT IN ('studio_admin','staff','client') OR studio_id IS NOT NULL)
);

CREATE TABLE events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  event_date    DATE,
  venue         TEXT,
  cover_photo_id TEXT,
  raw_enabled   BOOLEAN NOT NULL DEFAULT false,
  face_enabled  BOOLEAN NOT NULL DEFAULT true,
  show_in_portfolio BOOLEAN NOT NULL DEFAULT false,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_studio_idx ON events(studio_id, event_date DESC);

CREATE TABLE event_access (
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  access_level  TEXT NOT NULL DEFAULT 'guest' CHECK (access_level IN ('primary','guest')),
  PRIMARY KEY (event_id, account_id)
);

CREATE TABLE enquiries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT,
  event_date  DATE,
  city        TEXT,
  event_type  TEXT,
  budget      TEXT,
  message     TEXT,
  date_available BOOLEAN,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','quoted','booked','lost')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX enquiries_studio_idx ON enquiries(studio_id, created_at DESC);

CREATE TABLE usage_monthly (
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month         DATE NOT NULL,
  face_events   INTEGER NOT NULL DEFAULT 0,
  egress_bytes  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month)
);

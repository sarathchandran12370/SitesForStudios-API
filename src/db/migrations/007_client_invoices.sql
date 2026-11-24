-- Invoices a studio sends to its own clients (separate from the platform's subscription invoices).
-- Money is stored in paise. Drafts have no number; the number is given when the invoice is first sent,
-- so the GST invoice series has no gaps.

CREATE TABLE studio_invoice_settings (
  studio_id     UUID PRIMARY KEY REFERENCES studios(id) ON DELETE CASCADE,
  legal_name    TEXT,
  gstin         TEXT,
  address       TEXT,
  state_code    TEXT,
  email         TEXT,
  phone         TEXT,
  prefix        TEXT NOT NULL DEFAULT 'INV',
  default_sac   TEXT NOT NULL DEFAULT '998383',     -- event photography and videography
  default_gst_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
  due_days      INTEGER NOT NULL DEFAULT 7,
  bank_details  TEXT,
  upi_id        TEXT,
  terms         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE studio_invoice_sequences (
  studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  fy        TEXT NOT NULL,
  last      INTEGER NOT NULL,
  PRIMARY KEY (studio_id, fy)
);

CREATE TABLE client_invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id         UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  number            TEXT,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partially_paid','paid','cancelled')),
  client_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  event_id          UUID REFERENCES events(id) ON DELETE SET NULL,
  customer          JSONB NOT NULL,          -- name, email, phone, address, state_code, gstin
  issue_date        DATE NOT NULL DEFAULT current_date,
  due_date          DATE,
  lines             JSONB NOT NULL,          -- [{description, sac, qty, rate_paise, amount_paise}]
  discount_paise    BIGINT NOT NULL DEFAULT 0,
  gst_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
  place_of_supply   TEXT,
  taxable_paise     BIGINT NOT NULL DEFAULT 0,
  cgst_paise        BIGINT NOT NULL DEFAULT 0,
  sgst_paise        BIGINT NOT NULL DEFAULT 0,
  igst_paise        BIGINT NOT NULL DEFAULT 0,
  total_paise       BIGINT NOT NULL DEFAULT 0,
  paid_paise        BIGINT NOT NULL DEFAULT 0,
  notes             TEXT,
  seller            JSONB,                   -- snapshot of the studio's details when first sent
  view_token        TEXT NOT NULL UNIQUE,    -- private link for the client, no login needed
  sent_at           TIMESTAMPTZ,
  created_by        UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (studio_id, number)
);
CREATE INDEX client_invoices_studio_idx ON client_invoices(studio_id, created_at DESC);
CREATE INDEX client_invoices_client_idx ON client_invoices(client_account_id);

CREATE TABLE client_invoice_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   UUID NOT NULL REFERENCES client_invoices(id) ON DELETE CASCADE,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  method       TEXT NOT NULL CHECK (method IN ('upi','bank','cash','card','cheque','other')),
  reference    TEXT,
  paid_on      DATE NOT NULL DEFAULT current_date,
  recorded_by  UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX client_invoice_payments_invoice_idx ON client_invoice_payments(invoice_id);

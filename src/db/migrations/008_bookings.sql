-- Studio bookings shown on the studio's calendar. A booking is one client job (a wedding, an engagement shoot…)
-- with one or more sessions on different days (haldi, wedding, reception). The website's enquiry form treats a
-- date with a tentative or confirmed session as taken.

CREATE TABLE bookings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id         UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  event_type        TEXT NOT NULL DEFAULT 'wedding',
  status            TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('tentative','confirmed','completed','cancelled')),
  client_name       TEXT NOT NULL,
  client_phone      TEXT,
  client_email      TEXT,
  client_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  enquiry_id        UUID REFERENCES enquiries(id) ON DELETE SET NULL,
  event_id          UUID REFERENCES events(id) ON DELETE SET NULL,
  package_paise     BIGINT,
  team              UUID[] NOT NULL DEFAULT '{}',   -- staff accounts assigned to shoot it
  notes             TEXT,
  start_date        DATE NOT NULL,                  -- first and last session, kept in sync for quick range queries
  end_date          DATE NOT NULL,
  created_by        UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bookings_studio_dates_idx ON bookings(studio_id, start_date, end_date);

CREATE TABLE booking_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  date        DATE NOT NULL,
  start_time  TEXT,          -- 'HH:MM', optional
  end_time    TEXT,
  venue       TEXT,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX booking_sessions_booking_idx ON booking_sessions(booking_id);
CREATE INDEX booking_sessions_date_idx ON booking_sessions(date);

-- Invoices can be raised for a booking (advance, balance).
ALTER TABLE client_invoices ADD COLUMN booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;
CREATE INDEX client_invoices_booking_idx ON client_invoices(booking_id);

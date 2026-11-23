-- Which version of the Terms of Service and Privacy Policy each person accepted, and when.
ALTER TABLE accounts
  ADD COLUMN terms_version TEXT,
  ADD COLUMN terms_accepted_at TIMESTAMPTZ;

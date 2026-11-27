-- Face search is not offered in any plan for now. A plan offers it only when face_events_per_month > 0,
-- so the Super Admin can bring it back per plan later without a code change.
UPDATE plans SET face_events_per_month = 0;
UPDATE events SET face_enabled = false;
ALTER TABLE events ALTER COLUMN face_enabled SET DEFAULT false;

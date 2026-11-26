-- Galleries no longer expire or archive: photos stay online while the studio subscribes and stays
-- within its plan storage (Cloudflare R2 has free downloads, so there is no cheaper "archive" tier to move to).
-- Old columns and the event_restores table are kept for history but are no longer used:
-- events.expires_at, archived_at, warned_30_at, warned_7_at, plans.retention_months, event_restores.
UPDATE events SET status = 'active' WHERE status IN ('archived', 'restoring');
UPDATE events SET expires_at = NULL, warned_30_at = NULL, warned_7_at = NULL;
ALTER TABLE plans ALTER COLUMN retention_months DROP NOT NULL;

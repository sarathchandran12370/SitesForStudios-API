-- Client gallery features: album selection, photo comments, download protection and watermarks,
-- guest share links, per-event gallery design, and client reviews.

ALTER TABLE events
  -- Album selection: the most photos a client may pick (NULL = no limit).
  ADD COLUMN selection_limit INT CHECK (selection_limit IS NULL OR selection_limit > 0),
  -- What clients and guests may download: full resolution, web size only (2048 px JPEG) or nothing.
  ADD COLUMN downloads TEXT NOT NULL DEFAULT 'full' CHECK (downloads IN ('full', 'web', 'none')),
  -- Show large previews with the studio name across them.
  ADD COLUMN watermark BOOLEAN NOT NULL DEFAULT false,
  -- Gallery look: { layout, theme, font, cover }. Empty means the defaults.
  ADD COLUMN design JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Guest share link: anyone with the link (and the password, when set) can view without an account.
  ADD COLUMN share_token TEXT UNIQUE,
  ADD COLUMN share_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN share_password_hash TEXT,
  ADD COLUMN share_downloads BOOLEAN NOT NULL DEFAULT true;

-- Each client's album selection is their own; the studio sees one list per client.
ALTER TABLE event_access
  ADD COLUMN selection_submitted_at TIMESTAMPTZ,
  ADD COLUMN selection_note TEXT;

CREATE TABLE photo_picks (
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  photo_id    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, account_id, photo_id)
);

-- A comment thread per photo and client: only that client and the studio see it.
CREATE TABLE photo_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  photo_id          TEXT NOT NULL,
  client_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  from_studio       BOOLEAN NOT NULL DEFAULT false,
  body              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX photo_comments_event_idx ON photo_comments(event_id, created_at DESC);
CREATE INDEX photo_comments_thread_idx ON photo_comments(photo_id, client_account_id, created_at);

-- Reviews clients leave from their gallery. The studio publishes them to its website.
CREATE TABLE reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  event_id     UUID REFERENCES events(id) ON DELETE SET NULL,
  account_id   UUID REFERENCES accounts(id) ON DELETE SET NULL,
  author_name  TEXT NOT NULL,
  rating       INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'hidden')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, account_id)
);
CREATE INDEX reviews_studio_idx ON reviews(studio_id, status, created_at DESC);

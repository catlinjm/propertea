CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#3d6628',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comments (
  id                SERIAL PRIMARY KEY,
  listing_mlsid     TEXT NOT NULL,
  user_id           INT REFERENCES users(id) ON DELETE SET NULL,
  author_name       TEXT NOT NULL,
  author_color      TEXT NOT NULL DEFAULT '#3d6628',
  body              TEXT NOT NULL,
  parent_comment_id INT REFERENCES comments(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comments_listing_idx ON comments (listing_mlsid);
CREATE INDEX IF NOT EXISTS comments_parent_idx  ON comments (parent_comment_id);

CREATE TABLE IF NOT EXISTS likes (
  id          SERIAL PRIMARY KEY,
  comment_id  INT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id     INT REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT likes_unique_fp  UNIQUE (comment_id, fingerprint),
  CONSTRAINT likes_unique_uid UNIQUE (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  comment_id  INT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  fingerprint TEXT,
  reason      TEXT NOT NULL DEFAULT 'inappropriate',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 30-minute SimplyRETS response cache
CREATE TABLE IF NOT EXISTS listings_cache (
  cache_key  TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

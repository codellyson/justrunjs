-- A student's own copy of a lesson's code, one per lesson moment they stopped at (see
-- src/learn/copies.ts), stored as the copy's JSON.
CREATE TABLE lesson_copies (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  origin_ms INTEGER NOT NULL,
  copy TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug, origin_ms)
);

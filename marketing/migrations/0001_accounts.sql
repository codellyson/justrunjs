CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- One row per sign-in email: link token and typed code, both stored hashed.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX login_tokens_email ON login_tokens (email, created_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- A learner's experiment: the editor tab forked from a lesson, stored as the tab's JSON.
-- Ids come from the client, so they are only unique per user.
CREATE TABLE experiments (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  tab TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE progress (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  position_ms INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug)
);

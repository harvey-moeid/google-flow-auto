-- 0007: Google identity linking from Android. Does not authorize Flow sessions.
CREATE TABLE IF NOT EXISTS account_google_identities (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 google_sub TEXT NOT NULL UNIQUE,
 email TEXT NOT NULL,
 verified_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS account_enrollment_challenges (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 nonce_hash TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 consumed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_google_challenges_account ON account_enrollment_challenges(account_id, expires_at);

-- Atomic, short-lived counters for owner-key guesses on the consent form.
CREATE TABLE oauth_login_attempts (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_login_expiry ON oauth_login_attempts(expires_at);

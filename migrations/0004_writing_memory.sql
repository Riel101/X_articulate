CREATE TABLE voice_profiles(owner_id TEXT PRIMARY KEY, preferences_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE voice_examples(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,text TEXT NOT NULL,notes TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX voice_examples_owner ON voice_examples(owner_id,created_at);
CREATE TABLE editorial_reviews(id TEXT PRIMARY KEY,draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,review_json TEXT NOT NULL,client_model TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE draft_revisions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,original_draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,revised_draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,original_text TEXT NOT NULL,revised_text TEXT NOT NULL,feedback TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX revisions_owner ON draft_revisions(owner_id,created_at);
CREATE TABLE performance_refresh_state(published_post_id TEXT PRIMARY KEY REFERENCES published_posts(id) ON DELETE CASCADE,attempted_at TEXT NOT NULL,status TEXT NOT NULL);

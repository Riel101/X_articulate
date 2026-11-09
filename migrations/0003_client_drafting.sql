CREATE TABLE drafting_briefs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_key TEXT,
  input_hash TEXT NOT NULL,
  preferences_json TEXT NOT NULL,
  research_json TEXT NOT NULL,
  learning_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  final_draft_id TEXT REFERENCES drafts(id) ON DELETE SET NULL,
  final_input_hash TEXT,
  UNIQUE(owner_id,request_key)
);
CREATE INDEX drafting_briefs_owner ON drafting_briefs(owner_id,created_at);

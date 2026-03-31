CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,
  architecture TEXT,
  quantization TEXT,
  size_bytes INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  profile_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_loaded_at TEXT,
  load_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_models_updated_at ON models(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_models_source_kind ON models(source_kind);

CREATE TABLE IF NOT EXISTS engine_versions (
  id TEXT PRIMARY KEY,
  engine_type TEXT NOT NULL,
  version_tag TEXT NOT NULL,
  binary_path TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 0,
  capability_json TEXT NOT NULL DEFAULT '{}',
  compatibility_notes TEXT,
  installed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engine_versions_engine_type ON engine_versions(engine_type, installed_at DESC);

CREATE TABLE IF NOT EXISTS download_tasks (
  id TEXT PRIMARY KEY,
  model_id TEXT,
  provider TEXT NOT NULL,
  url TEXT NOT NULL,
  total_bytes INTEGER,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  checksum_sha256 TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_download_tasks_status ON download_tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS prompt_caches (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT NOT NULL,
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prompt_caches_model_id ON prompt_caches(model_id);
CREATE INDEX IF NOT EXISTS idx_prompt_caches_expires_at ON prompt_caches(expires_at);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '["public"]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_revoked_at ON api_tokens(revoked_at);

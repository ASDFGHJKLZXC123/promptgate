-- 001_core.sql
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,             -- "web_builder_llm", "ci-evals"
  key_hash TEXT NOT NULL UNIQUE,         -- sha256 of "pg-..." secret; plaintext shown once at creation
  budget_micro_usd_month INTEGER NOT NULL DEFAULT 10000000,   -- $10
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE model_pricing (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,                -- 'anthropic' | 'openai'
  model TEXT NOT NULL,
  input_micro_usd_per_mtok INTEGER NOT NULL,   -- e.g. $3.00/Mtok = 3000000
  output_micro_usd_per_mtok INTEGER NOT NULL,
  effective_from TEXT NOT NULL,          -- date-effective pricing; latest row <= now wins
  UNIQUE(model, effective_from)
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_id INTEGER,                     -- set when pg_prompt was used
  prompt_version INTEGER,
  feature TEXT,                          -- pg_feature tag → FinOps cost-per-feature
  cache_hit INTEGER NOT NULL DEFAULT 0,
  streamed INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER, output_tokens INTEGER,
  cost_micro_usd INTEGER, cost_estimated INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER, total_ms INTEGER,
  status TEXT NOT NULL,                  -- 'ok' | 'client_aborted' | 'provider_error' | 'rejected_*'
  error_code TEXT
);
CREATE INDEX idx_requests_ts ON requests(ts);
CREATE INDEX idx_requests_key_ts ON requests(api_key_id, ts);

CREATE TABLE requests_daily (             -- rollups written by the pruner; drift charts read these past 90d
  day TEXT NOT NULL,                     -- 'YYYY-MM-DD'
  api_key_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  feature TEXT,
  request_count INTEGER NOT NULL,
  cache_hits INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  latency_p50_ms INTEGER, latency_p95_ms INTEGER,
  PRIMARY KEY(day, api_key_id, model, feature)
);

CREATE TABLE cache_entries (
  hash TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  response_json TEXT NOT NULL,           -- assembled OpenAI-format response
  usage_json TEXT NOT NULL,
  priced_cost_micro_usd INTEGER NOT NULL, -- what the original generation cost → "$ saved" math (§3.4)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT
);

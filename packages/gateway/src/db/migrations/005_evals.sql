-- 005_evals.sql
-- Eval harness persistence for locked decisions #10–#12.
CREATE TABLE eval_datasets (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  description TEXT
);

CREATE TABLE eval_runs (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  dataset_id INTEGER NOT NULL REFERENCES eval_datasets(id),
  dataset_hash TEXT NOT NULL,
  prompt_id INTEGER,
  prompt_version INTEGER,
  prompt_ref TEXT,
  model TEXT NOT NULL,
  git_sha TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('ci', 'manual')),
  cases_total INTEGER NOT NULL CHECK (cases_total > 0),
  cases_passed INTEGER NOT NULL CHECK (cases_passed BETWEEN 0 AND cases_total),
  score_avg REAL CHECK (score_avg BETWEEN 0.0 AND 1.0),
  cost_micro_usd INTEGER NOT NULL CHECK (cost_micro_usd >= 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
);

CREATE TABLE eval_results (
  run_id INTEGER NOT NULL REFERENCES eval_runs(id),
  case_id TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  score REAL CHECK (score BETWEEN 0.0 AND 1.0),
  detail_json TEXT NOT NULL,
  latency_ms INTEGER CHECK (latency_ms >= 0),
  cost_micro_usd INTEGER CHECK (cost_micro_usd >= 0),
  PRIMARY KEY(run_id, case_id)
);

CREATE INDEX idx_eval_runs_history ON eval_runs(dataset_id, prompt_ref, model, ts DESC);

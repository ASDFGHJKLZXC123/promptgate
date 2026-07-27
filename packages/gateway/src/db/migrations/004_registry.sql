-- 004_registry.sql
-- Prompt registry tables for locked decisions #8 (immutable DB versions with
-- mutable labels) and #9 (server-side references resolved by slug@version or
-- slug@label).  This migration was renumbered from 003 when Phase 1 claimed
-- 003_provider_pricing.sql.
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE prompt_versions (
  id INTEGER PRIMARY KEY,
  prompt_id INTEGER NOT NULL REFERENCES prompts(id),
  version INTEGER NOT NULL,
  messages_json TEXT NOT NULL,
  variables_json TEXT NOT NULL,
  model_hint TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(prompt_id, version)
);

CREATE TABLE prompt_labels (
  prompt_id INTEGER NOT NULL REFERENCES prompts(id),
  label TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(prompt_id, label),
  FOREIGN KEY(prompt_id, version) REFERENCES prompt_versions(prompt_id, version)
);

CREATE TABLE label_history (
  id INTEGER PRIMARY KEY,
  prompt_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  moved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE ON prompt_versions
BEGIN SELECT RAISE(ABORT, 'prompt_versions is immutable'); END;
CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON prompt_versions
BEGIN SELECT RAISE(ABORT, 'prompt_versions is immutable'); END;

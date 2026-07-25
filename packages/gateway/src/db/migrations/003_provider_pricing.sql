-- 003_provider_pricing.sql
-- Adds the nullable cache-hit input rate needed to meter providers that
-- price cached vs. uncached input tokens separately (e.g. DeepSeek's
-- cache-miss vs. cached input rates, BUILD_PLAYBOOK.md phase 1 step 9,
-- human-approved four-provider scope amendment 2026-07-25). Nullable for the
-- same reason as 002_request_identity.sql: SQLite's ALTER TABLE ADD COLUMN
-- cannot backfill a NOT NULL column for rows already committed under
-- 001_core.sql, and most providers/models never report a cache split.
ALTER TABLE model_pricing ADD COLUMN cached_input_micro_usd_per_mtok INTEGER;

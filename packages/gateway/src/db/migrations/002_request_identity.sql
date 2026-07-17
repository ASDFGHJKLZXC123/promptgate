-- 002_request_identity.sql
-- Adds the gateway-generated request UUID to `requests`. Nullable at the
-- schema level only because SQLite's ALTER TABLE ADD COLUMN cannot backfill
-- a NOT NULL column without a default for the rows already committed under
-- 001_core.sql; the application invariant (every gateway-created request
-- insert supplies a UUID) is enforced in the pipeline DAO, not here. The
-- partial unique index still guarantees no two populated request_ids collide
-- while leaving legacy NULL rows unconstrained.
ALTER TABLE requests ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX idx_requests_request_id ON requests(request_id) WHERE request_id IS NOT NULL;

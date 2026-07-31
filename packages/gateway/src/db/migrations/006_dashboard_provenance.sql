-- Phase 7 dashboard provenance. Cache-hit request cost remains zero because
-- it is the amount charged for that replay; cache_saved_* records the frozen
-- cost of the source completion separately for FinOps reporting.
ALTER TABLE cache_entries ADD COLUMN priced_cost_estimated INTEGER
  CHECK(priced_cost_estimated IS NULL OR priced_cost_estimated IN (0, 1));

ALTER TABLE requests ADD COLUMN cache_saved_micro_usd INTEGER
  CHECK(cache_saved_micro_usd IS NULL OR cache_saved_micro_usd >= 0);
ALTER TABLE requests ADD COLUMN cache_saved_estimated INTEGER
  CHECK(cache_saved_estimated IS NULL OR cache_saved_estimated IN (0, 1));

-- A legacy non-hit never saved an upstream completion, so its provenance is
-- known. Legacy hits intentionally remain NULL: their source cache rows did
-- not record whether the original price was estimated.
UPDATE requests
SET cache_saved_micro_usd = 0,
    cache_saved_estimated = 0
WHERE cache_hit = 0;

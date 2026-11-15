-- Phase 6B step 3: optional dimensions and duration supplied by the trusted adapter worker.
-- Null means the adapter did not provide metadata; existing media remains readable.
ALTER TABLE media ADD COLUMN width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 16384);
ALTER TABLE media ADD COLUMN height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 16384);
ALTER TABLE media ADD COLUMN duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 86400000);

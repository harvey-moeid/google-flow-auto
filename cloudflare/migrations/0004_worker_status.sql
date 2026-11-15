-- 0004_worker_status (Phase 4b): health reported by the browser worker, one row per worker_id.
--
-- Purely observational: nothing in the queue or the lease reads this table, so a stale or missing
-- row can never block or release a job. Times are epoch MILLISECONDS (like 0002) so "online" can be
-- computed with the injectable API clock. Rows are pruned by the API after 7 days of silence.
CREATE TABLE IF NOT EXISTS worker_status (
  worker_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('idle','busy','stopping')),
  -- NULL when the worker could not read the disk (never guessed).
  disk_free_bytes INTEGER CHECK (disk_free_bytes IS NULL OR disk_free_bytes >= 0),
  disk_total_bytes INTEGER CHECK (disk_total_bytes IS NULL OR disk_total_bytes >= 0),
  -- Number of slot-NN profile directories found on the worker disk (0..10).
  profile_count INTEGER NOT NULL DEFAULT 0 CHECK (profile_count BETWEEN 0 AND 10),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_status_seen ON worker_status(last_seen_at);

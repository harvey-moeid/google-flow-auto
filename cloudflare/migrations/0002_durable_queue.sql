-- 0002_durable_queue (Phase 2): queue columns on jobs + the single global execution lease.
--
-- Job states: queued -> claimed -> running -> succeeded | failed | cancelled, plus waiting_for_user
-- (re-authentication needed). succeeded/failed/cancelled are final.
--
-- Time columns added here are epoch MILLISECONDS (INTEGER) so lease arithmetic is exact and
-- testable with an injected clock; the older created_at/started_at/finished_at stay TEXT.

ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
-- Earliest time (epoch ms) at which a queued job may be claimed; used for retry backoff.
ALTER TABLE jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0;
-- Owner asked a claimed/running job to stop; the lease holder acknowledges it (cancel-ack).
ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1));
-- Which worker holds the job and under which fencing token (set at claim, checked on every mutation).
ALTER TABLE jobs ADD COLUMN worker_id TEXT;
ALTER TABLE jobs ADD COLUMN lease_token INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs(status, available_at, created_at);

-- The old worker_lease table was never used by any code path; replaced by global_lease.
DROP TABLE IF EXISTS worker_lease;

-- Exactly one row ever exists (name='global'). fencing_token only increases and is never reset,
-- not even when the lease is released, so a stale worker's token can never match a newer lease.
CREATE TABLE IF NOT EXISTS global_lease (
  name TEXT PRIMARY KEY CHECK (name = 'global'),
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  holder_id TEXT,
  job_id TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  heartbeat_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  CHECK (job_id IS NULL OR holder_id IS NOT NULL)
);
INSERT OR IGNORE INTO global_lease(name) VALUES ('global');

-- Defence in depth: the application only performs legal transitions, and the database refuses
-- unknown states and any move out of a final state.
CREATE TRIGGER IF NOT EXISTS trg_jobs_status_insert BEFORE INSERT ON jobs
WHEN NEW.status NOT IN ('queued','claimed','running','waiting_for_user','succeeded','failed','cancelled')
BEGIN SELECT RAISE(ABORT, 'invalid job status'); END;

CREATE TRIGGER IF NOT EXISTS trg_jobs_status_update BEFORE UPDATE OF status ON jobs
WHEN NEW.status NOT IN ('queued','claimed','running','waiting_for_user','succeeded','failed','cancelled')
  OR (OLD.status IN ('succeeded','failed','cancelled') AND NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'invalid job status transition'); END;

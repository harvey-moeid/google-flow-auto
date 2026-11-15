-- 0004_scene_assets (Phase 3B): reference images attached to a scene, stored in the private R2 bucket.
--
-- The row is the source of truth for what a scene owns; the object lives at r2_key in the MEDIA bucket.
-- Deleting a scene (or project) cascades to its rows; the API removes the matching R2 objects, and any
-- object left behind by a failed delete is an orphan for the Phase 6 cleanup job (no row points at it).

CREATE TABLE IF NOT EXISTS scene_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scene_assets_scene ON scene_assets(scene_id, created_at, id);

-- Defence in depth: the API checks the limit first; the database refuses what slips past a race.
CREATE TRIGGER IF NOT EXISTS trg_scene_assets_limit_insert BEFORE INSERT ON scene_assets
WHEN (SELECT COUNT(*) FROM scene_assets WHERE scene_id = NEW.scene_id) >= 3
BEGIN SELECT RAISE(ABORT, 'asset limit reached'); END;

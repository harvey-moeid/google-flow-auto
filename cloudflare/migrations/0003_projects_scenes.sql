-- 0003_projects_scenes (Phase 3): project/scene workflow support.
--
-- Project statuses are 'draft' and 'archived'. Scene order is 1..N per project (gaps are allowed
-- after a delete; the reorder endpoint renumbers). Jobs keep their own created_at/rowid order, which
-- is the FIFO order the single global lane runs in.

-- A retry creates a NEW job (final states can never be left), so the original stays in the history.
-- Plain TEXT on purpose: no foreign key, so history can never block a future cleanup.
ALTER TABLE jobs ADD COLUMN retry_of TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_scene ON jobs(scene_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, created_at, id);

-- Defence in depth: the API validates all of this first; the database refuses what slips past.
CREATE TRIGGER IF NOT EXISTS trg_projects_status_insert BEFORE INSERT ON projects
WHEN NEW.status NOT IN ('draft','archived')
BEGIN SELECT RAISE(ABORT, 'invalid project status'); END;

CREATE TRIGGER IF NOT EXISTS trg_projects_status_update BEFORE UPDATE OF status ON projects
WHEN NEW.status NOT IN ('draft','archived')
BEGIN SELECT RAISE(ABORT, 'invalid project status'); END;

CREATE TRIGGER IF NOT EXISTS trg_scenes_limit_insert BEFORE INSERT ON scenes
WHEN (SELECT COUNT(*) FROM scenes WHERE project_id = NEW.project_id) >= 50
BEGIN SELECT RAISE(ABORT, 'scene limit reached'); END;

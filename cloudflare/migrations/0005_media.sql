-- Phase 6A: private generated media metadata. R2 remains private; every read is authorized by the API.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scene_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('video','image')),
  mime TEXT NOT NULL CHECK (mime IN ('video/mp4','video/webm','image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 94371840),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (job_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_media_job ON media(job_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_media_project ON media(project_id, created_at, id);

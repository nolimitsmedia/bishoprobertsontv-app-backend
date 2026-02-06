-- 20260204_03_import_job_items.sql
-- Per-file status tracking within a job

CREATE TABLE IF NOT EXISTS import_job_items (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,

  source_key TEXT NOT NULL,
  source_etag TEXT NULL,
  source_size BIGINT NULL,
  source_last_modified TIMESTAMPTZ NULL,

  dest_path TEXT NULL,
  dest_url TEXT NULL,

  created_video_id BIGINT NULL,

  status TEXT NOT NULL CHECK (
    status IN ('queued','downloading','uploading','verifying','imported','skipped','error','canceled')
  ) DEFAULT 'queued',

  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,

  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_import_job_items_job
  ON import_job_items(job_id);

CREATE INDEX IF NOT EXISTS idx_import_job_items_status
  ON import_job_items(status);

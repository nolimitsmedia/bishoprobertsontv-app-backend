-- 20260204_02_import_jobs.sql
-- Tracks admin import runs for progress + history

CREATE TABLE IF NOT EXISTS import_jobs (
  id BIGSERIAL PRIMARY KEY,

  source_connection_id BIGINT NOT NULL REFERENCES storage_connections(id),
  target_connection_id BIGINT NULL REFERENCES storage_connections(id),

  mode TEXT NOT NULL CHECK (mode IN ('wasabi_only','wasabi_to_bunny')),

  status TEXT NOT NULL CHECK (
    status IN ('queued','running','completed','completed_with_errors','failed','canceled')
  ) DEFAULT 'queued',

  -- options: { visibility, category_id, prefix, default_title_mode, etc }
  options JSONB NOT NULL DEFAULT '{}'::jsonb,

  total_items INT NOT NULL DEFAULT 0,
  processed_items INT NOT NULL DEFAULT 0,
  imported_items INT NOT NULL DEFAULT 0,
  skipped_items INT NOT NULL DEFAULT 0,
  error_items INT NOT NULL DEFAULT 0,

  last_error TEXT NULL,

  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_status
  ON import_jobs(status);

CREATE INDEX IF NOT EXISTS idx_import_jobs_created_at
  ON import_jobs(created_at DESC);

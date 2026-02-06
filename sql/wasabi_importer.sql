CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------
-- storage_connections
-- ----------------------------
CREATE TABLE IF NOT EXISTS storage_connections (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('wasabi','bunny')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disconnected','error')),
  label TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets_enc TEXT,
  last_verified_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_storage_connections_provider_active
ON storage_connections (provider)
WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_storage_connections_updated_at ON storage_connections;
CREATE TRIGGER trg_storage_connections_updated_at
BEFORE UPDATE ON storage_connections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------
-- import_jobs
-- ----------------------------
CREATE TABLE IF NOT EXISTS import_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('wasabi')),
  dest_provider TEXT CHECK (dest_provider IN ('bunny')),
  mode TEXT NOT NULL CHECK (mode IN ('remote','copy_to_bunny')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','scanning','ready','running','paused','completed','failed','canceled')),
  requested_by_admin_id BIGINT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_import_jobs_status ON import_jobs(status);

DROP TRIGGER IF EXISTS trg_import_jobs_updated_at ON import_jobs;
CREATE TRIGGER trg_import_jobs_updated_at
BEFORE UPDATE ON import_jobs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------
-- import_job_items
-- ----------------------------
CREATE TABLE IF NOT EXISTS import_job_items (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued','skipped','validating','copying','importing',
      'completed','failed','retrying'
    )),

  source_key TEXT NOT NULL,
  source_etag TEXT,
  source_size_bytes BIGINT,
  source_last_modified TIMESTAMPTZ,

  dest_key TEXT,
  dest_url TEXT,

  video_id BIGINT,

  error TEXT,
  attempts INT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(job_id, source_key)
);

CREATE INDEX IF NOT EXISTS ix_import_job_items_job_status
ON import_job_items(job_id, status);

DROP TRIGGER IF EXISTS trg_import_job_items_updated_at ON import_job_items;
CREATE TRIGGER trg_import_job_items_updated_at
BEFORE UPDATE ON import_job_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

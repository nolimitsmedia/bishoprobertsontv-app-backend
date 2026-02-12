-- email_connections: store one active provider config (encrypted secrets)
CREATE TABLE IF NOT EXISTS email_connections (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  secrets_enc JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_connections_active_idx
  ON email_connections (is_active, updated_at DESC);

-- email_jobs: each send action creates a job
CREATE TABLE IF NOT EXISTS email_jobs (
  id BIGSERIAL PRIMARY KEY,
  created_by BIGINT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NULL,
  body_text TEXT NULL,
  audience JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|sending|partial|sent|failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_jobs_created_at_idx
  ON email_jobs (created_at DESC);

-- email_job_items: per-recipient status
CREATE TABLE IF NOT EXISTS email_job_items (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES email_jobs(id) ON DELETE CASCADE,
  user_id BIGINT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|sent|failed
  error TEXT NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_job_items_job_idx
  ON email_job_items (job_id, id);

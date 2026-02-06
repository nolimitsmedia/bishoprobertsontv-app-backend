-- 20260204_01_storage_connections.sql
-- Admin-only: one active Wasabi + one active Bunny

CREATE TABLE IF NOT EXISTS storage_connections (
  id BIGSERIAL PRIMARY KEY,

  provider TEXT NOT NULL CHECK (provider IN ('wasabi','bunny')),
  name TEXT NOT NULL DEFAULT '',

  -- non-secret config (endpoint/region/bucket/prefix OR host/zone/basePath/cdnBaseUrl)
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- encrypted secrets JSON (AES-256-GCM produced by app)
  secrets_enc TEXT NOT NULL DEFAULT '',

  is_active BOOLEAN NOT NULL DEFAULT FALSE,

  last_test_ok BOOLEAN NOT NULL DEFAULT FALSE,
  last_test_at TIMESTAMPTZ NULL,
  last_test_error TEXT NULL,

  connected_at TIMESTAMPTZ NULL,
  disconnected_at TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce: only one active row per provider
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_connections_one_active_per_provider
  ON storage_connections(provider)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_storage_connections_provider
  ON storage_connections(provider);

-- Optional but recommended for faster Wasabi imported/not imported detection.
-- Run once in PostgreSQL before testing large import lists.

CREATE INDEX IF NOT EXISTS idx_videos_wasabi_key
  ON videos (wasabi_key);

CREATE INDEX IF NOT EXISTS idx_videos_provider_key
  ON videos (provider_key);

CREATE INDEX IF NOT EXISTS idx_videos_bunny_video_id
  ON videos (bunny_video_id);

CREATE INDEX IF NOT EXISTS idx_videos_source_meta_wasabi_key
  ON videos ((source_meta->>'wasabi_key'));

CREATE INDEX IF NOT EXISTS idx_videos_source_meta_key
  ON videos ((source_meta->>'key'));

CREATE INDEX IF NOT EXISTS idx_videos_metadata_wasabi_key
  ON videos ((metadata->>'wasabi_key'));

CREATE INDEX IF NOT EXISTS idx_wasabi_object_index_prefix_modified
  ON wasabi_object_index (prefix, last_modified DESC, key);

CREATE INDEX IF NOT EXISTS idx_wasabi_object_index_prefix_key
  ON wasabi_object_index (prefix, key);

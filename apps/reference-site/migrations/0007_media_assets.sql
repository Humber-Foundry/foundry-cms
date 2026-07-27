CREATE TABLE media_assets (
  site_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (
    length(source_hash) = 64 AND source_hash NOT GLOB '*[^a-f0-9]*'
  ),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (site_id, asset_id),
  UNIQUE (object_key)
);

CREATE TABLE media_asset_deletions (
  site_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (site_id, asset_id),
  FOREIGN KEY (site_id, asset_id)
    REFERENCES media_assets(site_id, asset_id)
);

CREATE TABLE media_occurrences (
  site_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  current_asset_id TEXT NOT NULL,
  PRIMARY KEY (site_id, occurrence_id),
  FOREIGN KEY (site_id, current_asset_id)
    REFERENCES media_assets(site_id, asset_id)
);

CREATE TABLE media_occurrence_revisions (
  site_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  crop_json TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (site_id, occurrence_id, revision),
  FOREIGN KEY (site_id, asset_id)
    REFERENCES media_assets(site_id, asset_id)
);

CREATE TABLE media_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'media.asset.uploaded',
      'media.occurrence.replaced',
      'media.occurrence.cropped',
      'media.asset.deleted'
    )
  ),
  subject_id TEXT NOT NULL,
  subject_revision INTEGER,
  occurred_at TEXT NOT NULL
);

CREATE TABLE media_mutation_receipts (
  site_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, idempotency_key)
);

CREATE UNIQUE INDEX media_audit_occurrence_revision
  ON media_audit_events(site_id, action, subject_id, subject_revision)
  WHERE subject_revision IS NOT NULL;

CREATE UNIQUE INDEX media_audit_asset_lifecycle
  ON media_audit_events(site_id, action, subject_id)
  WHERE subject_revision IS NULL;

CREATE INDEX media_occurrences_current_asset
  ON media_occurrences(site_id, current_asset_id);

CREATE TRIGGER media_occurrence_revisions_prevent_update
BEFORE UPDATE ON media_occurrence_revisions
BEGIN
  SELECT RAISE(ABORT, 'media_occurrence_revisions_are_immutable');
END;

CREATE TRIGGER media_occurrence_revisions_prevent_delete
BEFORE DELETE ON media_occurrence_revisions
BEGIN
  SELECT RAISE(ABORT, 'media_occurrence_revisions_are_immutable');
END;

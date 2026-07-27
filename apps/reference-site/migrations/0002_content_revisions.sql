CREATE TABLE content_workspaces (
  site_id TEXT PRIMARY KEY,
  current_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE content_revisions (
  site_id TEXT NOT NULL REFERENCES content_workspaces(site_id),
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  production_base TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (site_id, revision)
);

CREATE TABLE content_revision_receipts (
  idempotency_key TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id, revision)
    REFERENCES content_revisions(site_id, revision)
);

CREATE TRIGGER content_revisions_prevent_update
BEFORE UPDATE ON content_revisions
BEGIN
  SELECT RAISE(ABORT, 'content_revisions_are_immutable');
END;

CREATE TRIGGER content_revisions_prevent_delete
BEFORE DELETE ON content_revisions
BEGIN
  SELECT RAISE(ABORT, 'content_revisions_are_immutable');
END;

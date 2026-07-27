CREATE TABLE content_workspaces (
  workspace_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  production_base TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  current_content_hash TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'archived', 'published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE content_workspace_collaborators (
  workspace_id TEXT NOT NULL REFERENCES content_workspaces(workspace_id),
  actor_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, actor_id)
);

CREATE TABLE content_revisions (
  workspace_id TEXT NOT NULL REFERENCES content_workspaces(workspace_id),
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  production_base TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, revision)
);

CREATE TABLE content_revision_receipts (
  idempotency_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, revision)
    REFERENCES content_revisions(workspace_id, revision)
);

CREATE TABLE content_revision_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'content.revision.created'),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, revision)
    REFERENCES content_revisions(workspace_id, revision)
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

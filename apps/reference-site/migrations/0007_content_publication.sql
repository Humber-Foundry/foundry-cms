CREATE TABLE content_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'site'),
  content_hash TEXT NOT NULL,
  design_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  production_base TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  serialization_version TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, revision)
    REFERENCES content_revisions(workspace_id, revision)
);

CREATE TABLE content_approval_invalidations (
  approval_id TEXT PRIMARY KEY REFERENCES content_approvals(id),
  invalidated_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('superseded', 'revision_changed', 'production_changed')
  )
);

CREATE TABLE content_publications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  approval_id TEXT NOT NULL REFERENCES content_approvals(id),
  fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  contributors_json TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'requested', 'committed', 'building', 'deployed', 'verified-live',
      'blocked', 'failed', 'unknown'
    )
  ),
  commit_sha TEXT,
  detail TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, revision)
    REFERENCES content_revisions(workspace_id, revision)
);

CREATE UNIQUE INDEX content_publications_one_active
ON content_publications ((1))
WHERE status IN ('requested', 'committed', 'building', 'deployed', 'unknown');

CREATE TABLE content_publication_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL REFERENCES content_publications(id),
  status TEXT NOT NULL,
  detail TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TRIGGER content_approvals_prevent_update
BEFORE UPDATE ON content_approvals
BEGIN
  SELECT RAISE(ABORT, 'content_approvals_are_immutable');
END;

CREATE TRIGGER content_approvals_prevent_delete
BEFORE DELETE ON content_approvals
BEGIN
  SELECT RAISE(ABORT, 'content_approvals_are_immutable');
END;

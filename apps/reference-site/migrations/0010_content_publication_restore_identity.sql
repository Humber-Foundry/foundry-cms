CREATE TABLE content_publication_restore_identities (
  workspace_id TEXT PRIMARY KEY,
  source_publication_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_identity TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER content_publication_restore_identities_prevent_update
BEFORE UPDATE ON content_publication_restore_identities
BEGIN
  SELECT RAISE(ABORT, 'content_publication_restore_identity_is_immutable');
END;

CREATE TRIGGER content_publication_restore_identities_prevent_delete
BEFORE DELETE ON content_publication_restore_identities
BEGIN
  SELECT RAISE(ABORT, 'content_publication_restore_identity_is_immutable');
END;

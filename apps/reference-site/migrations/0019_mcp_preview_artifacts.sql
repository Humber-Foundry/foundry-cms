-- Durable MCP preview preparation receipts. These records create review
-- evidence only; they carry no human approval authority.
CREATE TABLE mcp_preview_artifacts (
  preview_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  actor_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, idempotency_key),
  FOREIGN KEY (workspace_id, revision)
    REFERENCES content_revisions(workspace_id, revision)
);

CREATE TRIGGER mcp_preview_artifacts_prevent_update
BEFORE UPDATE ON mcp_preview_artifacts
BEGIN
  SELECT RAISE(ABORT, 'mcp_preview_artifacts_are_immutable');
END;

CREATE TRIGGER mcp_preview_artifacts_prevent_delete
BEFORE DELETE ON mcp_preview_artifacts
BEGIN
  SELECT RAISE(ABORT, 'mcp_preview_artifacts_are_immutable');
END;

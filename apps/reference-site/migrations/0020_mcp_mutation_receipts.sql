-- Join each MCP mutation invocation to its idempotency result and canonical
-- draft/preview artifact without copying request bodies.
ALTER TABLE mcp_audit_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE mcp_audit_events ADD COLUMN result_hash TEXT;
ALTER TABLE mcp_audit_events ADD COLUMN replayed INTEGER CHECK (
  replayed IS NULL OR replayed IN (0, 1)
);
ALTER TABLE mcp_audit_events ADD COLUMN workspace_id TEXT;
ALTER TABLE mcp_audit_events ADD COLUMN revision INTEGER;
ALTER TABLE mcp_audit_events ADD COLUMN content_hash TEXT;
ALTER TABLE mcp_audit_events ADD COLUMN preview_id TEXT;

CREATE TABLE mcp_mutation_receipts (
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation IN (
      'foundry.workspace.open',
      'foundry.content.patch',
      'foundry.design.patch',
      'foundry.preview.prepare'
    )
  ),
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  result_state TEXT NOT NULL CHECK (
    result_state IN ('succeeded', 'failed')
  ),
  workspace_id TEXT,
  revision INTEGER,
  content_hash TEXT,
  preview_id TEXT,
  error_code TEXT,
  error_message TEXT,
  latest_revision INTEGER,
  conflict_resource TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  created_at TEXT NOT NULL,
  CHECK (
    (
      result_state = 'succeeded'
      AND workspace_id IS NOT NULL
      AND revision IS NOT NULL
      AND content_hash IS NOT NULL
      AND error_code IS NULL
      AND error_message IS NULL
      AND latest_revision IS NULL
      AND conflict_resource IS NULL
    )
    OR (
      result_state = 'failed'
      AND workspace_id IS NULL
      AND revision IS NULL
      AND content_hash IS NULL
      AND preview_id IS NULL
      AND error_code IS NOT NULL
      AND error_message IS NOT NULL
    )
  ),
  PRIMARY KEY (site_id, actor_id, operation, idempotency_key)
);

CREATE INDEX mcp_mutation_receipts_workspace_revision
  ON mcp_mutation_receipts (site_id, workspace_id, revision);

CREATE TRIGGER mcp_mutation_receipts_preserve_result
BEFORE UPDATE OF
  site_id, actor_id, operation, idempotency_key, input_hash, invocation_id,
  result_hash, result_state, workspace_id, revision, content_hash, preview_id,
  error_code, error_message, latest_revision, conflict_resource, created_at
ON mcp_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mcp_mutation_receipt_result_is_immutable');
END;

CREATE TRIGGER mcp_mutation_receipts_prevent_delete
BEFORE DELETE ON mcp_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mcp_mutation_receipts_are_immutable');
END;

-- `foundry.page.restructure` records its receipts in the same table as every
-- other MCP draft mutation, so the allowed operation list has to name it.
-- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt and
-- its rows are carried over, the same way 0030 named the four page operations.
DROP TRIGGER mcp_mutation_receipts_preserve_result;
DROP TRIGGER mcp_mutation_receipts_prevent_delete;
DROP INDEX mcp_mutation_receipts_workspace_revision;

ALTER TABLE mcp_mutation_receipts RENAME TO mcp_mutation_receipts_previous;

CREATE TABLE mcp_mutation_receipts (
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation IN (
      'foundry.workspace.open',
      'foundry.content.patch',
      'foundry.design.patch',
      'foundry.page.create',
      'foundry.page.rename',
      'foundry.page.duplicate',
      'foundry.page.delete',
      'foundry.page.restructure',
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
  error_reason TEXT,
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
      AND error_reason IS NULL
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

INSERT INTO mcp_mutation_receipts (
  site_id, actor_id, operation, idempotency_key, input_hash, invocation_id,
  result_hash, result_state, workspace_id, revision, content_hash, preview_id,
  error_code, error_message, error_reason, latest_revision, conflict_resource,
  replay_count, created_at
)
SELECT
  site_id, actor_id, operation, idempotency_key, input_hash, invocation_id,
  result_hash, result_state, workspace_id, revision, content_hash, preview_id,
  error_code, error_message, error_reason, latest_revision, conflict_resource,
  replay_count, created_at
FROM mcp_mutation_receipts_previous;

DROP TABLE mcp_mutation_receipts_previous;

CREATE INDEX mcp_mutation_receipts_workspace_revision
  ON mcp_mutation_receipts (site_id, workspace_id, revision);

CREATE TRIGGER mcp_mutation_receipts_preserve_result
BEFORE UPDATE OF
  site_id, actor_id, operation, idempotency_key, input_hash, invocation_id,
  result_hash, result_state, workspace_id, revision, content_hash, preview_id,
  error_code, error_message, error_reason, latest_revision, conflict_resource,
  created_at
ON mcp_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mcp_mutation_receipt_result_is_immutable');
END;

CREATE TRIGGER mcp_mutation_receipts_prevent_delete
BEFORE DELETE ON mcp_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mcp_mutation_receipts_are_immutable');
END;

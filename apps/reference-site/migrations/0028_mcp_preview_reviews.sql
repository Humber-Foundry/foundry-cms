-- A person's decision on one preview an MCP connection prepared.
-- The row is the record of a deliberate human act on one exact preview.
-- An approval decision points at the immutable approval it created; a
-- change request carries the reason the person typed. One preview holds one
-- decision: a later draft produces a new revision and a new preview.
CREATE TABLE mcp_preview_reviews (
  preview_id TEXT PRIMARY KEY
    REFERENCES mcp_preview_artifacts(preview_id),
  site_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('approved', 'changes_requested')),
  approval_id TEXT REFERENCES content_approvals(id),
  reason TEXT,
  decided_by TEXT NOT NULL REFERENCES human_memberships(id),
  decided_at TEXT NOT NULL,
  CHECK (
    (decision = 'approved'
      AND approval_id IS NOT NULL
      AND reason IS NULL)
    OR (decision = 'changes_requested'
      AND approval_id IS NULL
      AND reason IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, revision)
    REFERENCES content_revisions(workspace_id, revision)
);

-- Overview asks one question on every load: which previews for this site have
-- no decision yet, newest first. `mcp_preview_artifacts` is append-only, so it
-- only grows and that read needs its own index.
CREATE INDEX mcp_preview_artifacts_site_created
  ON mcp_preview_artifacts (site_id, created_at);

CREATE TRIGGER mcp_preview_reviews_prevent_update
BEFORE UPDATE ON mcp_preview_reviews
BEGIN
  SELECT RAISE(ABORT, 'mcp_preview_reviews_are_immutable');
END;

CREATE TRIGGER mcp_preview_reviews_prevent_delete
BEFORE DELETE ON mcp_preview_reviews
BEGIN
  SELECT RAISE(ABORT, 'mcp_preview_reviews_are_immutable');
END;

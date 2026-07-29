CREATE TABLE blog_post_render_artifacts (
  workspace_id TEXT NOT NULL,
  content_revision INTEGER NOT NULL CHECK (content_revision >= 0),
  post_id TEXT NOT NULL,
  post_revision_id TEXT NOT NULL,
  post_revision INTEGER NOT NULL CHECK (post_revision >= 1),
  content_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  serialization_version TEXT NOT NULL,
  rendered_bytes_hash TEXT NOT NULL,
  artifact_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, content_revision, post_id),
  FOREIGN KEY (workspace_id, content_revision)
    REFERENCES content_revisions(workspace_id, revision),
  FOREIGN KEY (post_revision_id)
    REFERENCES blog_post_revisions(revision_id)
);

CREATE TRIGGER blog_post_render_artifacts_prevent_update
BEFORE UPDATE ON blog_post_render_artifacts
BEGIN
  SELECT RAISE(ABORT, 'blog_post_render_artifact_is_immutable');
END;

CREATE TRIGGER blog_post_render_artifacts_prevent_delete
BEFORE DELETE ON blog_post_render_artifacts
BEGIN
  SELECT RAISE(ABORT, 'blog_post_render_artifact_is_immutable');
END;

CREATE TABLE blog_post_rejection_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (
    command_type IN ('blog.post.create', 'blog.post.edit', 'blog.post.unpublish')
  ),
  reason_code TEXT NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TRIGGER blog_post_rejection_audit_prevent_update
BEFORE UPDATE ON blog_post_rejection_audit_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_rejection_audit_is_immutable');
END;

CREATE TRIGGER blog_post_rejection_audit_prevent_delete
BEFORE DELETE ON blog_post_rejection_audit_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_rejection_audit_is_immutable');
END;

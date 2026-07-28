CREATE TABLE blog_post_transition_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (
    command_type IN ('blog.post.create', 'blog.post.edit', 'blog.post.unpublish')
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  reason_code TEXT NOT NULL,
  request_id TEXT NOT NULL,
  before_state_json TEXT,
  after_state_json TEXT,
  revision INTEGER,
  occurred_at TEXT NOT NULL,
  UNIQUE (workspace_id, request_id, outcome, post_id)
);

CREATE TRIGGER blog_post_transition_audit_prevent_update
BEFORE UPDATE ON blog_post_transition_audit_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_transition_audit_is_immutable');
END;

CREATE TRIGGER blog_post_transition_audit_prevent_delete
BEFORE DELETE ON blog_post_transition_audit_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_transition_audit_is_immutable');
END;

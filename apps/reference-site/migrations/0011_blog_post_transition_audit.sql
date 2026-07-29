CREATE TABLE blog_posts (
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  collection_state TEXT NOT NULL CHECK (collection_state = 'active'),
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  current_revision_id TEXT,
  live_revision INTEGER CHECK (live_revision IS NULL OR live_revision >= 1),
  last_verified_revision INTEGER CHECK (
    last_verified_revision IS NULL OR last_verified_revision >= 1
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, post_id)
);

CREATE TABLE blog_post_revisions (
  revision_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  workspace_id TEXT NOT NULL,
  content_revision INTEGER NOT NULL CHECK (content_revision >= 0),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY (site_id, post_id) REFERENCES blog_posts(site_id, post_id)
);

CREATE TRIGGER blog_post_revisions_prevent_update
BEFORE UPDATE ON blog_post_revisions
BEGIN
  SELECT RAISE(ABORT, 'blog_post_revision_is_immutable');
END;

CREATE TRIGGER blog_post_revisions_prevent_delete
BEFORE DELETE ON blog_post_revisions
BEGIN
  SELECT RAISE(ABORT, 'blog_post_revision_is_immutable');
END;

CREATE TABLE blog_post_transition_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (
    command_type IN (
      'blog.post.create',
      'blog.post.edit',
      'blog.post.unpublish',
      'blog.post.republish'
    )
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

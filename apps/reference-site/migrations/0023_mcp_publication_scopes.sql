-- MCP publication grants extend the normalized connection scope set.
DROP TRIGGER mcp_connection_scopes_prevent_update;
DROP TRIGGER mcp_connection_scopes_prevent_delete;
DROP INDEX mcp_connection_scopes_scope;

ALTER TABLE mcp_connection_scopes RENAME TO mcp_connection_scopes_previous;

CREATE TABLE mcp_connection_scopes (
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  scope TEXT NOT NULL CHECK (
    scope IN (
      'site.read',
      'content.draft',
      'design.draft',
      'publication.schedule',
      'publication.publish'
    )
  ),
  PRIMARY KEY (connection_id, scope)
);

INSERT INTO mcp_connection_scopes (connection_id, scope)
SELECT connection_id, scope
FROM mcp_connection_scopes_previous;

DROP TABLE mcp_connection_scopes_previous;

CREATE INDEX mcp_connection_scopes_scope
  ON mcp_connection_scopes (scope, connection_id);

CREATE TRIGGER mcp_connection_scopes_prevent_update
BEFORE UPDATE ON mcp_connection_scopes
BEGIN
  SELECT RAISE(ABORT, 'mcp_connection_scope_is_immutable');
END;

CREATE TRIGGER mcp_connection_scopes_prevent_delete
BEFORE DELETE ON mcp_connection_scopes
BEGIN
  SELECT RAISE(ABORT, 'mcp_connection_scope_is_immutable');
END;

ALTER TABLE mcp_audit_events ADD COLUMN approval_id TEXT;
ALTER TABLE mcp_audit_events ADD COLUMN publication_id TEXT;
ALTER TABLE mcp_audit_events ADD COLUMN schedule_id TEXT;

ALTER TABLE content_publications ADD COLUMN mcp_connection_id TEXT
  REFERENCES mcp_connections(id);
ALTER TABLE content_publications ADD COLUMN mcp_actor_id TEXT;
ALTER TABLE content_publications ADD COLUMN mcp_operation TEXT CHECK (
  mcp_operation IN (
    'foundry.publication.request',
    'foundry.publication.schedule'
  )
);
ALTER TABLE content_publications ADD COLUMN mcp_required_scopes_json TEXT
  CHECK (
    mcp_required_scopes_json IS NULL OR
    json_valid(mcp_required_scopes_json)
  );

CREATE TABLE mcp_blog_schedule_authorities (
  schedule_id TEXT PRIMARY KEY REFERENCES blog_post_schedules(id),
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (
    operation = 'foundry.publication.schedule'
  ),
  required_scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER mcp_blog_schedule_authorities_prevent_update
BEFORE UPDATE ON mcp_blog_schedule_authorities
BEGIN
  SELECT RAISE(ABORT, 'mcp_blog_schedule_authority_is_immutable');
END;

CREATE TRIGGER mcp_blog_schedule_authorities_prevent_delete
BEFORE DELETE ON mcp_blog_schedule_authorities
BEGIN
  SELECT RAISE(ABORT, 'mcp_blog_schedule_authority_is_immutable');
END;

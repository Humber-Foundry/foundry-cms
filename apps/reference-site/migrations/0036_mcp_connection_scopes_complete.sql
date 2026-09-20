-- Every permission the product supports must be storable.
--
-- `mcp_connection_scopes` still listed only the five permissions that existed
-- when 0024 was written, so an Owner's consent to `campaign.draft`,
-- `campaign.test` or `analytics.read` was refused by this CHECK and the
-- campaign and analytics tools could never be granted at all. The list is
-- rebuilt here from `mcpSupportedScopes`, the application's own set. Rebuild
-- rather than relax: SQLite cannot alter a CHECK in place, and this follows
-- the same steps 0024 followed.
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
      'publication.publish',
      'campaign.draft',
      'campaign.test',
      'analytics.read'
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

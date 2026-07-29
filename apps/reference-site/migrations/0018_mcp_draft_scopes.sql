-- Incremental MCP scope grants. The connection row keeps its v1 read-only
-- compatibility value while this normalized table is authoritative.
CREATE TABLE mcp_connection_scopes (
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  scope TEXT NOT NULL CHECK (
    scope IN ('site.read', 'content.draft', 'design.draft')
  ),
  PRIMARY KEY (connection_id, scope)
);

INSERT INTO mcp_connection_scopes (connection_id, scope)
SELECT id, 'site.read'
FROM mcp_connections;

CREATE INDEX mcp_connection_scopes_scope
  ON mcp_connection_scopes (scope, connection_id);

ALTER TABLE mcp_authorization_codes
ADD COLUMN granted_scopes_json TEXT NOT NULL DEFAULT '["site.read"]';

ALTER TABLE mcp_refresh_tokens
ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["site.read"]';

CREATE TRIGGER mcp_authorization_code_scopes_are_immutable
BEFORE UPDATE OF granted_scopes_json ON mcp_authorization_codes
BEGIN
  SELECT RAISE(ABORT, 'mcp_authorization_code_scopes_are_immutable');
END;

CREATE TRIGGER mcp_refresh_token_scopes_are_immutable
BEFORE UPDATE OF scopes_json ON mcp_refresh_tokens
BEGIN
  SELECT RAISE(ABORT, 'mcp_refresh_token_scopes_are_immutable');
END;

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

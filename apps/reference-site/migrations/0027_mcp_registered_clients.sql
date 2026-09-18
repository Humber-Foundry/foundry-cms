-- Dynamically registered MCP OAuth clients (RFC 7591).
--
-- A row here is a name and a set of return addresses. It grants nothing. A
-- connection, an actor and a scope only exist after an Owner approves the
-- client on the consent screen behind human sign-in. Every text field came
-- from an unauthenticated request, so treat it as untrusted text.
CREATE TABLE mcp_registered_clients (
  site_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 120),
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  response_types_json TEXT NOT NULL
    CHECK (response_types_json = '["code"]'),
  token_endpoint_auth_method TEXT NOT NULL
    CHECK (token_endpoint_auth_method = 'none'),
  client_uri TEXT,
  logo_uri TEXT,
  software_id TEXT,
  software_version TEXT,
  requested_scope TEXT,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (site_id, client_id)
);

CREATE INDEX mcp_registered_clients_site
  ON mcp_registered_clients (site_id, registered_at);

-- Registered client metadata is the record of what the client claimed at
-- registration. Changing it later would change what the Owner consented to.
CREATE TRIGGER mcp_registered_clients_are_immutable
BEFORE UPDATE ON mcp_registered_clients
BEGIN
  SELECT RAISE(ABORT, 'mcp_registered_client_metadata_is_immutable');
END;

CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL UNIQUE,
  site_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (scopes_json = '["site.read"]'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by_membership_id TEXT NOT NULL REFERENCES human_memberships(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX mcp_connections_site_status
  ON mcp_connections (site_id, status);

CREATE TABLE mcp_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  refresh_token_hash TEXT,
  refresh_family_id TEXT,
  refresh_expires_at TEXT
);

CREATE TABLE mcp_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  oauth_client_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT,
  replacement_hash TEXT,
  revoked_at TEXT
);

CREATE INDEX mcp_refresh_tokens_family
  ON mcp_refresh_tokens (family_id, revoked_at);

CREATE TABLE mcp_rate_limit_buckets (
  site_id TEXT NOT NULL,
  bucket_key TEXT NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 128),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (site_id, bucket_key, window_started_at)
);

CREATE INDEX mcp_rate_limit_buckets_retention
  ON mcp_rate_limit_buckets (site_id, window_started_at);

CREATE TABLE mcp_audit_events (
  invocation_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
  actor_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  reason TEXT,
  human_actor_id TEXT,
  revocation_reason TEXT,
  occurred_at TEXT NOT NULL,
  contract_version TEXT NOT NULL
);

CREATE TRIGGER mcp_audit_events_prevent_update
BEFORE UPDATE ON mcp_audit_events
BEGIN
  SELECT RAISE(ABORT, 'mcp_audit_events_are_immutable');
END;

CREATE TRIGGER mcp_audit_events_prevent_delete
BEFORE DELETE ON mcp_audit_events
BEGIN
  SELECT RAISE(ABORT, 'mcp_audit_events_are_immutable');
END;

CREATE TRIGGER mcp_connections_preserve_identity
BEFORE UPDATE OF actor_id, site_id, oauth_client_id, redirect_uri,
  created_by_membership_id, created_at ON mcp_connections
BEGIN
  SELECT RAISE(ABORT, 'mcp_connection_identity_is_immutable');
END;

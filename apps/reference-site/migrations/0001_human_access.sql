PRAGMA foreign_keys = ON;

CREATE TABLE human_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE human_external_identities (
  site_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES human_users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, issuer, subject)
);

CREATE TABLE human_memberships (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES human_users(id),
  email TEXT NOT NULL,
  identity_issuer TEXT NOT NULL,
  identity_subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, user_id)
);

CREATE INDEX human_memberships_site_status_role
  ON human_memberships (site_id, status, role);

CREATE UNIQUE INDEX human_memberships_one_current_email
  ON human_memberships (site_id, email)
  WHERE status <> 'revoked';

CREATE TABLE human_invitations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_access_sync',
      'pending_acceptance',
      'claimed',
      'revoked',
      'expired'
    )
  ),
  expires_at TEXT NOT NULL,
  invited_by_membership_id TEXT REFERENCES human_memberships(id),
  claimed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX human_invitations_one_claimable_email
  ON human_invitations (site_id, email)
  WHERE status IN ('pending_access_sync', 'pending_acceptance');

CREATE TABLE human_access_sync_outbox (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE human_access_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE human_mutation_receipts (
  idempotency_key TEXT PRIMARY KEY,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TRIGGER human_memberships_preserve_last_owner
BEFORE UPDATE OF role, status ON human_memberships
WHEN OLD.role = 'owner'
  AND OLD.status = 'active'
  AND (NEW.role <> 'owner' OR NEW.status <> 'active')
  AND (
    SELECT COUNT(*)
    FROM human_memberships
    WHERE site_id = OLD.site_id
      AND role = 'owner'
      AND status = 'active'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_owner');
END;

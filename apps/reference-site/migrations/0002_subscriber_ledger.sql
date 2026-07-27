CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  email TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('active', 'unsubscribed', 'complained', 'hard_bounced', 'erased')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, identity_key),
  CHECK (
    (state = 'erased' AND email IS NULL)
    OR (state <> 'erased' AND email IS NOT NULL)
  )
);

CREATE INDEX subscribers_site_state
  ON subscribers (site_id, state);

CREATE TABLE subscriber_ledger_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'consent_recorded',
      'resubscribed',
      'unsubscribed',
      'complained',
      'hard_bounced',
      'erased'
    )
  ),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'provider')),
  actor_membership_id TEXT,
  provider TEXT,
  provider_event_id TEXT,
  evidence_json TEXT,
  CHECK (
    (
      actor_type = 'human'
      AND actor_membership_id IS NOT NULL
      AND provider IS NULL
      AND provider_event_id IS NULL
    )
    OR (
      actor_type = 'provider'
      AND actor_membership_id IS NULL
      AND provider IS NOT NULL
      AND provider_event_id IS NOT NULL
    )
  ),
  CHECK (
    (
      event_type IN ('consent_recorded', 'resubscribed')
      AND evidence_json IS NOT NULL
    )
    OR (
      event_type NOT IN ('consent_recorded', 'resubscribed')
      AND evidence_json IS NULL
    )
  )
);

CREATE INDEX subscriber_ledger_events_site_recorded
  ON subscriber_ledger_events (site_id, recorded_at, id);

CREATE UNIQUE INDEX subscriber_provider_event_once
  ON subscriber_ledger_events (site_id, provider, provider_event_id)
  WHERE actor_type = 'provider';

CREATE TABLE subscriber_sensitive_access_audit (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  actor_membership_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('subscriber-identities.read', 'subscriber-ledger.export')
  ),
  occurred_at TEXT NOT NULL
);

CREATE TRIGGER subscriber_ledger_events_immutable_update
BEFORE UPDATE ON subscriber_ledger_events
BEGIN
  SELECT RAISE(ABORT, 'subscriber_ledger_events_are_immutable');
END;

CREATE TRIGGER subscriber_ledger_events_immutable_delete
BEFORE DELETE ON subscriber_ledger_events
BEGIN
  SELECT RAISE(ABORT, 'subscriber_ledger_events_are_immutable');
END;

CREATE TRIGGER subscriber_sensitive_access_audit_immutable_update
BEFORE UPDATE ON subscriber_sensitive_access_audit
BEGIN
  SELECT RAISE(ABORT, 'subscriber_access_audit_is_immutable');
END;

CREATE TRIGGER subscriber_sensitive_access_audit_immutable_delete
BEFORE DELETE ON subscriber_sensitive_access_audit
BEGIN
  SELECT RAISE(ABORT, 'subscriber_access_audit_is_immutable');
END;

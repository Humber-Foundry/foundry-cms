CREATE UNIQUE INDEX campaign_revisions_delivery_identity
ON campaign_revisions (id, site_id, campaign_id);

CREATE TABLE campaign_test_deliveries (
  execution_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_revision_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  recipient_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'pending', 'attempting', 'ambiguous', 'accepted', 'failed', 'cancelled'
    )
  ),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 0),
  attempt_lease_until TEXT,
  provider_campaign_id TEXT,
  provider_message_id TEXT,
  foundry_send_proof TEXT CHECK (
    foundry_send_proof IS NULL OR (
      length(foundry_send_proof) = 64
      AND foundry_send_proof NOT GLOB '*[^0-9a-f]*'
    )
  ),
  failure_code TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, actor_id, request_id),
  CHECK (
    (state = 'accepted' AND evidence_json IS NOT NULL
      AND provider_campaign_id IS NOT NULL
      AND provider_message_id IS NOT NULL
      AND foundry_send_proof IS NOT NULL AND failure_code IS NULL) OR
    (state = 'failed' AND evidence_json IS NULL
      AND provider_message_id IS NULL
      AND failure_code IN (
        'foundry_send_proof_invalid',
        'provider_campaign_create_rejected',
        'provider_campaign_fingerprint_mismatch',
        'provider_campaign_not_found',
        'provider_sender_unmapped',
        'provider_test_definitively_not_delivered',
        'provider_test_daily_recipient_limit',
        'provider_test_rejected',
        'provider_unavailable',
        'test_recipient_binding_changed',
        'test_recipient_forbidden'
      )) OR
    (state = 'cancelled' AND evidence_json IS NULL
      AND provider_message_id IS NULL
      AND failure_code = 'campaign_revision_changed') OR
    (state IN ('pending', 'attempting') AND evidence_json IS NULL
      AND provider_message_id IS NULL
      AND failure_code IS NULL) OR
    (state = 'ambiguous' AND evidence_json IS NULL
      AND provider_message_id IS NULL
      AND (failure_code IS NULL OR failure_code IN (
        'foundry_send_proof_invalid',
        'provider_campaign_create_rejected',
        'provider_campaign_fingerprint_mismatch',
        'provider_campaign_not_found',
        'provider_rate_limited',
        'provider_sender_unmapped',
        'provider_test_rejected',
        'provider_unavailable'
      )))
  ),
  FOREIGN KEY (site_id, campaign_id)
    REFERENCES campaigns(site_id, id),
  FOREIGN KEY (campaign_revision_id, site_id, campaign_id)
    REFERENCES campaign_revisions(id, site_id, campaign_id)
);

CREATE INDEX campaign_test_deliveries_current_evidence
ON campaign_test_deliveries (
  site_id, campaign_id, state, updated_at DESC
);

CREATE UNIQUE INDEX campaign_test_deliveries_webhook_identity
ON campaign_test_deliveries (execution_id, site_id);

CREATE TABLE campaign_test_brevo_webhook_evidence (
  event_fingerprint TEXT PRIMARY KEY CHECK (
    length(event_fingerprint) = 64
    AND event_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  site_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  foundry_send_proof TEXT NOT NULL CHECK (
    length(foundry_send_proof) = 64
    AND foundry_send_proof NOT GLOB '*[^0-9a-f]*'
  ),
  provider_message_id TEXT NOT NULL,
  recipient_fingerprint TEXT NOT NULL CHECK (
    length(recipient_fingerprint) = 64
    AND recipient_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (execution_id, site_id)
    REFERENCES campaign_test_deliveries(execution_id, site_id)
);

CREATE INDEX campaign_test_brevo_webhook_lookup
ON campaign_test_brevo_webhook_evidence (
  site_id, execution_id, foundry_send_proof, occurred_at
);

CREATE TRIGGER campaign_test_brevo_webhook_evidence_prevent_update
BEFORE UPDATE ON campaign_test_brevo_webhook_evidence
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_brevo_webhook_evidence_is_immutable');
END;

CREATE TRIGGER campaign_test_brevo_webhook_evidence_prevent_delete
BEFORE DELETE ON campaign_test_brevo_webhook_evidence
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_brevo_webhook_evidence_is_immutable');
END;

CREATE TABLE campaign_test_receipt_confirmations (
  execution_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE (site_id, owner_actor_id, request_id),
  FOREIGN KEY (execution_id) REFERENCES campaign_test_deliveries(execution_id)
);

CREATE TRIGGER campaign_test_receipt_confirmations_prevent_update
BEFORE UPDATE ON campaign_test_receipt_confirmations
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_receipt_confirmation_is_immutable');
END;

CREATE TRIGGER campaign_test_receipt_confirmations_prevent_delete
BEFORE DELETE ON campaign_test_receipt_confirmations
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_receipt_confirmation_is_immutable');
END;

CREATE TABLE campaign_test_recipient_budget (
  account_scope_fingerprint TEXT NOT NULL,
  budget_day TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 1 AND 5),
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (
    account_scope_fingerprint, budget_day, execution_id, attempt_number
  ),
  FOREIGN KEY (execution_id) REFERENCES campaign_test_deliveries(execution_id)
);

CREATE TRIGGER campaign_test_recipient_budget_prevent_update
BEFORE UPDATE ON campaign_test_recipient_budget
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_recipient_budget_is_immutable');
END;

CREATE TRIGGER campaign_test_recipient_budget_prevent_delete
BEFORE DELETE ON campaign_test_recipient_budget
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_recipient_budget_is_immutable');
END;

CREATE TRIGGER campaign_test_deliveries_prevent_terminal_update
BEFORE UPDATE ON campaign_test_deliveries
WHEN OLD.state IN ('accepted', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_delivery_is_terminal');
END;

CREATE TRIGGER campaign_test_deliveries_prevent_delete
BEFORE DELETE ON campaign_test_deliveries
BEGIN
  SELECT RAISE(ABORT, 'campaign_test_delivery_is_immutable');
END;

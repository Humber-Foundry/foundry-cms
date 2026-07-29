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
  failure_code TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, actor_id, request_id),
  FOREIGN KEY (site_id, campaign_id) REFERENCES campaigns(site_id, id),
  FOREIGN KEY (campaign_revision_id) REFERENCES campaign_revisions(id),
  CHECK (
    (state = 'accepted' AND evidence_json IS NOT NULL
      AND provider_campaign_id IS NOT NULL AND failure_code IS NULL) OR
    (state = 'failed' AND evidence_json IS NULL
      AND failure_code IS NOT NULL) OR
    (state = 'cancelled' AND evidence_json IS NULL
      AND failure_code IS NOT NULL) OR
    (state IN ('pending', 'attempting') AND evidence_json IS NULL
      AND failure_code IS NULL) OR
    (state = 'ambiguous' AND evidence_json IS NULL
      AND (failure_code IS NULL OR failure_code = 'provider_rate_limited'))
  )
);

CREATE INDEX campaign_test_deliveries_current_evidence
ON campaign_test_deliveries (
  site_id, campaign_id, state, updated_at DESC
);

CREATE TABLE campaign_test_receipt_confirmations (
  execution_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
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

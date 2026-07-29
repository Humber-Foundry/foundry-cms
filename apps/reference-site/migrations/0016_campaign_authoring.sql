CREATE TABLE campaigns (
  id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, id)
);

CREATE TABLE campaign_revisions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  revision_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, campaign_id, revision_number),
  FOREIGN KEY (site_id, campaign_id) REFERENCES campaigns(site_id, id)
);

CREATE TABLE campaign_audit_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  campaign_revision_id TEXT,
  reason TEXT,
  before_state TEXT,
  after_state TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (campaign_revision_id) REFERENCES campaign_revisions(id)
);

CREATE TABLE campaign_command_receipts (
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'accepted', 'rejected')),
  result_json TEXT,
  reason TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (site_id, actor_id, command_name, request_id),
  CHECK (
    (outcome = 'pending' AND result_json IS NULL AND reason IS NULL) OR
    (outcome = 'accepted' AND result_json IS NOT NULL AND reason IS NULL) OR
    (outcome = 'rejected' AND result_json IS NULL AND reason IS NOT NULL)
  )
);

CREATE TRIGGER campaign_command_receipts_prevent_terminal_update
BEFORE UPDATE ON campaign_command_receipts
WHEN OLD.outcome != 'pending'
BEGIN
  SELECT RAISE(ABORT, 'campaign_command_receipt_is_immutable');
END;

CREATE TRIGGER campaign_command_receipts_prevent_delete
BEFORE DELETE ON campaign_command_receipts
BEGIN
  SELECT RAISE(ABORT, 'campaign_command_receipt_is_immutable');
END;

CREATE TRIGGER campaign_audit_events_prevent_update
BEFORE UPDATE ON campaign_audit_events
BEGIN
  SELECT RAISE(ABORT, 'campaign_audit_is_immutable');
END;

CREATE TRIGGER campaign_audit_events_prevent_delete
BEFORE DELETE ON campaign_audit_events
BEGIN
  SELECT RAISE(ABORT, 'campaign_audit_is_immutable');
END;

CREATE TRIGGER campaign_revisions_prevent_update
BEFORE UPDATE ON campaign_revisions
BEGIN
  SELECT RAISE(ABORT, 'campaign_revision_is_immutable');
END;

CREATE TRIGGER campaign_revisions_prevent_delete
BEFORE DELETE ON campaign_revisions
BEGIN
  SELECT RAISE(ABORT, 'campaign_revision_is_immutable');
END;

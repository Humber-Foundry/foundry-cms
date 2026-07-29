CREATE TABLE campaigns (
  id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  test_delivery_id TEXT,
  bulk_authorization_id TEXT,
  active_schedule_id TEXT,
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
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  campaign_revision_id TEXT,
  reason TEXT,
  before_state TEXT,
  after_state TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (campaign_revision_id) REFERENCES campaign_revisions(id)
);

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

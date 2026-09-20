-- One app's request to send a newsletter at a named time, and a person's
-- decision to decline it. A request records what was asked and nothing more:
-- it creates no schedule, authorizes no send, and never names a subscriber.
-- A person turns a request into a real send through the Newsletter screen's
-- own controls, which still need the Owner's confirmed test and approval.
-- See ADR-0039, and ADR-0036 and ADR-0038 for the blog request this copies.
CREATE TABLE campaign_schedule_proposals (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_revision_id TEXT NOT NULL REFERENCES campaign_revisions(id),
  campaign_version INTEGER NOT NULL CHECK (campaign_version >= 1),
  local_date_time TEXT NOT NULL,
  iana_time_zone TEXT NOT NULL,
  utc_offset_choice TEXT NOT NULL,
  execute_at_utc TEXT NOT NULL,
  time_zone_database_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, campaign_id, request_id),
  FOREIGN KEY (site_id, campaign_id) REFERENCES campaigns(site_id, id)
);

CREATE TRIGGER campaign_schedule_proposals_prevent_update
BEFORE UPDATE ON campaign_schedule_proposals
BEGIN
  SELECT RAISE(ABORT, 'campaign_schedule_proposal_is_immutable');
END;

CREATE TRIGGER campaign_schedule_proposals_prevent_delete
BEFORE DELETE ON campaign_schedule_proposals
BEGIN
  SELECT RAISE(ABORT, 'campaign_schedule_proposal_is_immutable');
END;

-- Overview and the Newsletter screen both ask the same question: for this
-- campaign, what is the newest request? Index that lookup.
CREATE INDEX campaign_schedule_proposals_site_campaign_created
  ON campaign_schedule_proposals (site_id, campaign_id, created_at);

-- A person's decision to decline one request. One decline per request, and it
-- cannot be taken back, matching mcp_preview_reviews (ADR-0025) and
-- blog_post_schedule_proposal_declines (ADR-0038). There is no MCP variant:
-- an agent may not answer its own request.
CREATE TABLE campaign_schedule_proposal_declines (
  proposal_id TEXT PRIMARY KEY
    REFERENCES campaign_schedule_proposals(id),
  site_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  declined_by TEXT NOT NULL REFERENCES human_memberships(id),
  declined_at TEXT NOT NULL
);

CREATE TRIGGER campaign_schedule_proposal_declines_prevent_update
BEFORE UPDATE ON campaign_schedule_proposal_declines
BEGIN
  SELECT RAISE(ABORT, 'campaign_schedule_proposal_decline_is_immutable');
END;

CREATE TRIGGER campaign_schedule_proposal_declines_prevent_delete
BEFORE DELETE ON campaign_schedule_proposal_declines
BEGIN
  SELECT RAISE(ABORT, 'campaign_schedule_proposal_decline_is_immutable');
END;

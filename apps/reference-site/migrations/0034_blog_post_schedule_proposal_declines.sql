-- A person's decision to decline one blog post schedule request an app
-- made. One decline per request, immutable, matching mcp_preview_reviews
-- (see ADR-0025) and blog_post_schedule_cancellations. See ADR-0036 and
-- issue #219.
CREATE TABLE blog_post_schedule_proposal_declines (
  proposal_id TEXT PRIMARY KEY
    REFERENCES blog_post_schedule_proposals(id),
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  declined_by TEXT NOT NULL REFERENCES human_memberships(id),
  declined_at TEXT NOT NULL,
  FOREIGN KEY (site_id, post_id) REFERENCES blog_posts(site_id, post_id)
);

CREATE TRIGGER blog_post_schedule_proposal_declines_prevent_update
BEFORE UPDATE ON blog_post_schedule_proposal_declines
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_proposal_declines_are_immutable');
END;

CREATE TRIGGER blog_post_schedule_proposal_declines_prevent_delete
BEFORE DELETE ON blog_post_schedule_proposal_declines
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_proposal_declines_are_immutable');
END;

-- Overview and a post's own schedule controls both ask the same question:
-- for this post, what is the newest schedule request? Index the lookup.
CREATE INDEX blog_post_schedule_proposals_site_post_created
  ON blog_post_schedule_proposals (site_id, post_id, created_at);

PRAGMA foreign_keys = ON;

-- Newsletter signup with double opt-in.
--
-- A pending signup request is not a subscriber. It holds the address only for
-- as long as a confirmation message could still be opened. The moment the
-- request is confirmed, superseded or expired, the address is cleared here and
-- the subscriber ledger is the only place it remains.

-- `refused` records a confirmation this site would not act on: the address is
-- erased or has reported our mail as spam. It must not be recorded as
-- `confirmed`, because no consent was written.
CREATE TABLE newsletter_signup_requests (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  email TEXT,
  disclosure_version TEXT NOT NULL,
  collection_surface TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'confirmed', 'expired', 'superseded', 'refused')
  ),
  settled_at TEXT,
  -- An address may only be held while the request is still pending.
  CHECK (
    (state = 'pending' AND email IS NOT NULL AND settled_at IS NULL)
    OR (state <> 'pending' AND email IS NULL AND settled_at IS NOT NULL)
  ),
  UNIQUE (site_id, submission_id)
);

-- One pending request per address at a time. A second signup supersedes the
-- first, so two live confirmation links can never both create a subscriber.
CREATE UNIQUE INDEX newsletter_signup_pending_once
  ON newsletter_signup_requests (site_id, identity_key)
  WHERE state = 'pending';

CREATE INDEX newsletter_signup_expiry
  ON newsletter_signup_requests (state, expires_at);

CREATE TABLE newsletter_confirmation_jobs (
  request_id TEXT PRIMARY KEY
    REFERENCES newsletter_signup_requests(id),
  site_id TEXT NOT NULL,
  address TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'sent', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  first_available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX newsletter_confirmation_jobs_due
  ON newsletter_confirmation_jobs (site_id, status, available_at, lease_until);

-- A settled request must not leave a job holding the address behind. Removing
-- the job here is what clears the address, so every path that stops a request
-- being confirmable — confirmed, refused, expired or superseded — drops the
-- address with it.
CREATE TRIGGER newsletter_signup_settled_clears_job
AFTER UPDATE OF state ON newsletter_signup_requests
WHEN NEW.state <> 'pending' AND OLD.state = 'pending'
BEGIN
  DELETE FROM newsletter_confirmation_jobs WHERE request_id = NEW.id;
END;

-- A confirmed request is a permanent record of consent. It may not be reopened
-- or rewritten, the way a subscriber ledger event may not.
CREATE TRIGGER newsletter_signup_state_is_forward_only
BEFORE UPDATE OF state ON newsletter_signup_requests
WHEN OLD.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'newsletter_signup_already_settled');
END;

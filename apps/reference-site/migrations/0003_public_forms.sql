PRAGMA foreign_keys = ON;

CREATE TABLE public_form_submissions (
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (site_id, form_id, submission_id)
);

CREATE TABLE public_form_classifications (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (
    classification IN ('accepted', 'suspected_spam')
  ),
  classified_at TEXT NOT NULL,
  UNIQUE (site_id, form_id, submission_id),
  FOREIGN KEY (site_id, form_id, submission_id)
    REFERENCES public_form_submissions (site_id, form_id, submission_id)
);

CREATE TABLE public_form_audit_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'submission_accepted'),
  subject_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (site_id, event_type, subject_id)
);

CREATE TABLE public_form_delivery_intents (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'held')),
  created_at TEXT NOT NULL,
  UNIQUE (site_id, form_id, submission_id),
  FOREIGN KEY (site_id, form_id, submission_id)
    REFERENCES public_form_submissions (site_id, form_id, submission_id)
);

CREATE TABLE public_form_outbox_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE
    REFERENCES public_form_delivery_intents(id),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('deliver_submission', 'hold_for_spam_review')
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'held')),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX public_form_outbox_due
  ON public_form_outbox_events (status, available_at);

CREATE TRIGGER public_form_submissions_immutable_update
BEFORE UPDATE ON public_form_submissions
BEGIN
  SELECT RAISE(ABORT, 'immutable_submission');
END;

CREATE TRIGGER public_form_submissions_immutable_delete
BEFORE DELETE ON public_form_submissions
BEGIN
  SELECT RAISE(ABORT, 'immutable_submission');
END;

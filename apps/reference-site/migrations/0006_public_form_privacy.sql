PRAGMA foreign_keys = ON;

ALTER TABLE public_form_submissions ADD COLUMN payload_deleted_at TEXT;

DROP TRIGGER public_form_submissions_immutable_update;
DROP TRIGGER public_form_submissions_immutable_delete;

CREATE TRIGGER public_form_submissions_immutable_update
BEFORE UPDATE ON public_form_submissions
WHEN NOT (
  OLD.site_id = NEW.site_id
  AND OLD.form_id = NEW.form_id
  AND OLD.submission_id = NEW.submission_id
  AND OLD.schema_version = NEW.schema_version
  AND OLD.receipt_id = NEW.receipt_id
  AND OLD.request_hash = NEW.request_hash
  AND OLD.accepted_at = NEW.accepted_at
  AND OLD.payload_deleted_at IS NULL
  AND NEW.payload_deleted_at IS NOT NULL
  AND OLD.fields_json <> '{}'
  AND NEW.fields_json = '{}'
)
BEGIN
  SELECT RAISE(ABORT, 'immutable_submission');
END;

CREATE TABLE public_form_recovery_cleanup_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

CREATE TRIGGER public_form_submissions_immutable_delete
BEFORE DELETE ON public_form_submissions
WHEN NOT EXISTS (
  SELECT 1 FROM public_form_recovery_cleanup_guard WHERE id = 1
)
BEGIN
  SELECT RAISE(ABORT, 'immutable_submission');
END;

ALTER TABLE public_form_operation_audit_events
  RENAME TO public_form_operation_audit_events_v4;

CREATE TABLE public_form_operation_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  actor_membership_id TEXT,
  action TEXT NOT NULL CHECK (
    action IN (
      'delivery_sent',
      'delivery_retry_scheduled',
      'delivery_failed',
      'delivery_replayed',
      'spam_released',
      'submission_viewed',
      'submission_exported',
      'submission_classified',
      'submission_payload_erased',
      'submission_retention_expired'
    )
  ),
  outcome_code TEXT,
  occurred_at TEXT NOT NULL
);

INSERT INTO public_form_operation_audit_events (
  id, site_id, delivery_id, actor_membership_id, action, outcome_code, occurred_at
)
SELECT
  id, site_id, delivery_id, actor_membership_id, action, outcome_code, occurred_at
FROM public_form_operation_audit_events_v4;

DROP TABLE public_form_operation_audit_events_v4;

CREATE INDEX public_form_operation_audit_site_time
  ON public_form_operation_audit_events (site_id, occurred_at);

CREATE TABLE public_form_backup_records (
  backup_id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  integrity_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retention_days INTEGER NOT NULL CHECK (retention_days > 0)
);

CREATE INDEX public_form_backup_records_site_time
  ON public_form_backup_records (site_id, created_at);

CREATE TABLE public_form_maintenance_state (
  site_id TEXT PRIMARY KEY,
  retention_applied_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  actor_membership_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target = 'isolated'),
  submission_count INTEGER NOT NULL CHECK (submission_count >= 0),
  audit_fact_count INTEGER NOT NULL CHECK (audit_fact_count >= 0),
  integrity_hash TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_stage_submissions (
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  payload_deleted_at TEXT,
  PRIMARY KEY (site_id, form_id, submission_id)
);

CREATE TABLE public_form_restore_stage_classifications (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  classified_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_stage_delivery_intents (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_stage_outbox_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_stage_notification_jobs (
  delivery_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  first_available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error_code TEXT,
  provider_reference TEXT,
  delivered_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_stage_acceptance_audit_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_stage_operation_audit_events (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  actor_membership_id TEXT,
  action TEXT NOT NULL,
  outcome_code TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE public_form_restore_promotion_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state = 'empty')
);

CREATE TABLE public_form_restore_stage_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  integrity_hash TEXT
);

INSERT INTO public_form_restore_stage_control (id) VALUES (1);

CREATE TRIGGER public_form_restore_stage_cleanup
AFTER UPDATE OF generation ON public_form_restore_stage_control
BEGIN
  DELETE FROM public_form_restore_stage_notification_jobs;
  DELETE FROM public_form_restore_stage_outbox_events;
  DELETE FROM public_form_restore_stage_classifications;
  DELETE FROM public_form_restore_stage_delivery_intents;
  DELETE FROM public_form_restore_stage_submissions;
  DELETE FROM public_form_restore_stage_operation_audit_events;
  DELETE FROM public_form_restore_stage_acceptance_audit_events;
END;

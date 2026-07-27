PRAGMA foreign_keys = ON;

CREATE TABLE public_form_notification_jobs (
  delivery_id TEXT PRIMARY KEY
    REFERENCES public_form_delivery_intents(id),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'processing', 'retry', 'delivered', 'failed', 'held')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  first_available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error_code TEXT,
  provider_reference TEXT,
  delivered_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX public_form_notification_jobs_due
  ON public_form_notification_jobs (status, available_at, lease_until);

INSERT INTO public_form_notification_jobs (
  delivery_id, status, available_at, first_available_at, updated_at
)
SELECT
  delivery_id,
  CASE WHEN status = 'held' THEN 'held' ELSE 'pending' END,
  available_at,
  available_at,
  created_at
FROM public_form_outbox_events;

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
      'submission_viewed'
    )
  ),
  outcome_code TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX public_form_operation_audit_site_time
  ON public_form_operation_audit_events (site_id, occurred_at);

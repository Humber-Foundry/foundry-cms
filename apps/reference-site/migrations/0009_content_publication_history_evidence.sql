ALTER TABLE content_publication_audit_events
ADD COLUMN commit_sha TEXT;

ALTER TABLE content_publication_audit_events
ADD COLUMN deployment_id TEXT;

ALTER TABLE content_publication_audit_events
ADD COLUMN approval_fingerprint TEXT;

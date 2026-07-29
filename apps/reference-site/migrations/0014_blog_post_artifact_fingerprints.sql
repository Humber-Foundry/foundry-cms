ALTER TABLE blog_post_revisions
ADD COLUMN content_hash TEXT;

ALTER TABLE blog_post_revisions
ADD COLUMN schema_version TEXT;

ALTER TABLE blog_post_revisions
ADD COLUMN renderer_version TEXT;

ALTER TABLE blog_post_revisions
ADD COLUMN serialization_version TEXT;

ALTER TABLE blog_post_revisions
ADD COLUMN rendered_bytes_hash TEXT;

ALTER TABLE blog_post_revisions
ADD COLUMN artifact_fingerprint TEXT;

ALTER TABLE content_approvals
ADD COLUMN blog_post_artifacts_json TEXT;

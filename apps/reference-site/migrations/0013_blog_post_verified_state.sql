ALTER TABLE blog_posts
ADD COLUMN last_verified_visibility TEXT
CHECK (
  last_verified_visibility IS NULL
  OR last_verified_visibility IN ('public', 'unpublished', 'absent')
);

ALTER TABLE blog_posts
ADD COLUMN last_verified_publication_id TEXT;

ALTER TABLE blog_posts
ADD COLUMN last_verified_publication_sequence INTEGER
CHECK (
  last_verified_publication_sequence IS NULL
  OR last_verified_publication_sequence >= 1
);

CREATE TABLE blog_publication_reconciliation_order (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id TEXT NOT NULL UNIQUE
    REFERENCES content_publications(id)
);

INSERT INTO blog_publication_reconciliation_order (publication_id)
SELECT publication.id
FROM content_publications AS publication
JOIN content_publication_audit_events AS initial_event
  ON initial_event.id = (
    SELECT MIN(event.id)
    FROM content_publication_audit_events AS event
    WHERE event.publication_id = publication.id
  )
ORDER BY initial_event.id;

UPDATE blog_posts
SET last_verified_visibility = CASE
      WHEN last_verified_revision IS NULL THEN NULL
      WHEN live_revision IS NULL THEN 'unpublished'
      ELSE 'public'
    END,
    last_verified_publication_id = (
      SELECT publication_id
      FROM blog_publication_reconciliation_order AS publication_order
      JOIN content_publications AS publication
        ON publication.id = publication_order.publication_id
      WHERE publication.status = 'verified-live'
      ORDER BY publication_order.sequence DESC
      LIMIT 1
    ),
    last_verified_publication_sequence = (
      SELECT publication_order.sequence
      FROM blog_publication_reconciliation_order AS publication_order
      JOIN content_publications AS publication
        ON publication.id = publication_order.publication_id
      WHERE publication.status = 'verified-live'
      ORDER BY publication_order.sequence DESC
      LIMIT 1
    );

CREATE TRIGGER blog_publication_reconciliation_order_prevent_update
BEFORE UPDATE ON blog_publication_reconciliation_order
BEGIN
  SELECT RAISE(ABORT, 'blog_publication_reconciliation_order_is_immutable');
END;

CREATE TRIGGER blog_publication_reconciliation_order_prevent_delete
BEFORE DELETE ON blog_publication_reconciliation_order
BEGIN
  SELECT RAISE(ABORT, 'blog_publication_reconciliation_order_is_immutable');
END;

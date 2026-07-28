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

UPDATE blog_posts
SET last_verified_visibility = CASE
      WHEN last_verified_revision IS NULL THEN NULL
      WHEN live_revision IS NULL THEN 'unpublished'
      ELSE 'public'
    END,
    last_verified_publication_id = NULL,
    last_verified_publication_sequence = NULL;

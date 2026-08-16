PRAGMA foreign_keys = ON;

-- Messages is an inbox. It needs two things the earlier tables never kept:
-- whether a human has opened a submission, and a cheap way to list the newest
-- submissions first.
--
-- Read state belongs to the site, not to one person: when either the Owner or
-- an Editor opens a message, it is read for everyone. The first reader is kept
-- so the record says who opened it, and it never changes afterwards.
CREATE TABLE public_form_submission_reads (
  site_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  first_read_at TEXT NOT NULL,
  first_read_by TEXT,
  PRIMARY KEY (site_id, form_id, submission_id),
  FOREIGN KEY (site_id, form_id, submission_id)
    REFERENCES public_form_submissions (site_id, form_id, submission_id)
    ON DELETE CASCADE
);

CREATE INDEX public_form_submissions_by_recency
  ON public_form_submissions (site_id, accepted_at DESC, submission_id DESC);

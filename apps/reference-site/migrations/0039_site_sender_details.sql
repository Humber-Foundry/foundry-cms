-- The sender details an Owner edits in Settings.
--
-- These five values are what every email must carry at the bottom: the name,
-- the postal address, a way to contact the sender and a way to stop the
-- emails, plus which sending address the email comes from. Until now they were
-- environment variables only, so nobody could set them from inside the
-- product. See ADR-0048.
--
-- One row per site. An empty string means "nothing stored", and the reader
-- falls back to the environment variable for that one value, so an existing
-- installation keeps working with nothing stored at all.
--
-- None of these is a secret. They are the Owner's own words and the Owner's
-- own addresses, and they are sent to every reader of every campaign.
CREATE TABLE site_sender_details (
  site_id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL DEFAULT '',
  postal_address TEXT NOT NULL DEFAULT '',
  contact_url TEXT NOT NULL DEFAULT '',
  unsubscribe_url TEXT NOT NULL DEFAULT '',
  sender_identity_id TEXT NOT NULL DEFAULT '',
  -- Who saved it last, and when. Kept so support can tell a stored value from
  -- an environment value without reading the installation's configuration.
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

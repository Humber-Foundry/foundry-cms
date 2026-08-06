CREATE TABLE analytics_metric_definitions (
  metric_key TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (
    source IN ('cloudflare_web', 'analytics_engine', 'd1', 'provider')
  ),
  unit TEXT NOT NULL CHECK (
    unit IN ('count', 'ratio', 'milliseconds', 'score')
  ),
  aggregation TEXT NOT NULL CHECK (aggregation IN ('sum', 'latest')),
  bucket_granularity TEXT NOT NULL CHECK (
    bucket_granularity IN ('range', 'campaign')
  ),
  value_domain TEXT NOT NULL CHECK (
    value_domain IN ('non_negative', 'signed')
  )
);

INSERT INTO analytics_metric_definitions (
  metric_key, source, unit, aggregation, bucket_granularity, value_domain
)
VALUES
  ('web.page_views', 'cloudflare_web', 'count', 'sum', 'range', 'non_negative'),
  ('web.visits', 'cloudflare_web', 'count', 'sum', 'range', 'non_negative'),
  ('web.vitals.lcp_p75', 'cloudflare_web', 'milliseconds', 'latest', 'range', 'non_negative'),
  ('web.vitals.inp_p75', 'cloudflare_web', 'milliseconds', 'latest', 'range', 'non_negative'),
  ('web.vitals.cls_p75', 'cloudflare_web', 'score', 'latest', 'range', 'non_negative'),
  ('content.page_views', 'cloudflare_web', 'count', 'sum', 'range', 'non_negative'),
  ('interaction.form_impressions', 'analytics_engine', 'count', 'sum', 'range', 'non_negative'),
  ('interaction.cta_activations', 'analytics_engine', 'count', 'sum', 'range', 'non_negative'),
  ('form.submissions_accepted', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('form.submissions_blocked', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('form.notifications_delivered', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('form.notifications_failed', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('subscriber.confirmed', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('subscriber.unsubscribed', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('subscriber.hard_bounced', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('subscriber.complained', 'd1', 'count', 'sum', 'range', 'non_negative'),
  ('subscriber.active', 'd1', 'count', 'latest', 'range', 'non_negative'),
  ('subscriber.net_growth', 'd1', 'count', 'sum', 'range', 'signed'),
  ('campaign.sent', 'provider', 'count', 'sum', 'campaign', 'non_negative'),
  ('campaign.delivered', 'provider', 'count', 'sum', 'campaign', 'non_negative'),
  ('campaign.soft_bounced', 'provider', 'count', 'sum', 'campaign', 'non_negative'),
  ('campaign.hard_bounced', 'provider', 'count', 'sum', 'campaign', 'non_negative'),
  ('campaign.complained', 'provider', 'count', 'sum', 'campaign', 'non_negative'),
  ('campaign.unsubscribed', 'provider', 'count', 'sum', 'campaign', 'non_negative'),
  ('campaign.unique_opens_reported', 'provider', 'count', 'sum', 'campaign', 'non_negative'),
  ('campaign.unique_clicks_reported', 'provider', 'count', 'sum', 'campaign', 'non_negative');

CREATE TABLE analytics_dimension_keys (
  dimension_key TEXT PRIMARY KEY
);

INSERT INTO analytics_dimension_keys (dimension_key)
VALUES (''), ('referrer_host'), ('referrer_channel');

CREATE TABLE analytics_facts (
  site_id TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK (schema_version = 'foundry.analytics.v1'),
  metric_key TEXT NOT NULL,
  bucket_start_utc TEXT NOT NULL,
  bucket_end_utc TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (
    granularity IN ('hour', 'day', 'campaign', 'current')
  ),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('site', 'content', 'form', 'cta', 'campaign')
  ),
  subject_id TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  dimension_value TEXT NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN ('cloudflare_web', 'analytics_engine', 'd1', 'provider')
  ),
  source_name TEXT NOT NULL,
  source_metric TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  unit TEXT NOT NULL CHECK (
    unit IN ('count', 'ratio', 'milliseconds', 'score')
  ),
  quality TEXT NOT NULL CHECK (
    quality IN (
      'exact', 'derived_exact', 'estimated', 'partial_population',
      'best_effort', 'provider_reported', 'directional', 'unreliable'
    )
  ),
  sample_interval INTEGER NOT NULL CHECK (sample_interval >= 1),
  availability TEXT NOT NULL CHECK (
    availability IN ('available', 'unavailable')
  ),
  value REAL,
  unavailable_reason TEXT CHECK (
    unavailable_reason IN (
      'not_measured', 'provider_omitted', 'source_unavailable',
      'outside_retention', 'not_supported'
    )
  ),
  observed_at TEXT NOT NULL,
  complete_through TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  -- ADR-0003's uniqueness key, extended with source_name so replacing a
  -- delivery provider keeps two separately labelled series instead of
  -- overwriting the previous provider's history under one key.
  PRIMARY KEY (
    site_id, metric_key, bucket_start_utc, granularity,
    subject_type, subject_id, dimension_key, dimension_value,
    source, source_name
  ),
  FOREIGN KEY (metric_key) REFERENCES analytics_metric_definitions(metric_key),
  FOREIGN KEY (dimension_key)
    REFERENCES analytics_dimension_keys(dimension_key),
  -- A missing measurement is unavailable with a reason. It is never a zero,
  -- and a present value never carries an absence reason.
  CHECK (
    (availability = 'available'
      AND value IS NOT NULL
      AND unavailable_reason IS NULL)
    OR (availability = 'unavailable'
      AND value IS NULL
      AND unavailable_reason IS NOT NULL)
  ),
  CHECK (bucket_end_utc > bucket_start_utc),
  CHECK (length(subject_id) BETWEEN 1 AND 128),
  CHECK (subject_id NOT LIKE '%@%'),
  CHECK (dimension_value NOT LIKE '%@%'),
  CHECK (dimension_value NOT LIKE '%?%'),
  CHECK (length(dimension_value) <= 253),
  CHECK ((dimension_key = '') = (dimension_value = ''))
);

CREATE INDEX analytics_facts_metric_window
ON analytics_facts (
  site_id, metric_key, granularity, bucket_start_utc
);

CREATE INDEX analytics_facts_subject_window
ON analytics_facts (
  site_id, subject_type, subject_id, metric_key, bucket_start_utc
);

CREATE TRIGGER analytics_facts_require_declared_source_and_unit
BEFORE INSERT ON analytics_facts
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_metric_definitions AS definition
  WHERE definition.metric_key = NEW.metric_key
    AND definition.source = NEW.source
    AND definition.unit = NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, 'analytics_metric_contract_violated');
END;

CREATE TRIGGER analytics_facts_require_declared_source_and_unit_on_update
BEFORE UPDATE ON analytics_facts
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_metric_definitions AS definition
  WHERE definition.metric_key = NEW.metric_key
    AND definition.source = NEW.source
    AND definition.unit = NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, 'analytics_metric_contract_violated');
END;

-- Only a metric whose declared domain is signed may store a negative value.
CREATE TRIGGER analytics_facts_respect_value_domain
BEFORE INSERT ON analytics_facts
WHEN NEW.availability = 'available'
  AND NEW.value < 0
  AND NOT EXISTS (
    SELECT 1
    FROM analytics_metric_definitions AS definition
    WHERE definition.metric_key = NEW.metric_key
      AND definition.value_domain = 'signed'
  )
BEGIN
  SELECT RAISE(ABORT, 'analytics_value_domain_violated');
END;

CREATE TRIGGER analytics_facts_respect_value_domain_on_update
BEFORE UPDATE ON analytics_facts
WHEN NEW.availability = 'available'
  AND NEW.value < 0
  AND NOT EXISTS (
    SELECT 1
    FROM analytics_metric_definitions AS definition
    WHERE definition.metric_key = NEW.metric_key
      AND definition.value_domain = 'signed'
  )
BEGIN
  SELECT RAISE(ABORT, 'analytics_value_domain_violated');
END;

-- A projector may only move a fact forward. A replayed or late source run can
-- never resurrect an older value over a newer one.
CREATE TRIGGER analytics_facts_revision_moves_forward
BEFORE UPDATE ON analytics_facts
WHEN NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'analytics_fact_revision_not_newer');
END;

CREATE TRIGGER analytics_facts_preserve_identity
BEFORE UPDATE ON analytics_facts
WHEN NEW.site_id <> OLD.site_id
  OR NEW.metric_key <> OLD.metric_key
  OR NEW.bucket_start_utc <> OLD.bucket_start_utc
  OR NEW.granularity <> OLD.granularity
  OR NEW.subject_type <> OLD.subject_type
  OR NEW.subject_id <> OLD.subject_id
  OR NEW.dimension_key <> OLD.dimension_key
  OR NEW.dimension_value <> OLD.dimension_value
  OR NEW.source <> OLD.source
  OR NEW.source_name <> OLD.source_name
BEGIN
  SELECT RAISE(ABORT, 'analytics_fact_identity_is_immutable');
END;

CREATE TABLE analytics_fact_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_key TEXT NOT NULL,
  site_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  bucket_start_utc TEXT NOT NULL,
  granularity TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_name TEXT NOT NULL,
  previous_revision INTEGER NOT NULL,
  previous_value REAL,
  previous_availability TEXT NOT NULL CHECK (
    previous_availability IN ('available', 'unavailable')
  ),
  next_revision INTEGER NOT NULL,
  next_value REAL,
  next_availability TEXT NOT NULL CHECK (
    next_availability IN ('available', 'unavailable')
  ),
  superseded_at TEXT NOT NULL,
  CHECK (next_revision > previous_revision)
);

CREATE INDEX analytics_fact_revisions_fact
ON analytics_fact_revisions (fact_key, superseded_at);

CREATE TRIGGER analytics_fact_revisions_prevent_update
BEFORE UPDATE ON analytics_fact_revisions
BEGIN
  SELECT RAISE(ABORT, 'analytics_fact_revision_is_immutable');
END;

CREATE TABLE analytics_source_state (
  source TEXT NOT NULL CHECK (
    source IN ('cloudflare_web', 'analytics_engine', 'd1', 'provider')
  ),
  source_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('healthy', 'delayed', 'partial', 'unavailable')
  ),
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  complete_through TEXT,
  next_retry_at TEXT,
  -- A stable, non-secret code. Provider messages and credentials never land
  -- here, so surfacing source health on the dashboard cannot leak either.
  error_code TEXT CHECK (
    error_code IS NULL OR error_code GLOB '[a-z][a-z0-9_]*'
  ),
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  PRIMARY KEY (source, source_name),
  CHECK (
    (status = 'healthy' AND error_code IS NULL)
    OR status <> 'healthy'
  )
);

-- Completeness is evidence that a commit landed, so it may never move
-- backwards on a source that has already reported further coverage.
CREATE TRIGGER analytics_source_state_completeness_moves_forward
BEFORE UPDATE ON analytics_source_state
WHEN OLD.complete_through IS NOT NULL
  AND NEW.complete_through IS NOT NULL
  AND NEW.complete_through < OLD.complete_through
BEGIN
  SELECT RAISE(ABORT, 'analytics_source_completeness_regressed');
END;

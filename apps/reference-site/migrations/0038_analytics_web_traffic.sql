-- Web traffic is counted by the site's own Worker.
--
-- Migration 0025 let one metric have exactly one source, because Cloudflare
-- Web Analytics was the only planned producer of page views. The Worker
-- request path now counts page views and writes them to Workers Analytics
-- Engine, so page views, visits and per-page views each have two allowed
-- sources. See ADR-0047.
--
-- Two sources measuring one metric are still never added together. The
-- comparability rule in the read model keeps their series apart, and each
-- fact keeps its own source and source name.

CREATE TABLE analytics_metric_sources (
  metric_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN ('cloudflare_web', 'analytics_engine', 'd1', 'provider')
  ),
  PRIMARY KEY (metric_key, source),
  FOREIGN KEY (metric_key) REFERENCES analytics_metric_definitions(metric_key)
);

-- Every metric keeps the source migration 0025 declared for it.
INSERT INTO analytics_metric_sources (metric_key, source)
SELECT metric_key, source FROM analytics_metric_definitions;

-- The Worker request path is a second allowed source for web traffic.
INSERT INTO analytics_metric_sources (metric_key, source)
VALUES
  ('web.page_views', 'analytics_engine'),
  ('web.visits', 'analytics_engine'),
  ('content.page_views', 'analytics_engine');

-- The fact contract now reads the allowed-source table. The unit still comes
-- from the single metric definition, because a metric has one unit.
DROP TRIGGER analytics_facts_require_declared_source_and_unit;

CREATE TRIGGER analytics_facts_require_declared_source_and_unit
BEFORE INSERT ON analytics_facts
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_metric_sources AS allowed
  JOIN analytics_metric_definitions AS definition
    ON definition.metric_key = allowed.metric_key
  WHERE allowed.metric_key = NEW.metric_key
    AND allowed.source = NEW.source
    AND definition.unit = NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, 'analytics_metric_contract_violated');
END;

DROP TRIGGER analytics_facts_require_declared_source_and_unit_on_update;

CREATE TRIGGER analytics_facts_require_declared_source_and_unit_on_update
BEFORE UPDATE ON analytics_facts
WHEN NOT EXISTS (
  SELECT 1
  FROM analytics_metric_sources AS allowed
  JOIN analytics_metric_definitions AS definition
    ON definition.metric_key = allowed.metric_key
  WHERE allowed.metric_key = NEW.metric_key
    AND allowed.source = NEW.source
    AND definition.unit = NEW.unit
)
BEGIN
  SELECT RAISE(ABORT, 'analytics_metric_contract_violated');
END;

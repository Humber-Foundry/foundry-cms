import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  analyticsMetrics,
  createAnalyticsProjection,
  createAnalyticsQueryApplication,
  type AnalyticsFactMeasurement,
  type StoredAnalyticsFact,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import { createD1AnalyticsStore } from "./d1-analytics-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const siteId = createSiteId("site_reference");

type MetricDefinitionRow = {
  metric_key: string;
  source: string;
  unit: string;
  aggregation: string;
  bucket_granularity: string;
  value_domain: string;
};

function migrationStatements(migration: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;
  for (const line of migration.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("--")) continue;
    current += ` ${trimmed}`;
    if (trimmed.startsWith("CREATE TRIGGER")) inTrigger = true;
    if (
      (!inTrigger && trimmed.endsWith(";")) ||
      (inTrigger && trimmed === "END;")
    ) {
      statements.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }
  return statements;
}

beforeEach(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["FOUNDRY_DB"],
  });
  database = await runtime.getD1Database("FOUNDRY_DB");
  const migration = await readFile(
    new URL("../migrations/0025_analytics_projection.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migrationStatements(migration)) {
    await database.prepare(statement).run();
  }
});

afterEach(async () => {
  await runtime.dispose();
});

function store() {
  return createD1AnalyticsStore(
    database as unknown as D1DatabaseBinding,
    siteId,
  );
}

function projection(now = "2026-08-02T01:05:00.000Z") {
  return createAnalyticsProjection({ siteId, store: store(), now: () => now });
}

function measurement(
  overrides: Partial<AnalyticsFactMeasurement> = {},
): AnalyticsFactMeasurement {
  return {
    metricKey: "web.page_views",
    bucketStartUtc: "2026-08-01T00:00:00.000Z",
    bucketEndUtc: "2026-08-02T00:00:00.000Z",
    granularity: "day",
    subjectType: "site",
    subjectId: "site_reference",
    dimension: { key: "", value: "" },
    unit: "count",
    quality: "estimated",
    sampleInterval: 1,
    value: 120,
    unavailableReason: null,
    ...overrides,
  };
}

async function projectWeb(
  overrides: Partial<Parameters<ReturnType<typeof projection>["project"]>[0]> = {},
) {
  await projection().project({
    source: "cloudflare_web",
    sourceName: "cloudflare",
    sourceMetric: "pageViews",
    definitionVersion: 1,
    revision: 1,
    observedAt: "2026-08-02T01:00:00.000Z",
    completeThrough: "2026-08-02T00:00:00.000Z",
    facts: [measurement()],
    ...overrides,
  } as Parameters<ReturnType<typeof projection>["project"]>[0]);
}

async function factRows() {
  const { results } = await database
    .prepare("SELECT * FROM analytics_facts ORDER BY metric_key")
    .all();
  return results as unknown as ReadonlyArray<Record<string, unknown>>;
}

describe("the seeded metric contract", () => {
  it("declares exactly the canonical registry", async () => {
    const { results } = await database
      .prepare(
        `SELECT metric_key, source, unit, aggregation, bucket_granularity,
                value_domain
         FROM analytics_metric_definitions ORDER BY metric_key`,
      )
      .all<MetricDefinitionRow>();

    expect(
      (results as ReadonlyArray<MetricDefinitionRow>).map((row) => ({
        metricKey: row.metric_key,
        source: row.source,
        unit: row.unit,
        aggregation: row.aggregation,
        bucketGranularity: row.bucket_granularity,
        valueDomain: row.value_domain,
      })),
    ).toEqual(
      [...analyticsMetrics]
        .map((entry) => ({
          metricKey: entry.metricKey,
          source: entry.source,
          unit: entry.unit,
          aggregation: entry.aggregation,
          bucketGranularity: entry.bucketGranularity,
          valueDomain: entry.valueDomain,
        }))
        .sort((left, right) =>
          left.metricKey.localeCompare(right.metricKey),
        ),
    );
  });
});

describe("committing a projection run", () => {
  it("writes one fact and its source state together", async () => {
    await projectWeb();

    expect(await factRows()).toHaveLength(1);
    const state = await store().findCurrentSourceState({
      source: "cloudflare_web",
      sourceName: "cloudflare",
    });
    expect(state).toMatchObject({
      status: "healthy",
      completeThrough: "2026-08-02T00:00:00.000Z",
    });
  });

  it("replaces a fact when a newer revision arrives", async () => {
    await projectWeb();
    await projectWeb({ revision: 2, facts: [measurement({ value: 131 })] });

    const rows = await factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 131, revision: 2 });
  });

  it("records the superseded value in the revision audit", async () => {
    await projectWeb();
    await projectWeb({ revision: 2, facts: [measurement({ value: 131 })] });

    const { results } = await database
      .prepare("SELECT * FROM analytics_fact_revisions")
      .all<{ previous_value: number; next_value: number }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      previous_value: 120,
      next_value: 131,
    });
  });

  it("keeps two providers' campaign series as separate rows", async () => {
    const campaign = measurement({
      metricKey: "campaign.delivered",
      subjectType: "campaign",
      subjectId: "campaign_1",
      granularity: "campaign",
      quality: "provider_reported",
      value: 480,
    });
    await projection().project({
      source: "provider",
      sourceName: "brevo",
      sourceMetric: "delivered",
      definitionVersion: 1,
      revision: 1,
      observedAt: "2026-08-02T01:00:00.000Z",
      completeThrough: "2026-08-02T00:00:00.000Z",
      facts: [campaign],
    });
    await projection().project({
      source: "provider",
      sourceName: "postmark",
      sourceMetric: "delivered_total",
      definitionVersion: 1,
      revision: 1,
      observedAt: "2026-08-02T01:00:00.000Z",
      completeThrough: "2026-08-02T00:00:00.000Z",
      facts: [campaign],
    });

    expect(await factRows()).toHaveLength(2);
  });
});

describe("guarantees the schema enforces on its own", () => {
  it("refuses a fact whose metric is not declared", async () => {
    await expect(
      database
        .prepare(
          `INSERT INTO analytics_facts (
             site_id, schema_version, metric_key, bucket_start_utc,
             bucket_end_utc, granularity, subject_type, subject_id,
             dimension_key, dimension_value, source, source_name,
             source_metric, definition_version, unit, quality,
             sample_interval, availability, value, unavailable_reason,
             observed_at, complete_through, revision
           ) VALUES (
             'site_reference', 'foundry.analytics.v1', 'web.unique_visitors',
             '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'day',
             'site', 'site_reference', '', '', 'cloudflare_web', 'cloudflare',
             'visitors', 1, 'count', 'estimated', 1, 'available', 4, NULL,
             '2026-08-02T01:00:00.000Z', '2026-08-02T00:00:00.000Z', 1
           )`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a dimension outside the allowlist", async () => {
    await expect(
      database
        .prepare(
          `INSERT INTO analytics_facts (
             site_id, schema_version, metric_key, bucket_start_utc,
             bucket_end_utc, granularity, subject_type, subject_id,
             dimension_key, dimension_value, source, source_name,
             source_metric, definition_version, unit, quality,
             sample_interval, availability, value, unavailable_reason,
             observed_at, complete_through, revision
           ) VALUES (
             'site_reference', 'foundry.analytics.v1', 'web.page_views',
             '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'day',
             'site', 'site_reference', 'country', 'CA', 'cloudflare_web',
             'cloudflare', 'pageViews', 1, 'count', 'estimated', 1,
             'available', 4, NULL,
             '2026-08-02T01:00:00.000Z', '2026-08-02T00:00:00.000Z', 1
           )`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("refuses an absent measurement stored as a zero", async () => {
    await expect(
      database
        .prepare(
          `INSERT INTO analytics_facts (
             site_id, schema_version, metric_key, bucket_start_utc,
             bucket_end_utc, granularity, subject_type, subject_id,
             dimension_key, dimension_value, source, source_name,
             source_metric, definition_version, unit, quality,
             sample_interval, availability, value, unavailable_reason,
             observed_at, complete_through, revision
           ) VALUES (
             'site_reference', 'foundry.analytics.v1', 'web.page_views',
             '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'day',
             'site', 'site_reference', '', '', 'cloudflare_web', 'cloudflare',
             'pageViews', 1, 'count', 'estimated', 1, 'unavailable', 0,
             'provider_omitted',
             '2026-08-02T01:00:00.000Z', '2026-08-02T00:00:00.000Z', 1
           )`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a subject identifier that looks like an address", async () => {
    await expect(
      database
        .prepare(
          `INSERT INTO analytics_facts (
             site_id, schema_version, metric_key, bucket_start_utc,
             bucket_end_utc, granularity, subject_type, subject_id,
             dimension_key, dimension_value, source, source_name,
             source_metric, definition_version, unit, quality,
             sample_interval, availability, value, unavailable_reason,
             observed_at, complete_through, revision
           ) VALUES (
             'site_reference', 'foundry.analytics.v1', 'web.page_views',
             '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'day',
             'site', 'person@example.com', '', '', 'cloudflare_web',
             'cloudflare', 'pageViews', 1, 'count', 'estimated', 1,
             'available', 4, NULL,
             '2026-08-02T01:00:00.000Z', '2026-08-02T00:00:00.000Z', 1
           )`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a negative count while allowing signed net growth", async () => {
    const negative = (metricKey: string) =>
      database
        .prepare(
          `INSERT INTO analytics_facts (
             site_id, schema_version, metric_key, bucket_start_utc,
             bucket_end_utc, granularity, subject_type, subject_id,
             dimension_key, dimension_value, source, source_name,
             source_metric, definition_version, unit, quality,
             sample_interval, availability, value, unavailable_reason,
             observed_at, complete_through, revision
           ) VALUES (
             'site_reference', 'foundry.analytics.v1', ?1,
             '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'day',
             'site', 'site_reference', '', '', 'd1', 'foundry',
             'ledger', 1, 'count', 'exact', 1, 'available', -3, NULL,
             '2026-08-02T01:00:00.000Z', '2026-08-02T00:00:00.000Z', 1
           )`,
        )
        .bind(metricKey)
        .run();

    await expect(negative("subscriber.confirmed")).rejects.toThrow();
    await expect(negative("subscriber.net_growth")).resolves.toBeDefined();
  });

  it("refuses a source whose completeness moves backwards", async () => {
    await projectWeb();

    await expect(
      database
        .prepare(
          `UPDATE analytics_source_state
           SET complete_through = '2026-07-01T00:00:00.000Z'
           WHERE source = 'cloudflare_web'`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("refuses a stale revision overwriting a newer fact", async () => {
    await projectWeb({ revision: 4 });

    await expect(
      database
        .prepare(
          `UPDATE analytics_facts SET revision = 3, value = 9
           WHERE metric_key = 'web.page_views'`,
        )
        .run(),
    ).rejects.toThrow();
  });
});

describe("compaction", () => {
  it("replaces covered hourly facts with one daily fact", async () => {
    await projectWeb({
      completeThrough: "2026-05-02T00:00:00.000Z",
      facts: [
        measurement({
          granularity: "hour",
          bucketStartUtc: "2026-05-01T00:00:00.000Z",
          bucketEndUtc: "2026-05-01T01:00:00.000Z",
          value: 5,
        }),
        measurement({
          granularity: "hour",
          bucketStartUtc: "2026-05-01T01:00:00.000Z",
          bucketEndUtc: "2026-05-01T02:00:00.000Z",
          value: 7,
        }),
      ],
    });

    const outcome = await projection("2026-08-02T00:00:00.000Z").compact({
      hourlyRetentionDays: 90,
    });

    expect(outcome).toMatchObject({
      dailyFactsWritten: 1,
      hourlyFactsRemoved: 2,
    });
    const rows = await factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ granularity: "day", value: 12 });
  });
});

describe("reading the projection back", () => {
  it("serves the dashboard query service from stored facts", async () => {
    await projectWeb({
      facts: [
        measurement({
          bucketStartUtc: "2026-08-01T07:00:00.000Z",
          bucketEndUtc: "2026-08-02T07:00:00.000Z",
          value: 120,
        }),
      ],
    });

    const application = createAnalyticsQueryApplication({
      siteId,
      store: store(),
      reportingTimeZone: "America/Vancouver",
      now: () => "2026-08-03T00:00:00.000Z",
      authorize: async () => {},
    });
    const overview = await application.queries.overview({
      actor: { email: "owner@example.com" },
      range: { fromLocalDate: "2026-08-01", toLocalDate: "2026-08-01" },
    });

    expect(
      overview.metrics.find((entry) => entry.metricKey === "web.page_views"),
    ).toMatchObject({
      value: { state: "available", value: 120 },
      sourceName: "cloudflare",
      quality: "estimated",
    });
    expect(
      overview.metrics.find(
        (entry) => entry.metricKey === "campaign.delivered",
      )?.value,
    ).toEqual({ state: "unavailable", reason: "not_measured" });
  });

  it("looks up more identities than D1 allows parameters in one statement", async () => {
    const days = Array.from({ length: 24 }, (_entry, index) => {
      const day = new Date(
        Date.parse("2026-08-01T00:00:00.000Z") + index * 86_400_000,
      );
      return day.toISOString();
    });
    await projectWeb({
      completeThrough: "2026-09-01T00:00:00.000Z",
      facts: days.map((day) =>
        measurement({
          bucketStartUtc: day,
          bucketEndUtc: new Date(
            Date.parse(day) + 86_400_000,
          ).toISOString(),
          value: 1,
        }),
      ),
    });

    const found = await store().findFacts(
      days.map((day) => ({
        siteId,
        metricKey: "web.page_views" as const,
        bucketStartUtc: day,
        granularity: "day" as const,
        subjectType: "site" as const,
        subjectId: "site_reference",
        dimensionKey: "",
        dimensionValue: "",
        source: "cloudflare_web" as const,
        sourceName: "cloudflare",
      })),
    );

    expect(found).toHaveLength(24);
  });

  it("finds only the identities a projector asked for", async () => {
    await projectWeb();

    const found = await store().findFacts([
      {
        siteId,
        metricKey: "web.page_views",
        bucketStartUtc: "2026-08-01T00:00:00.000Z",
        granularity: "day",
        subjectType: "site",
        subjectId: "site_reference",
        dimensionKey: "",
        dimensionValue: "",
        source: "cloudflare_web",
        sourceName: "cloudflare",
      },
      {
        siteId,
        metricKey: "web.visits",
        bucketStartUtc: "2026-08-01T00:00:00.000Z",
        granularity: "day",
        subjectType: "site",
        subjectId: "site_reference",
        dimensionKey: "",
        dimensionValue: "",
        source: "cloudflare_web",
        sourceName: "cloudflare",
      },
    ]);

    expect(found.map((entry: StoredAnalyticsFact) => entry.metricKey)).toEqual([
      "web.page_views",
    ]);
  });
});

describe("retention purge", () => {
  it("deletes facts past the retention floor and keeps the rest", async () => {
    await projectWeb({
      completeThrough: "2024-01-02T00:00:00.000Z",
      facts: [
        measurement({
          bucketStartUtc: "2024-01-01T00:00:00.000Z",
          bucketEndUtc: "2024-01-02T00:00:00.000Z",
        }),
      ],
    });
    await projectWeb({ revision: 2 });
    expect(await factRows()).toHaveLength(2);

    const outcome = await projection("2026-08-02T00:00:00.000Z").purge({
      aggregateFactMonths: 25,
    });

    expect(outcome.factsRemoved).toBe(1);
    const rows = await factRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bucket_start_utc: "2026-08-01T00:00:00.000Z",
    });
  });

  it("removes the revision audit rows the purged facts left behind", async () => {
    await projectWeb({
      completeThrough: "2024-01-02T00:00:00.000Z",
      facts: [
        measurement({
          bucketStartUtc: "2024-01-01T00:00:00.000Z",
          bucketEndUtc: "2024-01-02T00:00:00.000Z",
        }),
      ],
    });
    await projectWeb({
      revision: 2,
      completeThrough: "2024-01-02T00:00:00.000Z",
      facts: [
        measurement({
          bucketStartUtc: "2024-01-01T00:00:00.000Z",
          bucketEndUtc: "2024-01-02T00:00:00.000Z",
          value: 999,
        }),
      ],
    });
    const before = await database
      .prepare("SELECT COUNT(*) AS total FROM analytics_fact_revisions")
      .first<{ total: number }>();
    expect(before?.total).toBe(1);

    const outcome = await projection("2026-08-02T00:00:00.000Z").purge({
      aggregateFactMonths: 25,
    });

    expect(outcome.revisionsRemoved).toBe(1);
    const after = await database
      .prepare("SELECT COUNT(*) AS total FROM analytics_fact_revisions")
      .first<{ total: number }>();
    expect(after?.total).toBe(0);
  });
});

describe("compaction against a source that reports hours and days", () => {
  it("removes the hours and leaves the source's own daily fact alone", async () => {
    await projectWeb({
      completeThrough: "2026-05-02T00:00:00.000Z",
      facts: [
        // The source's own daily total, which is the authoritative one.
        measurement({
          bucketStartUtc: "2026-05-01T00:00:00.000Z",
          bucketEndUtc: "2026-05-02T00:00:00.000Z",
          value: 11,
        }),
        measurement({
          granularity: "hour",
          bucketStartUtc: "2026-05-01T00:00:00.000Z",
          bucketEndUtc: "2026-05-01T01:00:00.000Z",
          value: 5,
        }),
        measurement({
          granularity: "hour",
          bucketStartUtc: "2026-05-01T01:00:00.000Z",
          bucketEndUtc: "2026-05-01T02:00:00.000Z",
          value: 7,
        }),
      ],
    });

    const outcome = await projection("2026-08-02T00:00:00.000Z").compact({
      hourlyRetentionDays: 90,
    });

    expect(outcome).toMatchObject({
      dailyFactsWritten: 0,
      daysAlreadyDaily: 1,
      hourlyFactsRemoved: 2,
    });
    const rows = await factRows();
    expect(rows).toHaveLength(1);
    // The stored value stays 11, the source's own daily total. Recomputing
    // it from the hours would have given 12.
    expect(rows[0]).toMatchObject({ granularity: "day", value: 11 });
  });
});

describe("the retention boundary", () => {
  /**
   * The retention floor is an instant, so it can fall inside a bucket. That
   * is where the two DELETE statements used to disagree: the fact was kept
   * because its bucket had not closed, while its audit rows were deleted
   * because the bucket had started. Both now test `bucket_start_utc`, so a
   * fact and its audit rows are always kept together or deleted together.
   */
  async function revisionCount() {
    const row = await database
      .prepare("SELECT COUNT(*) AS total FROM analytics_fact_revisions")
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  beforeEach(async () => {
    // Two runs against one fact, so a revision audit row exists for it.
    await projectWeb();
    await projectWeb({ revision: 2, facts: [measurement({ value: 240 })] });
    expect(await revisionCount()).toBe(1);
  });

  it("removes a fact and its audit together when the floor is inside its bucket", async () => {
    // 25 months before this instant is 2026-08-01T12:30Z, which falls inside
    // the fact's 2026-08-01 bucket.
    const outcome = await projection("2028-09-01T12:30:00.000Z").purge({
      aggregateFactMonths: 25,
    });

    expect(outcome).toMatchObject({ factsRemoved: 1, revisionsRemoved: 1 });
    expect(await factRows()).toHaveLength(0);
    expect(await revisionCount()).toBe(0);
  });

  it("keeps a fact and its audit together when the floor is just before it", async () => {
    // 25 months before this instant is 2026-07-31T12:30Z, just before the
    // fact's bucket starts.
    const outcome = await projection("2028-08-31T12:30:00.000Z").purge({
      aggregateFactMonths: 25,
    });

    expect(outcome).toMatchObject({ factsRemoved: 0, revisionsRemoved: 0 });
    expect(await factRows()).toHaveLength(1);
    expect(await revisionCount()).toBe(1);
  });
});

import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  currentRouteHistory,
  isSourceDue,
  providerPollWindowDays,
  runScheduledAnalyticsProjection,
  type AnalyticsProjectionEnvironment,
} from "./analytics-projection-runtime";
import { createD1AnalyticsStore } from "./d1-analytics-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const siteId = referenceSiteDefinition.site.id;

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
  for (const name of [
    "0002_subscriber_ledger.sql",
    "0003_public_forms.sql",
    "0004_public_form_notifications.sql",
    "0025_analytics_projection.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migrationStatements(migration)) {
      await database.prepare(statement).run();
    }
  }
});

afterEach(async () => {
  await runtime.dispose();
});

function environment(
  overrides: Partial<AnalyticsProjectionEnvironment> = {},
): AnalyticsProjectionEnvironment {
  return {
    FOUNDRY_DB: database as unknown as D1DatabaseBinding,
    ...overrides,
  } as AnalyticsProjectionEnvironment;
}

async function sourceStates() {
  return createD1AnalyticsStore(
    database as unknown as D1DatabaseBinding,
    siteId,
  ).listSourceStates();
}

describe("source scheduling", () => {
  const state = {
    source: "cloudflare_web" as const,
    sourceName: "cloudflare",
    status: "healthy" as const,
    lastAttemptAt: "2026-08-02T00:00:00.000Z",
    lastSuccessAt: "2026-08-02T00:00:00.000Z",
    completeThrough: "2026-08-02T00:00:00.000Z",
    nextRetryAt: null,
    errorCode: null,
    definitionVersion: 1,
  };

  it("runs a source that has never reported", () => {
    expect(
      isSourceDue({
        state: null,
        source: "cloudflare_web",
        now: "2026-08-02T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("leaves an external source alone between refresh intervals", () => {
    expect(
      isSourceDue({
        state,
        source: "cloudflare_web",
        now: "2026-08-02T01:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("polls the operational source far more often than an API", () => {
    const now = "2026-08-02T00:10:00.000Z";
    expect(isSourceDue({ state, source: "d1", now })).toBe(true);
    expect(isSourceDue({ state, source: "cloudflare_web", now })).toBe(false);
  });

  it("honours a retry time a degraded source asked for", () => {
    const retrying = { ...state, nextRetryAt: "2026-08-02T06:00:00.000Z" };
    expect(
      isSourceDue({
        state: retrying,
        source: "cloudflare_web",
        now: "2026-08-02T05:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isSourceDue({
        state: retrying,
        source: "cloudflare_web",
        now: "2026-08-02T06:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("running the scheduled projection", () => {
  it("projects the operational source without any credential", async () => {
    await runScheduledAnalyticsProjection(
      environment(),
      () => "2026-08-03T00:30:00.000Z",
    );

    const states = await sourceStates();
    expect(
      states.find((state) => state.source === "d1"),
    ).toMatchObject({
      sourceName: "foundry",
      status: "healthy",
      // D1 is exact and local, so it reports through the current instant
      // rather than through the last closed day.
      completeThrough: "2026-08-03T00:30:00.000Z",
    });
  });

  it("projects today, so the current day is not read as absent", async () => {
    await runScheduledAnalyticsProjection(
      environment(),
      () => "2026-08-03T00:30:00.000Z",
    );

    const { results } = await database
      .prepare(
        `SELECT COUNT(*) AS total FROM analytics_facts
         WHERE source = 'd1' AND bucket_start_utc = '2026-08-03T00:00:00.000Z'`,
      )
      .all<{ total: number }>();
    expect(results[0]?.total).toBeGreaterThan(0);
  });

  it("marks today's bucket as still filling rather than complete", async () => {
    await runScheduledAnalyticsProjection(
      environment(),
      () => "2026-08-03T00:30:00.000Z",
    );

    const { results } = await database
      .prepare(
        `SELECT bucket_end_utc, complete_through FROM analytics_facts
         WHERE source = 'd1' AND bucket_start_utc = '2026-08-03T00:00:00.000Z'
         LIMIT 1`,
      )
      .all<{ bucket_end_utc: string; complete_through: string }>();
    const row = results[0];
    expect(row).toBeDefined();
    expect(Date.parse(row!.bucket_end_utc)).toBeGreaterThan(
      Date.parse(row!.complete_through),
    );
  });

  it("reports an unconfigured source as unavailable, not as zero traffic", async () => {
    await runScheduledAnalyticsProjection(
      environment(),
      () => "2026-08-03T00:30:00.000Z",
    );

    const states = await sourceStates();
    for (const source of [
      "cloudflare_web",
      "analytics_engine",
      "provider",
    ] as const) {
      expect(states.find((state) => state.source === source)).toMatchObject({
        status: "unavailable",
        errorCode: "source_not_configured",
        completeThrough: null,
      });
    }
    const { results } = await database
      .prepare(
        `SELECT COUNT(*) AS total FROM analytics_facts
         WHERE source <> 'd1'`,
      )
      .all<{ total: number }>();
    expect(results[0]?.total).toBe(0);
  });

  it("does not re-poll an external source on the next scheduled run", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      fetchCalls.push(String(url));
      return new Response("", { status: 503 });
    }) as unknown as typeof fetch;
    try {
      const configured = environment({
        FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account",
        FOUNDRY_ANALYTICS_API_TOKEN: "token",
        FOUNDRY_CLOUDFLARE_WEB_ANALYTICS_SITE_TAG: "site",
      });
      await runScheduledAnalyticsProjection(
        configured,
        () => "2026-08-03T00:30:00.000Z",
      );
      const afterFirstRun = fetchCalls.length;
      await runScheduledAnalyticsProjection(
        configured,
        () => "2026-08-03T00:35:00.000Z",
      );

      expect(afterFirstRun).toBeGreaterThan(0);
      expect(fetchCalls).toHaveLength(afterFirstRun);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records a failed query as an outage with a retry time", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;
    try {
      await runScheduledAnalyticsProjection(
        environment({
          FOUNDRY_CLOUDFLARE_ACCOUNT_ID: "account",
          FOUNDRY_ANALYTICS_API_TOKEN: "token",
          FOUNDRY_CLOUDFLARE_WEB_ANALYTICS_SITE_TAG: "site",
        }),
        () => "2026-08-03T00:30:00.000Z",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const states = await sourceStates();
    expect(
      states.find((state) => state.source === "cloudflare_web"),
    ).toMatchObject({
      status: "unavailable",
      errorCode: "source_query_failed",
      nextRetryAt: "2026-08-03T06:30:00.000Z",
    });
  });

  it("maps the published routes it can attribute traffic to", () => {
    expect(currentRouteHistory().some((entry) => entry.path === "/")).toBe(
      true,
    );
    expect(
      currentRouteHistory().every((entry) => entry.contentId.length > 0),
    ).toBe(true);
  });
});

describe("provider polling bands", () => {
  it("asks for everything on a source that has never reported", () => {
    expect(
      providerPollWindowDays({
        lastSuccessAt: null,
        now: "2026-08-05T09:00:00.000Z",
      }),
    ).toBe(90);
  });

  it("keeps to the 72-hour band between runs on the same day", () => {
    expect(
      providerPollWindowDays({
        lastSuccessAt: "2026-08-05T08:00:00.000Z",
        now: "2026-08-05T09:00:00.000Z",
      }),
    ).toBe(3);
  });

  it("widens to 30 days on the first run of a new day", () => {
    expect(
      providerPollWindowDays({
        lastSuccessAt: "2026-08-04T23:00:00.000Z",
        now: "2026-08-05T00:30:00.000Z",
      }),
    ).toBe(30);
  });

  it("widens to 90 days on the first run of a new week", () => {
    // 2026-08-02 is a Sunday, 2026-08-03 the Monday that starts a new week.
    expect(
      providerPollWindowDays({
        lastSuccessAt: "2026-08-02T23:00:00.000Z",
        now: "2026-08-03T00:30:00.000Z",
      }),
    ).toBe(90);
  });
});

describe("retention", () => {
  it("removes facts past the retention floor on each scheduled run", async () => {
    await database
      .prepare(
        `INSERT INTO analytics_facts (
           site_id, schema_version, metric_key, bucket_start_utc,
           bucket_end_utc, granularity, subject_type, subject_id,
           dimension_key, dimension_value, source, source_name, source_metric,
           definition_version, unit, quality, sample_interval, availability,
           value, unavailable_reason, observed_at, complete_through, revision
         ) VALUES (
           ?1, 'foundry.analytics.v1', 'web.page_views',
           '2023-01-01T00:00:00.000Z', '2023-01-02T00:00:00.000Z', 'day',
           'site', 'site_reference', '', '', 'cloudflare_web', 'cloudflare',
           'pageViews', 1, 'count', 'estimated', 1, 'available', 10, NULL,
           '2023-01-02T01:00:00.000Z', '2023-01-02T00:00:00.000Z', 1
         )`,
      )
      .bind(siteId)
      .run();

    await runScheduledAnalyticsProjection(
      environment(),
      () => "2026-08-03T00:30:00.000Z",
    );

    const { results } = await database
      .prepare(
        `SELECT COUNT(*) AS total FROM analytics_facts
         WHERE bucket_start_utc = '2023-01-01T00:00:00.000Z'`,
      )
      .all<{ total: number }>();
    expect(results[0]?.total).toBe(0);
  });
});

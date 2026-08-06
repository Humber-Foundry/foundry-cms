import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSiteId } from "@foundry/site-definition";

import {
  currentRouteHistory,
  isSourceDue,
  runScheduledAnalyticsProjection,
  type AnalyticsProjectionEnvironment,
} from "./analytics-projection-runtime";
import { createD1AnalyticsStore } from "./d1-analytics-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const siteId = createSiteId("site_reference");

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
      completeThrough: "2026-08-03T00:00:00.000Z",
    });
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

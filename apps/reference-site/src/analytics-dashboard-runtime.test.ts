import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AnalyticsPrivacyViolationError } from "@humber-foundry/application";
import {
  homePage,
  pageDisplayTitle,
} from "@humber-foundry/site-definition";

import {
  AnalyticsDashboardError,
  createAnalyticsDashboardContext,
  defaultReportingRange,
  defaultReportingTimeZone,
  loadAnalyticsDashboard,
  resolveReportingPeriodDays,
} from "./analytics-dashboard-runtime";
import { installedSiteDefinition } from "../foundry/site-definition";
import type { HumanAccessRequestContext } from "./human-access-runtime";

function unauthorizedContext(): HumanAccessRequestContext {
  return { state: "unauthenticated" } as unknown as HumanAccessRequestContext;
}

function authorizedContext(): HumanAccessRequestContext {
  return {
    state: "authorized",
    identity: { email: "owner@example.com" },
    application: { queries: { requireCapability: async () => undefined } },
  } as unknown as HumanAccessRequestContext;
}

/** Stands in for the query application, failing the way the case under test does. */
function contextThatFailsWith(
  failure: Error,
): typeof createAnalyticsDashboardContext {
  return (async () => {
    throw failure;
  }) as unknown as typeof createAnalyticsDashboardContext;
}

const emptyEnvelope = {
  schemaVersion: "foundry.analytics.v1" as const,
  siteId: installedSiteDefinition.site.id,
  range: {
    timeZone: defaultReportingTimeZone,
    fromLocalDate: "2026-06-06",
    toLocalDate: "2026-07-03",
    startUtc: "2026-06-06T07:00:00.000Z",
    endUtc: "2026-07-04T07:00:00.000Z",
    granularity: "day" as const,
    containsIncompleteBucket: false,
    clampedToRetention: false,
  },
};

/** Stands in for the query application, succeeding with empty views. */
function contextThatSucceeds(): typeof createAnalyticsDashboardContext {
  return (async () => ({
    queries: {
      overview: async () => ({
        ...emptyEnvelope,
        metrics: [],
        referrers: [],
        comparison: null,
        sources: [],
      }),
      traffic: async () => ({ ...emptyEnvelope, days: [], sources: [] }),
      content: async () => ({ ...emptyEnvelope, items: [] }),
      forms: async () => ({ ...emptyEnvelope, items: [] }),
      audience: async () => ({ ...emptyEnvelope, metrics: [] }),
      campaigns: async () => ({ ...emptyEnvelope, items: [] }),
      health: async () => ({
        ...emptyEnvelope,
        sources: [],
        retention: { aggregateFactMonths: 25 },
        earliestFactInstant: null,
        disagreements: [],
      }),
    },
  })) as unknown as typeof createAnalyticsDashboardContext;
}

describe("the default reporting range", () => {
  it("covers seven local days ending today", () => {
    const range = defaultReportingRange(
      "2026-07-03T12:00:00.000Z",
      defaultReportingTimeZone,
    );

    expect(range).toEqual({
      fromLocalDate: "2026-06-27",
      toLocalDate: "2026-07-03",
    });
  });

  it("covers thirty local days when thirty days are asked for", () => {
    const range = defaultReportingRange(
      "2026-07-03T12:00:00.000Z",
      defaultReportingTimeZone,
      30,
    );

    expect(range).toEqual({
      fromLocalDate: "2026-06-04",
      toLocalDate: "2026-07-03",
    });
  });

  it("answers anything but 7 or 30 with the shorter period", () => {
    expect(resolveReportingPeriodDays("30")).toBe(30);
    expect(resolveReportingPeriodDays("7")).toBe(7);
    expect(resolveReportingPeriodDays("365")).toBe(7);
    expect(resolveReportingPeriodDays("all the days")).toBe(7);
    expect(resolveReportingPeriodDays(undefined)).toBe(7);
  });
});

describe("the sample figures a developer sees locally", () => {
  /** Runs one load with `NODE_ENV` set, and puts it back afterwards. */
  async function loadWithNodeEnv(nodeEnv: string) {
    const previous = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", nodeEnv);
    try {
      return await loadAnalyticsDashboard(
        authorizedContext(),
        () => "2026-07-03T00:00:00.000Z",
        contextThatFailsWith(
          new AnalyticsDashboardError("analytics_not_configured"),
        ),
      );
    } finally {
      vi.stubEnv("NODE_ENV", previous ?? "test");
    }
  }

  it("shows labelled sample figures in local development", async () => {
    const data = await loadWithNodeEnv("development");

    expect(data?.sample).toBe(true);
    expect(data?.traffic.days).toHaveLength(7);
    expect(data?.overview.comparison).not.toBeNull();
  });

  it("shows no sample figures outside local development", async () => {
    for (const nodeEnv of ["production", "test", "staging"]) {
      expect(await loadWithNodeEnv(nodeEnv)).toBeNull();
    }
  });
});

describe("loading the dashboard", () => {
  it("shows nothing at all to a caller who is not signed in", async () => {
    expect(await loadAnalyticsDashboard(unauthorizedContext())).toBeNull();
  });

  it("renders the empty panel when the read model is not reachable", async () => {
    const data = await loadAnalyticsDashboard(
      authorizedContext(),
      () => "2026-07-03T00:00:00.000Z",
      contextThatFailsWith(
        new AnalyticsDashboardError("analytics_not_configured"),
      ),
    );

    expect(data).toBeNull();
  });

  it("propagates AnalyticsPrivacyViolationError to the Next.js error boundary", async () => {
    await expect(
      loadAnalyticsDashboard(
        authorizedContext(),
        () => "2026-07-03T00:00:00.000Z",
        contextThatFailsWith(
          new AnalyticsPrivacyViolationError("visitorId", "metrics.visitorId"),
        ),
      ),
    ).rejects.toThrow(AnalyticsPrivacyViolationError);
  });

  it("names every page's title by its content id, for the Content section", async () => {
    const data = await loadAnalyticsDashboard(
      authorizedContext(),
      () => "2026-07-03T00:00:00.000Z",
      contextThatSucceeds(),
    );

    const home = homePage(installedSiteDefinition);
    expect(data?.contentTitles[home.id]).toBe(pageDisplayTitle(home));
    // The stored fact shape stays an aggregate: this map holds a title
    // string keyed by a public content id, never a visitor or session field.
    expect(Object.keys(data ?? {})).not.toContain("visitorId");
  });

  it("propagates AnalyticsVocabularyError to the Next.js error boundary", async () => {
    const vocabularyFailure = new Error("unknown metric");
    vocabularyFailure.name = "AnalyticsVocabularyError";

    await expect(
      loadAnalyticsDashboard(
        authorizedContext(),
        () => "2026-07-03T00:00:00.000Z",
        contextThatFailsWith(vocabularyFailure),
      ),
    ).rejects.toThrow("unknown metric");
  });
});

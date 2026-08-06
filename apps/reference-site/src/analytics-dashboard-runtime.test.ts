import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AnalyticsPrivacyViolationError } from "@foundry/application";

import {
  AnalyticsDashboardError,
  createAnalyticsDashboardContext,
  defaultReportingRange,
  defaultReportingTimeZone,
  loadAnalyticsDashboard,
} from "./analytics-dashboard-runtime";
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

describe("the default reporting range", () => {
  it("covers twenty-eight local days ending today", () => {
    const range = defaultReportingRange(
      "2026-07-03T12:00:00.000Z",
      defaultReportingTimeZone,
    );

    expect(range).toEqual({
      fromLocalDate: "2026-06-06",
      toLocalDate: "2026-07-03",
    });
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

  it("lets a privacy breach reach the error boundary instead of hiding it", async () => {
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

  it("lets a vocabulary breach reach the error boundary too", async () => {
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

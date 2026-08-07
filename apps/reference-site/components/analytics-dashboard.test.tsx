import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { analyticsRetention } from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { AnalyticsDashboard } from "./analytics-dashboard";
import type { AnalyticsDashboardData } from "../src/analytics-dashboard-runtime";

const siteId = referenceSiteDefinition.site.id;

const range = {
  timeZone: "America/Vancouver",
  fromLocalDate: "2026-07-01",
  toLocalDate: "2026-07-01",
  startUtc: "2026-07-01T07:00:00.000Z",
  endUtc: "2026-07-02T07:00:00.000Z",
  granularity: "day" as const,
  containsIncompleteBucket: false,
  clampedToRetention: false,
};

function reading(overrides: Record<string, unknown> = {}) {
  return {
    metricKey: "web.page_views" as const,
    definition: "Page views reported by Cloudflare Web Analytics.",
    unit: "count" as const,
    prominence: "primary" as const,
    aggregation: "sum" as const,
    subjectType: "site" as const,
    subjectId: null,
    source: "cloudflare_web" as const,
    sourceName: "cloudflare",
    sourceMetric: "pageViews",
    definitionVersion: 1,
    quality: "estimated" as const,
    sampleInterval: 1,
    observedAt: "2026-07-02T08:00:00.000Z",
    completeThrough: "2026-07-02T07:00:00.000Z",
    freshness: "fresh" as const,
    value: { state: "available" as const, value: 120 },
    measuredBuckets: 1,
    unavailableBuckets: 0,
    comparabilitySignature:
      "web.page_views|cloudflare_web|cloudflare|pageViews|1",
    ...overrides,
  };
}

function referrer(overrides: Record<string, unknown> = {}) {
  return {
    dimensionKey: "referrer_host",
    dimensionValue: "example.com",
    value: { state: "available" as const, value: 12 },
    source: "cloudflare_web" as const,
    sourceName: "cloudflare",
    comparabilitySignature:
      "web.page_views|cloudflare_web|cloudflare|pageViews|1",
    ...overrides,
  };
}

function dashboard(
  overrides: Record<string, unknown> = {},
): AnalyticsDashboardData {
  const envelope = {
    schemaVersion: "foundry.analytics.v1" as const,
    siteId,
    range,
  };
  return {
    overview: {
      ...envelope,
      metrics: [reading()],
      referrers: [referrer()],
      comparison: null,
      sources: [],
    },
    content: { ...envelope, items: [] },
    forms: { ...envelope, items: [] },
    audience: { ...envelope, metrics: [] },
    campaigns: { ...envelope, items: [] },
    health: {
      ...envelope,
      sources: [],
      retention: analyticsRetention,
      earliestFactInstant: null,
      disagreements: [],
    },
    ...overrides,
  } as unknown as AnalyticsDashboardData;
}

describe("the analytics panel", () => {
  it("states that the read model is unavailable and shows no numbers", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={null} />,
    );

    expect(markup).toContain("aggregate read model is unavailable");
    expect(markup).not.toMatch(/>0</u);
  });

  it("shows a measurement with its source and definition", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );

    expect(markup).toContain("Page views");
    expect(markup).toContain("120");
    expect(markup).toContain("cloudflare");
    expect(markup).toContain("Estimated");
  });

  it("names the reason a measurement is missing", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          overview: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            metrics: [
              reading({
                value: { state: "unavailable", reason: "source_unavailable" },
              }),
            ],
            referrers: [],
            comparison: null,
            sources: [],
          },
        })}
      />,
    );

    expect(markup).toContain("Source unavailable");
  });

  it("suppresses a small referrer row", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          overview: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            metrics: [reading()],
            referrers: [
              referrer({
                value: { state: "suppressed", label: "fewer than 5" },
              }),
            ],
            comparison: null,
            sources: [],
          },
        })}
      />,
    );

    expect(markup).toContain("fewer than 5");
  });

  it("names the source only when one referrer arrives from two of them", () => {
    const oneSource = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );
    const twoSources = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          overview: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            metrics: [reading()],
            referrers: [
              referrer(),
              referrer({
                sourceName: "other_web",
                comparabilitySignature:
                  "web.page_views|cloudflare_web|other_web|pageViews|1",
                value: { state: "available", value: 30 },
              }),
            ],
            comparison: null,
            sources: [],
          },
        })}
      />,
    );

    expect(oneSource).not.toContain("analytics-note");
    expect(twoSources).toContain("analytics-note");
    expect(twoSources).toContain("other_web");
  });

  it("states the retention windows beside the numbers", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );

    expect(markup).toContain(
      `retained for ${analyticsRetention.aggregateFactMonths} months`,
    );
    expect(markup).toContain("No fact has been projected yet.");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { analyticsRetention } from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { AnalyticsDashboard } from "./analytics-dashboard";
import type { AnalyticsDashboardData } from "../src/analytics-dashboard-runtime";

const siteId = referenceSiteDefinition.site.id;

const range = {
  timeZone: "America/Vancouver",
  fromLocalDate: "2026-07-01",
  toLocalDate: "2026-07-07",
  startUtc: "2026-07-01T07:00:00.000Z",
  endUtc: "2026-07-08T07:00:00.000Z",
  granularity: "day" as const,
  containsIncompleteBucket: false,
  clampedToRetention: false,
};

function reading(overrides: Record<string, unknown> = {}) {
  return {
    metricKey: "web.page_views" as const,
    definition: "Pages opened on the site.",
    unit: "count" as const,
    prominence: "primary" as const,
    aggregation: "sum" as const,
    subjectType: "site" as const,
    subjectId: null,
    source: "analytics_engine" as const,
    sourceName: "cloudflare",
    sourceMetric: "worker_points",
    definitionVersion: 1,
    quality: "estimated" as const,
    sampleInterval: 1,
    observedAt: "2026-07-08T08:00:00.000Z",
    completeThrough: "2026-07-08T07:00:00.000Z",
    freshness: "fresh" as const,
    value: { state: "available" as const, value: 120 },
    measuredBuckets: 7,
    unavailableBuckets: 0,
    comparabilitySignature:
      "web.page_views|analytics_engine|cloudflare|worker_points|1",
    ...overrides,
  };
}

function referrer(overrides: Record<string, unknown> = {}) {
  return {
    dimensionKey: "referrer_host",
    dimensionValue: "example.com",
    value: { state: "available" as const, value: 12 },
    source: "analytics_engine" as const,
    sourceName: "cloudflare",
    comparabilitySignature:
      "web.page_views|analytics_engine|cloudflare|worker_points|1",
    ...overrides,
  };
}

function trafficDay(day: string, pageViews: number | null) {
  return {
    bucketStartUtc: `2026-07-0${day}T00:00:00.000Z`,
    pageViews:
      pageViews === null
        ? { state: "unavailable" as const, reason: "not_measured" as const }
        : { state: "available" as const, value: pageViews },
    visits: { state: "available" as const, value: 3 },
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
    periodDays: 7,
    sample: false,
    overview: {
      ...envelope,
      metrics: [
        reading(),
        reading({
          metricKey: "web.visits",
          value: { state: "available", value: 80 },
          comparabilitySignature:
            "web.visits|analytics_engine|cloudflare|worker_points|1",
        }),
      ],
      referrers: [referrer()],
      comparison: {
        range,
        metrics: [
          reading({ value: { state: "available", value: 100 } }),
          reading({
            metricKey: "web.visits",
            value: { state: "available", value: 100 },
            comparabilitySignature:
              "web.visits|analytics_engine|cloudflare|worker_points|1",
          }),
        ],
      },
      sources: [],
    },
    traffic: {
      ...envelope,
      days: [trafficDay("1", 10), trafficDay("2", 42), trafficDay("3", null)],
      sources: [],
    },
    content: { ...envelope, items: [] },
    contentTitles: {},
    contentPaths: {},
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

describe("the Visitors screen", () => {
  it("says the numbers cannot be read, and shows none", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={null} />,
    );

    expect(markup).toContain("cannot be read at the moment");
    expect(markup).not.toMatch(/>0</u);
  });

  it("shows visits and page views with the change on the period before", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );

    expect(markup).toContain("Page views");
    expect(markup).toContain("120");
    expect(markup).toContain("Visits");
    expect(markup).toContain("Up 20% on the 7 days before.");
    expect(markup).toContain("Down 20% on the 7 days before.");
  });

  it("offers the last 7 days and the last 30 days", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );

    expect(markup).toContain('href="/dash/analytics?days=7"');
    expect(markup).toContain('href="/dash/analytics?days=30"');
    expect(markup).toContain("Last 30 days");
  });

  it("draws the daily chart as inline SVG", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );

    expect(markup).toContain("<svg");
    expect(markup).toContain('role="img"');
    // The bucket starting 2026-07-02T00:00Z is 1 July in the site's own
    // reporting zone, and the owner reads the day they had, not the UTC one.
    expect(markup).toContain("Busiest day: Jul 1, 42 page views.");
    expect(markup).toContain("1 of these days have not been counted yet.");
  });

  it("adds no bar when every counted day had no page views", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          traffic: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            days: [trafficDay("1", 0), trafficDay("2", 0)],
            sources: [],
          },
        })}
      />,
    );

    expect(markup).toContain("had no page views");
    expect(markup).not.toContain("Busiest day");
  });

  it("says when the period is still being counted", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          overview: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range: { ...range, containsIncompleteBucket: true },
            metrics: [reading()],
            referrers: [],
            comparison: null,
            sources: [],
          },
        })}
      />,
    );

    expect(markup).toContain("Today is still being counted");
  });

  it("names the part that is not reporting instead of hiding the screen", () => {
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

    expect(markup).toContain("own counter is not reporting");
    // The rest of the screen is still there.
    expect(markup).toContain("Page views each day");
    expect(markup).toContain("Your mailing list");
  });

  it("names a sample data set, and says so, only when it is given one", () => {
    const real = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );
    const local = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard({ sample: true })} />,
    );

    expect(real).not.toContain("sample figures");
    expect(local).toContain(
      "made-up sample figures for local development",
    );
  });

  it("lists the most read pages by title and web address", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          content: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            items: [
              {
                subjectId: "page_about",
                readings: [
                  reading({
                    metricKey: "content.page_views",
                    subjectType: "content",
                    subjectId: "page_about",
                    value: { state: "available", value: 45 },
                  }),
                ],
                vitals: [],
              },
            ],
          },
          contentTitles: { page_about: "About" },
          contentPaths: { page_about: "/about" },
        })}
      />,
    );

    expect(markup).toContain("About");
    expect(markup).toContain("/about");
    expect(markup).toContain("45");
  });

  it("shows two parts that counted the same thing apart, each named", () => {
    const fromTrafficService = {
      source: "cloudflare_web" as const,
      sourceName: "cloudflare",
      sourceMetric: "pageViews",
      comparabilitySignature:
        "web.page_views|cloudflare_web|cloudflare|pageViews|1",
    };
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          overview: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            metrics: [
              reading(),
              reading({
                ...fromTrafficService,
                value: { state: "available", value: 99 },
              }),
            ],
            referrers: [
              referrer(),
              referrer({
                ...fromTrafficService,
                value: { state: "available", value: 30 },
              }),
            ],
            comparison: null,
            sources: [],
          },
        })}
      />,
    );

    // Both numbers are shown, neither is added to the other, and each says
    // which part of the site counted it.
    expect(markup).toContain("120");
    expect(markup).toContain("99");
    expect(markup).toContain("own counter");
    expect(markup).toContain("the traffic service");
  });

  it("names a referrer channel in plain words", () => {
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
                dimensionKey: "referrer_channel",
                dimensionValue: "search",
              }),
            ],
            comparison: null,
            sources: [],
          },
        })}
      />,
    );

    expect(markup).toContain("A search engine");
    expect(markup).not.toContain(">search<");
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

  it("keeps the message, mailing list and newsletter numbers", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard
        analytics={dashboard({
          forms: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            items: [
              {
                subjectId: "form_contact",
                accepted: reading({
                  metricKey: "form.submissions_accepted",
                  source: "d1",
                  quality: "exact",
                  value: { state: "available", value: 9 },
                }),
                blocked: reading({ metricKey: "form.submissions_blocked" }),
                notificationsDelivered: reading({
                  metricKey: "form.notifications_delivered",
                }),
                notificationsFailed: reading({
                  metricKey: "form.notifications_failed",
                }),
                impressions: reading({
                  metricKey: "interaction.form_impressions",
                }),
                conversionRate: {
                  metricKey: "form.conversion_rate",
                  definition: "Messages for every form seen.",
                  unit: "ratio",
                  quality: "estimated",
                  numeratorMetricKey: "form.submissions_accepted",
                  denominatorMetricKey: "interaction.form_impressions",
                  denominatorQuality: "best_effort",
                  value: { state: "available", value: 0.1 },
                },
              },
            ],
          },
          audience: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            metrics: [
              reading({
                metricKey: "subscriber.active",
                source: "d1",
                quality: "exact",
                value: { state: "available", value: 52 },
              }),
            ],
          },
          campaigns: {
            schemaVersion: "foundry.analytics.v1",
            siteId,
            range,
            items: [
              {
                subjectId: "campaign_july",
                readings: [
                  reading({
                    metricKey: "campaign.delivered",
                    source: "provider",
                    quality: "provider_reported",
                    value: { state: "available", value: 48 },
                  }),
                ],
                collapsedEngagement: [],
                providerChanged: false,
              },
            ],
          },
        })}
      />,
    );

    expect(markup).toContain("Messages received");
    expect(markup).toContain("9");
    expect(markup).toContain("People on your list");
    expect(markup).toContain("52");
    expect(markup).toContain("Delivered");
    expect(markup).toContain("48");
  });

  it("states how long the numbers are kept, in plain words", () => {
    const markup = renderToStaticMarkup(
      <AnalyticsDashboard analytics={dashboard()} />,
    );

    expect(markup).toContain(
      `kept for ${analyticsRetention.aggregateFactMonths} months`,
    );
    expect(markup).toContain("no cookie is set");
  });
});

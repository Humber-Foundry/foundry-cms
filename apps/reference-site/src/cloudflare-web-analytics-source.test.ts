import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CloudflareWebAnalyticsSourceError,
  fetchCloudflareWebAnalytics,
  normalizeCloudflareWebAnalytics,
  normalizePublishedPath,
  normalizeReferrer,
  type CloudflareWebAnalyticsResponse,
} from "./cloudflare-web-analytics-source";

const routeHistory = [
  {
    path: "/about",
    contentId: "content_about",
    fromUtc: "2026-01-01T00:00:00.000Z",
    toUtc: null,
  },
  {
    path: "/news",
    contentId: "content_news_v1",
    fromUtc: "2026-01-01T00:00:00.000Z",
    toUtc: "2026-08-01T00:00:00.000Z",
  },
  {
    path: "/news",
    contentId: "content_news_v2",
    fromUtc: "2026-08-01T00:00:00.000Z",
    toUtc: null,
  },
];

function pageload(overrides: Record<string, unknown> = {}) {
  return {
    count: 40,
    sum: { visits: 25 },
    avg: { sampleInterval: 1 },
    dimensions: {
      date: "2026-08-01",
      requestPath: "/about",
      refererHost: "news.example.org",
    },
    ...overrides,
  };
}

function normalize(response: Partial<CloudflareWebAnalyticsResponse>) {
  return normalizeCloudflareWebAnalytics({
    response: { pageloads: [], webVitals: [], ...response },
    siteId: "site_reference",
    routeHistory,
  });
}

describe("normalizing published paths and referrers", () => {
  it("drops the query string a published path never needs", () => {
    expect(normalizePublishedPath("/about?utm_source=news#top")).toBe(
      "/about",
    );
  });

  it("refuses a path that is not a published route", () => {
    expect(() =>
      normalizePublishedPath("https://example.com/about"),
    ).toThrow(CloudflareWebAnalyticsSourceError);
  });

  it("reduces a referrer to a bare host", () => {
    expect(normalizeReferrer("News.Example.org")).toEqual({
      key: "referrer_host",
      value: "news.example.org",
    });
  });

  it("reports an absent referrer as the direct channel", () => {
    expect(normalizeReferrer("")).toEqual({
      key: "referrer_channel",
      value: "direct",
    });
  });

  it("groups a search engine into its channel", () => {
    expect(normalizeReferrer("google.co.uk")).toEqual({
      key: "referrer_channel",
      value: "search",
    });
  });
});

describe("normalizing a response", () => {
  it("produces site totals and a referrer breakdown from one group", () => {
    const measurements = normalize({ pageloads: [pageload()] });

    expect(
      measurements.filter(
        (entry) =>
          entry.metricKey === "web.page_views" && entry.dimension.key === "",
      ),
    ).toMatchObject([
      {
        subjectType: "site",
        subjectId: "site_reference",
        bucketStartUtc: "2026-08-01T00:00:00.000Z",
        bucketEndUtc: "2026-08-02T00:00:00.000Z",
        value: 40,
        quality: "estimated",
      },
    ]);
    expect(
      measurements.find((entry) => entry.dimension.key === "referrer_host"),
    ).toMatchObject({ dimension: { key: "referrer_host", value: "news.example.org" }, value: 40 });
  });

  it("keeps referral-based visits separate from page views", () => {
    const measurements = normalize({ pageloads: [pageload()] });

    expect(
      measurements.find((entry) => entry.metricKey === "web.visits"),
    ).toMatchObject({ value: 25 });
  });

  it("attributes a path to the content item that owned it in that bucket", () => {
    const measurements = normalize({
      pageloads: [
        pageload({
          dimensions: {
            date: "2026-07-30",
            requestPath: "/news",
            refererHost: "",
          },
        }),
        pageload({
          dimensions: {
            date: "2026-08-02",
            requestPath: "/news",
            refererHost: "",
          },
        }),
      ],
    });

    expect(
      measurements
        .filter((entry) => entry.metricKey === "content.page_views")
        .map((entry) => entry.subjectId),
    ).toEqual(["content_news_v1", "content_news_v2"]);
  });

  it("leaves an unmapped path out of content attribution", () => {
    const measurements = normalize({
      pageloads: [
        pageload({
          dimensions: {
            date: "2026-08-01",
            requestPath: "/unknown",
            refererHost: "",
          },
        }),
      ],
    });

    expect(
      measurements.some((entry) => entry.metricKey === "content.page_views"),
    ).toBe(false);
    expect(
      measurements.find((entry) => entry.metricKey === "web.page_views"),
    ).toMatchObject({ value: 40 });
  });

  it("carries the platform sampling interval with the value", () => {
    const measurements = normalize({
      pageloads: [pageload({ avg: { sampleInterval: 10 } })],
    });

    expect(
      measurements.find((entry) => entry.metricKey === "web.page_views"),
    ).toMatchObject({ sampleInterval: 10, quality: "estimated" });
  });

  it("refuses a response that volunteers an unrequested dimension", () => {
    expect(() =>
      normalize({
        pageloads: [
          pageload({
            dimensions: {
              date: "2026-08-01",
              requestPath: "/about",
              refererHost: "",
              countryName: "Canada",
            },
          }),
        ],
      }),
    ).toThrow(CloudflareWebAnalyticsSourceError);
  });

  it("reports a Web Vital no browser supplied as unavailable", () => {
    const measurements = normalize({
      webVitals: [
        {
          dimensions: { date: "2026-08-01", requestPath: "/about" },
          quantiles: { lcpP75: 1_800, inpP75: null, clsP75: 0.04 },
        },
      ],
    });

    expect(
      measurements.find(
        (entry) => entry.metricKey === "web.vitals.inp_p75",
      ),
    ).toMatchObject({ value: null, unavailableReason: "not_measured" });
    expect(
      measurements.find(
        (entry) => entry.metricKey === "web.vitals.lcp_p75",
      ),
    ).toMatchObject({
      value: 1_800,
      unit: "milliseconds",
      quality: "partial_population",
      subjectId: "content_about",
    });
  });
});

describe("querying the GraphQL analytics API", () => {
  it("sends only the declared aggregate query with the scoped token", async () => {
    const calls: Array<{ url: string; body: unknown; headers: unknown }> = [];
    const fetchImplementation = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers,
      });
      return new Response(
        JSON.stringify({
          data: { viewer: { accounts: [{ pageloads: [pageload()] }] } },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const groups = await fetchCloudflareWebAnalytics({
      accountTag: "account",
      siteTag: "site",
      apiToken: "token",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-02T00:00:00.000Z",
      fetchImplementation,
    });

    expect(groups).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    const query = (call.body as { query: string }).query;
    const requestedDimensions = /dimensions \{([^}]*)\}/u
      .exec(query)?.[1]
      .trim()
      .split(/\s+/u);
    expect(requestedDimensions).toEqual(["date", "requestPath", "refererHost"]);
    expect(query).not.toMatch(
      /countryName|userAgentBrowser|deviceType|refererPath|queryString/u,
    );
  });

  it("treats a GraphQL error as a failed query", async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "denied" }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      fetchCloudflareWebAnalytics({
        accountTag: "account",
        siteTag: "site",
        apiToken: "token",
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-02T00:00:00.000Z",
        fetchImplementation,
      }),
    ).rejects.toThrow(CloudflareWebAnalyticsSourceError);
  });
});

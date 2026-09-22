import { describe, expect, it } from "vitest";

import { assertAggregateAnalyticsPayload } from "@humber-foundry/application";

import {
  isPublicPagePath,
  publishedContentRoutes,
  recordWebTraffic,
  webTrafficEventKind,
  webTrafficPointFor,
  withWebTrafficCounting,
  writeWebTrafficPoint,
  type WebTrafficPoint,
} from "./web-traffic-collector";

/** Collects what the Worker would write to the Analytics Engine dataset. */
function recordingDataset() {
  const points: Array<{
    blobs: ReadonlyArray<string>;
    doubles?: ReadonlyArray<number>;
    indexes?: ReadonlyArray<string>;
  }> = [];
  return {
    points,
    writeDataPoint(point: {
      blobs: ReadonlyArray<string>;
      doubles?: ReadonlyArray<number>;
      indexes?: ReadonlyArray<string>;
    }) {
      points.push(point);
    },
  };
}

const routes = new Map([
  ["/", "page_home"],
  ["/about", "page_about"],
  ["/blog/first-post", "post_first"],
]);

function htmlResponse(overrides: { status?: number; type?: string } = {}) {
  return new Response("<html></html>", {
    status: overrides.status ?? 200,
    headers: {
      "content-type": overrides.type ?? "text/html; charset=utf-8",
    },
  });
}

function pageRequest(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  return new Request(url, { method, headers });
}

describe("which requests count as a page view", () => {
  it("counts a public page the site serves", () => {
    const point = webTrafficPointFor({
      request: pageRequest("https://example.ca/about"),
      response: htmlResponse(),
      routes,
    });

    expect(point).toEqual({
      contentId: "page_about",
      referrerKey: "referrer_channel",
      referrerValue: "direct",
      arrival: true,
    });
  });

  it("counts a page the site does not own, without naming it", () => {
    const point = webTrafficPointFor({
      request: pageRequest("https://example.ca/gone"),
      response: htmlResponse(),
      routes,
    });

    expect(point?.contentId).toBe("");
  });

  it("treats a trailing slash as the same address", () => {
    const point = webTrafficPointFor({
      request: pageRequest("https://example.ca/about/"),
      response: htmlResponse(),
      routes,
    });

    expect(point?.contentId).toBe("page_about");
  });

  it("ignores a dashboard page, an API call and an asset", () => {
    for (const path of [
      "/dash",
      "/dash/analytics",
      "/api/analytics/interactions",
      "/_next/static/chunk.js",
    ]) {
      expect(isPublicPagePath(path)).toBe(false);
    }
    expect(
      webTrafficPointFor({
        request: pageRequest("https://example.ca/dash/analytics"),
        response: htmlResponse(),
        routes,
      }),
    ).toBeNull();
  });

  it("ignores anything that is not a served HTML page", () => {
    expect(
      webTrafficPointFor({
        request: pageRequest("https://example.ca/about"),
        response: htmlResponse({ status: 404 }),
        routes,
      }),
    ).toBeNull();
    expect(
      webTrafficPointFor({
        request: pageRequest("https://example.ca/about"),
        response: htmlResponse({ type: "application/json" }),
        routes,
      }),
    ).toBeNull();
    expect(
      webTrafficPointFor({
        request: pageRequest("https://example.ca/about", {}, "POST"),
        response: htmlResponse(),
        routes,
      }),
    ).toBeNull();
  });
});

describe("what one page view records", () => {
  it("keeps the referring host, and never its address or query string", () => {
    const point = webTrafficPointFor({
      request: pageRequest("https://example.ca/about?utm_source=news", {
        referer: "https://Partner.Example.COM/some/page?who=me",
      }),
      response: htmlResponse(),
      routes,
    });

    expect(point).toEqual({
      contentId: "page_about",
      referrerKey: "referrer_host",
      referrerValue: "partner.example.com",
      arrival: true,
    });
  });

  it("names a search engine by channel rather than by host", () => {
    const point = webTrafficPointFor({
      request: pageRequest("https://example.ca/", {
        referer: "https://google.com/search?q=boats",
      }),
      response: htmlResponse(),
      routes,
    });

    expect(point?.referrerValue).toBe("search");
  });

  it("counts a move inside the site as a page view but not an arrival", () => {
    const point = webTrafficPointFor({
      request: pageRequest("https://example.ca/about", {
        referer: "https://example.ca/",
      }),
      response: htmlResponse(),
      routes,
    });

    expect(point).toEqual({
      contentId: "page_about",
      referrerKey: "",
      referrerValue: "",
      arrival: false,
    });
  });

  it("writes four labels and two numbers, and nothing else", () => {
    const dataset = recordingDataset();
    const point: WebTrafficPoint = {
      contentId: "page_about",
      referrerKey: "referrer_host",
      referrerValue: "partner.example.com",
      arrival: true,
    };

    writeWebTrafficPoint(dataset, point);

    expect(dataset.points).toEqual([
      {
        blobs: [
          webTrafficEventKind,
          "page_about",
          "referrer_host",
          "partner.example.com",
        ],
        doubles: [1, 1],
      },
    ]);
    expect(dataset.points[0].indexes).toBeUndefined();
  });
});

describe("the privacy rules the read model enforces", () => {
  const personalHeaders = {
    referer: "https://partner.example.com/profile/someone?email=a@b.example",
    "user-agent": "Mozilla/5.0 (Macintosh)",
    "cf-connecting-ip": "203.0.113.7",
    cookie: "session=abc123",
    "x-forwarded-for": "203.0.113.7",
  };

  it("records nothing that identifies a person, a device or a request", () => {
    const dataset = recordingDataset();

    recordWebTraffic({
      request: pageRequest(
        "https://example.ca/about?email=someone@example.com",
        personalHeaders,
      ),
      response: htmlResponse(),
      dataset,
      routes,
    });

    const [written] = dataset.points;
    // The same guard the projector runs before a fact reaches the store.
    assertAggregateAnalyticsPayload(written);
    for (const value of written.blobs) {
      // The checks migration 0025 states for a dimension value: no address,
      // no query string, and no more than 253 characters.
      expect(value).not.toContain("@");
      expect(value).not.toContain("?");
      expect(value).not.toContain("://");
      expect(value.length).toBeLessThanOrEqual(253);
    }
    expect(JSON.stringify(written)).not.toContain("203.0.113.7");
    expect(JSON.stringify(written)).not.toContain("Mozilla");
    expect(JSON.stringify(written)).not.toContain("abc123");
  });

  it("sets no cookie and changes nothing about the answer", () => {
    const dataset = recordingDataset();
    const response = htmlResponse();

    recordWebTraffic({
      request: pageRequest("https://example.ca/about"),
      response,
      dataset,
      routes,
    });

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.status).toBe(200);
    expect(dataset.points).toHaveLength(1);
  });

  it("counts nothing when the site has no analytics dataset", () => {
    expect(() =>
      recordWebTraffic({
        request: pageRequest("https://example.ca/about"),
        response: htmlResponse(),
        dataset: undefined,
        routes,
      }),
    ).not.toThrow();
  });
});

describe("the Worker request path", () => {
  it("counts one page view for a public page it serves", async () => {
    const dataset = recordingDataset();
    const served = htmlResponse();
    const counted = withWebTrafficCounting<
      { FOUNDRY_INTERACTIONS?: typeof dataset },
      undefined
    >(async () => served, routes);

    const answer = await counted(
      pageRequest("https://example.ca/about"),
      { FOUNDRY_INTERACTIONS: dataset },
      undefined,
    );

    expect(answer).toBe(served);
    expect(dataset.points).toHaveLength(1);
    expect(dataset.points[0].blobs[0]).toBe(webTrafficEventKind);
    expect(dataset.points[0].doubles?.[0]).toBe(1);
  });

  it("counts three page views for three public pages", async () => {
    const dataset = recordingDataset();
    const counted = withWebTrafficCounting<
      { FOUNDRY_INTERACTIONS?: typeof dataset },
      undefined
    >(async () => htmlResponse(), routes);

    for (const path of ["/", "/about", "/blog/first-post"]) {
      await counted(
        pageRequest(`https://example.ca${path}`),
        { FOUNDRY_INTERACTIONS: dataset },
        undefined,
      );
    }

    expect(dataset.points).toHaveLength(3);
    expect(dataset.points.map((point) => point.blobs[1])).toEqual([
      "page_home",
      "page_about",
      "post_first",
    ]);
  });

  it("counts nothing for a dashboard page it serves", async () => {
    const dataset = recordingDataset();
    const counted = withWebTrafficCounting<
      { FOUNDRY_INTERACTIONS?: typeof dataset },
      undefined
    >(async () => htmlResponse(), routes);

    await counted(
      pageRequest("https://example.ca/dash/analytics"),
      { FOUNDRY_INTERACTIONS: dataset },
      undefined,
    );

    expect(dataset.points).toHaveLength(0);
  });
});

describe("the published addresses the counter knows", () => {
  it("holds one address for every page and post the site publishes", () => {
    const published = publishedContentRoutes();

    expect(published.get("/")).toMatch(/^page_/u);
    expect([...published.keys()].every((path) => path.startsWith("/"))).toBe(
      true,
    );
    expect([...new Set(published.values())].length).toBe(published.size);
  });
});

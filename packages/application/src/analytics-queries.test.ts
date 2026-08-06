import { beforeEach, describe, expect, it } from "vitest";

import { createSiteId } from "@foundry/site-definition";

import {
  analyticsSchemaVersion,
  type AnalyticsSourceState,
} from "./analytics-model";
import type { StoredAnalyticsFact } from "./analytics-projection";
import {
  AnalyticsRangeError,
  createAnalyticsQueryApplication,
  createAnalyticsQueryCache,
  resolveReportingRange,
  type AnalyticsReadStore,
} from "./analytics-queries";

const siteId = createSiteId("site_reference");
const actor = { email: "owner@example.com" };
const timeZone = "America/Vancouver";

let facts: StoredAnalyticsFact[];
let sourceStates: AnalyticsSourceState[];
let authorized: string[];

function fact(
  overrides: Partial<StoredAnalyticsFact> & Pick<StoredAnalyticsFact, "metricKey">,
): StoredAnalyticsFact {
  return {
    siteId,
    schemaVersion: analyticsSchemaVersion,
    bucketStartUtc: "2026-07-01T07:00:00.000Z",
    bucketEndUtc: "2026-07-02T07:00:00.000Z",
    granularity: "day",
    subjectType: "site",
    subjectId: "site_reference",
    dimensionKey: "",
    dimensionValue: "",
    source: "cloudflare_web",
    sourceName: "cloudflare",
    sourceMetric: "pageViews",
    definitionVersion: 1,
    unit: "count",
    quality: "estimated",
    sampleInterval: 1,
    availability: "available",
    value: 100,
    unavailableReason: null,
    observedAt: "2026-07-02T08:00:00.000Z",
    completeThrough: "2026-07-02T07:00:00.000Z",
    revision: 1,
    ...overrides,
  } as StoredAnalyticsFact;
}

function sourceState(
  overrides: Partial<AnalyticsSourceState> = {},
): AnalyticsSourceState {
  return {
    source: "cloudflare_web",
    sourceName: "cloudflare",
    status: "healthy",
    lastAttemptAt: "2026-07-02T08:00:00.000Z",
    lastSuccessAt: "2026-07-02T08:00:00.000Z",
    completeThrough: "2026-07-02T07:00:00.000Z",
    nextRetryAt: null,
    errorCode: null,
    definitionVersion: 1,
    ...overrides,
  };
}

const store: AnalyticsReadStore = {
  async listFacts(query) {
    return facts.filter(
      (candidate) =>
        query.metricKeys.includes(candidate.metricKey) &&
        candidate.granularity === query.granularity &&
        Date.parse(candidate.bucketStartUtc) >= Date.parse(query.startUtc) &&
        Date.parse(candidate.bucketStartUtc) < Date.parse(query.endUtc),
    );
  },
  async listSourceStates() {
    return sourceStates;
  },
  async earliestFactInstant() {
    return "2024-07-01T00:00:00.000Z";
  },
};

function application(now = "2026-07-03T00:00:00.000Z") {
  return createAnalyticsQueryApplication({
    siteId,
    store,
    reportingTimeZone: timeZone,
    now: () => now,
    authorize: async (_actor, capability) => {
      authorized.push(capability);
    },
  });
}

const july = { fromLocalDate: "2026-07-01", toLocalDate: "2026-07-01" };

beforeEach(() => {
  facts = [];
  sourceStates = [sourceState()];
  authorized = [];
});

describe("reporting range", () => {
  it("converts one configured time zone's local days to a UTC interval", () => {
    expect(
      resolveReportingRange({
        fromLocalDate: "2026-07-01",
        toLocalDate: "2026-07-01",
        timeZone,
      }),
    ).toMatchObject({
      startUtc: "2026-07-01T07:00:00.000Z",
      endUtc: "2026-07-02T07:00:00.000Z",
    });
  });

  it("treats a daylight-saving end as a real 25-hour local day", () => {
    const range = resolveReportingRange({
      fromLocalDate: "2026-11-01",
      toLocalDate: "2026-11-01",
      timeZone,
    });

    expect(range.startUtc).toBe("2026-11-01T07:00:00.000Z");
    expect(range.endUtc).toBe("2026-11-02T08:00:00.000Z");
  });

  it("treats a daylight-saving start as a real 23-hour local day", () => {
    const range = resolveReportingRange({
      fromLocalDate: "2026-03-08",
      toLocalDate: "2026-03-08",
      timeZone,
    });

    expect(range.startUtc).toBe("2026-03-08T08:00:00.000Z");
    expect(range.endUtc).toBe("2026-03-09T07:00:00.000Z");
  });

  it("refuses a range that ends before it starts", () => {
    expect(() =>
      resolveReportingRange({
        fromLocalDate: "2026-07-02",
        toLocalDate: "2026-07-01",
        timeZone,
      }),
    ).toThrow(AnalyticsRangeError);
  });

  it("refuses a malformed local date", () => {
    expect(() =>
      resolveReportingRange({
        fromLocalDate: "01-07-2026",
        toLocalDate: "2026-07-01",
        timeZone,
      }),
    ).toThrow(AnalyticsRangeError);
  });

  it("reads whole-day ranges from one stored granularity", () => {
    expect(
      resolveReportingRange({ ...july, timeZone, now: "2026-07-03T00:00:00.000Z" })
        .granularity,
    ).toBe("day");
    expect(
      resolveReportingRange({
        fromLocalDate: "2026-06-01",
        toLocalDate: "2026-07-01",
        timeZone,
        now: "2026-07-03T00:00:00.000Z",
      }).granularity,
    ).toBe("day");
  });

  it("reads an explicit intraday request from the hourly facts", () => {
    expect(
      resolveReportingRange({
        ...july,
        timeZone,
        granularity: "hour",
        now: "2026-07-03T00:00:00.000Z",
      }).granularity,
    ).toBe("hour");
  });

  it("refuses an hourly read once the hourly facts have compacted", () => {
    expect(() =>
      resolveReportingRange({
        ...july,
        timeZone,
        granularity: "hour",
        now: "2027-01-01T00:00:00.000Z",
      }),
    ).toThrow(AnalyticsRangeError);
  });
});

describe("authorization", () => {
  it("requires the analytics capability before reading", async () => {
    await application().queries.overview({ actor, range: july });

    expect(authorized).toContain("analytics.read");
  });
});

describe("every reading carries its interpretation", () => {
  it("returns source, definition, quality, observation and completeness", async () => {
    facts = [fact({ metricKey: "web.page_views" })];

    const overview = await application().queries.overview({
      actor,
      range: july,
    });
    const reading = overview.metrics.find(
      (entry) => entry.metricKey === "web.page_views",
    );

    expect(reading).toMatchObject({
      source: "cloudflare_web",
      sourceName: "cloudflare",
      sourceMetric: "pageViews",
      definitionVersion: 1,
      quality: "estimated",
      unit: "count",
      observedAt: "2026-07-02T08:00:00.000Z",
      completeThrough: "2026-07-02T07:00:00.000Z",
      value: { state: "available", value: 100 },
    });
    expect(reading?.definition).toMatch(/Cloudflare Web Analytics/u);
    expect(reading?.freshness).toBe("fresh");
  });

  it("echoes the reporting zone and the exact UTC interval it read", async () => {
    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(overview.range).toMatchObject({
      timeZone,
      fromLocalDate: "2026-07-01",
      toLocalDate: "2026-07-01",
      startUtc: "2026-07-01T07:00:00.000Z",
      endUtc: "2026-07-02T07:00:00.000Z",
    });
  });

  it("marks a range whose last bucket is still accumulating", async () => {
    facts = [
      fact({
        metricKey: "web.page_views",
        completeThrough: "2026-07-01T12:00:00.000Z",
      }),
    ];

    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(overview.range.containsIncompleteBucket).toBe(true);
    expect(
      overview.metrics.find((entry) => entry.metricKey === "web.page_views")
        ?.freshness,
    ).toBe("in_progress");
  });
});

describe("missing measurements report an unavailable state", () => {
  it("reports an unmeasured metric as unavailable", async () => {
    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(
      overview.metrics.find((entry) => entry.metricKey === "web.page_views")
        ?.value,
    ).toEqual({ state: "unavailable", reason: "not_measured" });
  });

  it("attributes the gap to the unavailable source", async () => {
    sourceStates = [
      sourceState({ status: "unavailable", errorCode: "token_revoked" }),
    ];

    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(
      overview.metrics.find((entry) => entry.metricKey === "web.page_views")
        ?.value,
    ).toEqual({ state: "unavailable", reason: "source_unavailable" });
  });

  it("reports a range older than retention as outside retention", async () => {
    const overview = await application().queries.overview({
      actor,
      range: { fromLocalDate: "2023-01-01", toLocalDate: "2023-01-02" },
    });

    expect(overview.range.clampedToRetention).toBe(true);
    expect(
      overview.metrics.every(
        (entry) =>
          entry.value.state === "unavailable" &&
          entry.value.reason === "outside_retention",
      ),
    ).toBe(true);
  });

  it("keeps a provider-omitted metric unavailable in the campaign view", async () => {
    facts = [
      fact({
        metricKey: "campaign.unique_clicks_reported",
        subjectType: "campaign",
        subjectId: "campaign_1",
        granularity: "campaign",
        source: "provider",
        sourceName: "brevo",
        sourceMetric: "uniqueClicks",
        quality: "directional",
        availability: "unavailable",
        value: null,
        unavailableReason: "provider_omitted",
      }),
    ];

    const campaigns = await application().queries.campaigns({
      actor,
      range: july,
    });

    expect(
      campaigns.items[0]?.readings.find(
        (entry) => entry.metricKey === "campaign.unique_clicks_reported",
      )?.value,
    ).toEqual({ state: "unavailable", reason: "provider_omitted" });
  });
});

describe("small-cell suppression", () => {
  it("reports a subject's own small total exactly", async () => {
    facts = [
      fact({
        metricKey: "form.submissions_accepted",
        subjectType: "form",
        subjectId: "form_contact",
        source: "d1",
        sourceName: "foundry",
        sourceMetric: "accepted_submissions",
        quality: "exact",
        value: 2,
      }),
    ];

    const forms = await application().queries.forms({ actor, range: july });

    expect(forms.items[0]?.accepted.value).toEqual({
      state: "available",
      value: 2,
    });
  });

  it("suppresses a small secondary referrer row", async () => {
    facts = [
      fact({ metricKey: "web.page_views", value: 40 }),
      fact({
        metricKey: "web.page_views",
        dimensionKey: "referrer_host",
        dimensionValue: "example.com",
        value: 3,
      }),
      fact({
        metricKey: "web.page_views",
        dimensionKey: "referrer_host",
        dimensionValue: "news.example.org",
        value: 12,
      }),
    ];

    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(
      overview.referrers.map((row) => ({
        dimensionKey: row.dimensionKey,
        dimensionValue: row.dimensionValue,
        value: row.value,
      })),
    ).toEqual([
      {
        dimensionKey: "referrer_host",
        dimensionValue: "news.example.org",
        value: { state: "available", value: 12 },
      },
      {
        dimensionKey: "referrer_host",
        dimensionValue: "example.com",
        value: { state: "suppressed", label: "fewer than 5" },
      },
    ]);
  });

  it("keeps the undimensioned total out of the referrer breakdown", async () => {
    facts = [fact({ metricKey: "web.page_views", value: 40 })];

    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(overview.referrers).toEqual([]);
    expect(
      overview.metrics.find((entry) => entry.metricKey === "web.page_views")
        ?.value,
    ).toEqual({ state: "available", value: 40 });
  });
});

describe("forms", () => {
  function formFacts() {
    return [
      fact({
        metricKey: "form.submissions_accepted",
        subjectType: "form",
        subjectId: "form_contact",
        source: "d1",
        sourceName: "foundry",
        sourceMetric: "accepted_submissions",
        quality: "exact",
        value: 20,
      }),
      fact({
        metricKey: "interaction.form_impressions",
        subjectType: "form",
        subjectId: "form_contact",
        source: "analytics_engine",
        sourceName: "cloudflare",
        sourceMetric: "form_impression",
        quality: "best_effort",
        value: 200,
      }),
    ];
  }

  it("shows the exact numerator beside an estimated conversion rate", async () => {
    facts = formFacts();

    const forms = await application().queries.forms({ actor, range: july });

    expect(forms.items[0]).toMatchObject({
      subjectId: "form_contact",
      accepted: { quality: "exact", value: { state: "available", value: 20 } },
      conversionRate: {
        quality: "estimated",
        unit: "ratio",
        value: { state: "available", value: 0.1 },
      },
    });
  });

  it("names both operands of the estimated rate", async () => {
    facts = formFacts();

    const forms = await application().queries.forms({ actor, range: july });

    expect(forms.items[0]?.conversionRate).toMatchObject({
      numeratorMetricKey: "form.submissions_accepted",
      denominatorMetricKey: "interaction.form_impressions",
      denominatorQuality: "best_effort",
    });
  });

  it("leaves the rate unavailable when the denominator is missing", async () => {
    facts = [formFacts()[0]];

    const forms = await application().queries.forms({ actor, range: july });

    expect(forms.items[0]?.conversionRate.value).toEqual({
      state: "unavailable",
      reason: "not_measured",
    });
    expect(forms.items[0]?.accepted.value).toEqual({
      state: "available",
      value: 20,
    });
  });
});

describe("audience", () => {
  it("reports the latest active snapshot and adds no daily snapshots", async () => {
    facts = [
      fact({
        metricKey: "subscriber.active",
        source: "d1",
        sourceName: "foundry",
        sourceMetric: "active_subscribers",
        quality: "exact",
        value: 310,
      }),
      fact({
        metricKey: "subscriber.active",
        source: "d1",
        sourceName: "foundry",
        sourceMetric: "active_subscribers",
        quality: "exact",
        bucketStartUtc: "2026-07-02T07:00:00.000Z",
        bucketEndUtc: "2026-07-03T07:00:00.000Z",
        value: 314,
      }),
    ];

    const audience = await application().queries.audience({
      actor,
      range: { fromLocalDate: "2026-07-01", toLocalDate: "2026-07-02" },
    });

    expect(
      audience.metrics.find(
        (entry) => entry.metricKey === "subscriber.active",
      ),
    ).toMatchObject({
      aggregation: "latest",
      value: { state: "available", value: 314 },
    });
  });

  it("adds the transition counts that genuinely accumulate", async () => {
    facts = [
      fact({
        metricKey: "subscriber.confirmed",
        source: "d1",
        sourceName: "foundry",
        sourceMetric: "confirmed_transitions",
        quality: "exact",
        value: 6,
      }),
      fact({
        metricKey: "subscriber.confirmed",
        source: "d1",
        sourceName: "foundry",
        sourceMetric: "confirmed_transitions",
        quality: "exact",
        bucketStartUtc: "2026-07-02T07:00:00.000Z",
        bucketEndUtc: "2026-07-03T07:00:00.000Z",
        value: 4,
      }),
    ];

    const audience = await application().queries.audience({
      actor,
      range: { fromLocalDate: "2026-07-01", toLocalDate: "2026-07-02" },
    });

    expect(
      audience.metrics.find(
        (entry) => entry.metricKey === "subscriber.confirmed",
      )?.value,
    ).toEqual({ state: "available", value: 10 });
  });
});

describe("campaigns", () => {
  function campaignFact(overrides: Partial<StoredAnalyticsFact>) {
    return fact({
      metricKey: "campaign.delivered",
      subjectType: "campaign",
      subjectId: "campaign_1",
      granularity: "campaign",
      source: "provider",
      sourceName: "brevo",
      sourceMetric: "delivered",
      quality: "provider_reported",
      value: 480,
      ...overrides,
    });
  }

  it("collapses reported opens below the operational outcomes", async () => {
    facts = [
      campaignFact({}),
      campaignFact({
        metricKey: "campaign.unique_opens_reported",
        sourceMetric: "uniqueOpens",
        quality: "unreliable",
        value: 210,
      }),
    ];

    const campaigns = await application().queries.campaigns({
      actor,
      range: july,
    });

    expect(
      campaigns.items[0]?.readings.map((entry) => entry.metricKey),
    ).toEqual(["campaign.delivered"]);
    expect(
      campaigns.items[0]?.collapsedEngagement.map((entry) => entry.metricKey),
    ).toEqual(["campaign.unique_opens_reported"]);
    expect(campaigns.items[0]?.collapsedEngagement[0]).toMatchObject({
      quality: "unreliable",
      prominence: "collapsed",
    });
  });

  it("keeps two providers' counts as separate marked series", async () => {
    facts = [
      campaignFact({}),
      campaignFact({
        sourceName: "postmark",
        sourceMetric: "delivered_total",
        value: 12,
      }),
    ];

    const campaigns = await application().queries.campaigns({
      actor,
      range: july,
    });
    const delivered = campaigns.items[0]?.readings.filter(
      (entry) => entry.metricKey === "campaign.delivered",
    );

    expect(delivered).toHaveLength(2);
    expect(delivered?.map((entry) => entry.value)).toEqual([
      { state: "available", value: 480 },
      { state: "available", value: 12 },
    ]);
    expect(campaigns.items[0]?.providerChanged).toBe(true);
  });
});

describe("data health", () => {
  it("reports each source's status, freshness and retry state", async () => {
    sourceStates = [
      sourceState(),
      sourceState({
        source: "provider",
        sourceName: "brevo",
        status: "delayed",
        errorCode: "provider_quota_exceeded",
        nextRetryAt: "2026-07-03T01:00:00.000Z",
        lastSuccessAt: "2026-07-01T08:00:00.000Z",
        completeThrough: "2026-07-01T07:00:00.000Z",
      }),
    ];

    const health = await application().queries.health({ actor });

    expect(health.sources).toHaveLength(2);
    expect(health.sources[1]).toMatchObject({
      source: "provider",
      sourceName: "brevo",
      status: "delayed",
      errorCode: "provider_quota_exceeded",
      nextRetryAt: "2026-07-03T01:00:00.000Z",
    });
  });

  it("states the retention windows behind the numbers", async () => {
    const health = await application().queries.health({ actor });

    expect(health.retention).toMatchObject({
      aggregateFactMonths: 25,
      hourlyFactDays: 90,
      cloudflareWebAnalyticsMonths: 6,
      analyticsEngineMonths: 3,
    });
  });

  it("does not give two sources one shared freshness label", async () => {
    sourceStates = [
      sourceState(),
      sourceState({
        source: "d1",
        sourceName: "foundry",
        completeThrough: "2026-07-02T23:00:00.000Z",
        lastSuccessAt: "2026-07-02T23:05:00.000Z",
      }),
    ];

    const health = await application().queries.health({ actor });

    expect(
      new Set(health.sources.map((entry) => entry.completeThrough)).size,
    ).toBe(2);
  });

  it("surfaces a disagreement between two sources of one outcome", async () => {
    facts = [
      fact({
        metricKey: "subscriber.unsubscribed",
        source: "d1",
        sourceName: "foundry",
        sourceMetric: "suppression_unsubscribed",
        quality: "exact",
        value: 9,
      }),
      fact({
        metricKey: "campaign.unsubscribed",
        subjectType: "campaign",
        subjectId: "campaign_1",
        granularity: "campaign",
        source: "provider",
        sourceName: "brevo",
        sourceMetric: "unsubscriptions",
        quality: "provider_reported",
        value: 4,
      }),
    ];

    const health = await application().queries.health({
      actor,
      range: july,
    });

    expect(health.disagreements).toEqual([
      {
        outcome: "unsubscribed",
        readings: [
          {
            metricKey: "subscriber.unsubscribed",
            source: "d1",
            sourceName: "foundry",
            quality: "exact",
            value: { state: "available", value: 9 },
          },
          {
            metricKey: "campaign.unsubscribed",
            source: "provider",
            sourceName: "brevo",
            quality: "provider_reported",
            value: { state: "available", value: 4 },
          },
        ],
      },
    ]);
  });
});

describe("content", () => {
  it("ranks published content and caps the requested page size", async () => {
    facts = [
      fact({
        metricKey: "content.page_views",
        subjectType: "content",
        subjectId: "content_home",
        value: 90,
      }),
      fact({
        metricKey: "content.page_views",
        subjectType: "content",
        subjectId: "content_about",
        value: 140,
      }),
    ];

    const content = await application().queries.content({
      actor,
      range: july,
      limit: 1_000,
    });

    expect(content.limit).toBe(100);
    expect(content.items.map((entry) => entry.subjectId)).toEqual([
      "content_about",
      "content_home",
    ]);
  });

  it("never sums an estimate into an exact count", async () => {
    facts = [
      fact({
        metricKey: "content.page_views",
        subjectType: "content",
        subjectId: "content_home",
        value: 90,
      }),
      fact({
        metricKey: "content.page_views",
        subjectType: "content",
        subjectId: "content_home",
        sourceName: "other-cloudflare",
        sourceMetric: "pageViewsLegacy",
        value: 5,
      }),
    ];

    const content = await application().queries.content({
      actor,
      range: july,
      limit: 10,
    });

    expect(content.items[0]?.readings).toHaveLength(2);
    expect(content.items[0]?.readings.map((entry) => entry.value)).toEqual([
      { state: "available", value: 90 },
      { state: "available", value: 5 },
    ]);
  });
});

describe("unlike referrer series", () => {
  it("keeps two web sources' rows for one referrer apart", async () => {
    facts = [
      fact({
        metricKey: "web.page_views",
        dimensionKey: "referrer_host",
        dimensionValue: "example.com",
        value: 12,
      }),
      fact({
        metricKey: "web.page_views",
        dimensionKey: "referrer_host",
        dimensionValue: "example.com",
        sourceName: "other_web",
        value: 30,
      }),
    ];

    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(overview.referrers).toHaveLength(2);
    expect(
      new Set(overview.referrers.map((row) => row.comparabilitySignature)).size,
    ).toBe(2);
    expect(
      overview.referrers.map((row) => row.value),
    ).toEqual(
      expect.arrayContaining([
        { state: "available", value: 12 },
        { state: "available", value: 30 },
      ]),
    );
  });

  it("adds a referrer's own buckets within one measurement definition", async () => {
    facts = [
      fact({
        metricKey: "web.page_views",
        dimensionKey: "referrer_host",
        dimensionValue: "example.com",
        bucketStartUtc: "2026-07-01T07:00:00.000Z",
        value: 8,
      }),
      fact({
        metricKey: "web.page_views",
        dimensionKey: "referrer_host",
        dimensionValue: "example.com",
        bucketStartUtc: "2026-07-01T08:00:00.000Z",
        value: 5,
      }),
    ];

    const overview = await application().queries.overview({
      actor,
      range: july,
    });

    expect(overview.referrers).toHaveLength(1);
    expect(overview.referrers[0].value).toEqual({
      state: "available",
      value: 13,
    });
  });
});

describe("query caching", () => {
  it("answers a repeated question without reading the store again", async () => {
    facts = [fact({ metricKey: "web.page_views", value: 40 })];
    let reads = 0;
    const countingStore: AnalyticsReadStore = {
      ...store,
      async listFacts(query) {
        reads += 1;
        return store.listFacts(query);
      },
    };
    const cached = createAnalyticsQueryApplication({
      siteId,
      store: countingStore,
      reportingTimeZone: timeZone,
      now: () => "2026-07-03T00:00:00.000Z",
      authorize: async (_actor, capability) => {
        authorized.push(capability);
      },
    });

    await cached.queries.overview({ actor, range: july });
    const readsAfterFirst = reads;
    await cached.queries.overview({ actor, range: july });

    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterFirst);
  });

  it("keeps an answer across the applications a request handler builds", async () => {
    facts = [fact({ metricKey: "web.page_views", value: 40 })];
    let reads = 0;
    const countingStore: AnalyticsReadStore = {
      ...store,
      async listFacts(query) {
        reads += 1;
        return store.listFacts(query);
      },
    };
    // `/dash` is dynamic, so it builds a fresh application per request. The
    // cache belongs to the process, so it has to outlive them.
    const shared = createAnalyticsQueryCache();
    const perRequest = () =>
      createAnalyticsQueryApplication({
        siteId,
        store: countingStore,
        reportingTimeZone: timeZone,
        now: () => "2026-07-03T00:00:00.000Z",
        cache: shared,
        authorize: async (_actor, capability) => {
          authorized.push(capability);
        },
      });

    await perRequest().queries.overview({ actor, range: july });
    const readsAfterFirstRequest = reads;
    await perRequest().queries.overview({ actor, range: july });

    expect(readsAfterFirstRequest).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterFirstRequest);
  });

  it("gives an application its own cache when none is passed in", async () => {
    facts = [fact({ metricKey: "web.page_views", value: 40 })];
    let reads = 0;
    const countingStore: AnalyticsReadStore = {
      ...store,
      async listFacts(query) {
        reads += 1;
        return store.listFacts(query);
      },
    };
    const perRequest = () =>
      createAnalyticsQueryApplication({
        siteId,
        store: countingStore,
        reportingTimeZone: timeZone,
        now: () => "2026-07-03T00:00:00.000Z",
        authorize: async () => undefined,
      });

    await perRequest().queries.overview({ actor, range: july });
    const readsAfterFirstRequest = reads;
    await perRequest().queries.overview({ actor, range: july });

    expect(reads).toBeGreaterThan(readsAfterFirstRequest);
  });

  it("checks the capability on every call, cached or not", async () => {
    const application_ = application();

    await application_.queries.overview({ actor, range: july });
    await application_.queries.overview({ actor, range: july });

    expect(authorized.filter((entry) => entry === "analytics.read")).toHaveLength(
      2,
    );
  });

  it("refuses a caller without the capability before reading the cache", async () => {
    facts = [fact({ metricKey: "web.page_views", value: 40 })];
    let allow = true;
    const guarded = createAnalyticsQueryApplication({
      siteId,
      store,
      reportingTimeZone: timeZone,
      now: () => "2026-07-03T00:00:00.000Z",
      authorize: async () => {
        if (!allow) throw new Error("not_permitted");
      },
    });

    await guarded.queries.overview({ actor, range: july });
    allow = false;

    await expect(
      guarded.queries.overview({ actor, range: july }),
    ).rejects.toThrow("not_permitted");
  });

  it("does not serve one range's answer for another", async () => {
    facts = [fact({ metricKey: "web.page_views", value: 40 })];
    const application_ = application();

    const first = await application_.queries.overview({ actor, range: july });
    const second = await application_.queries.overview({
      actor,
      range: { fromLocalDate: "2026-06-01", toLocalDate: "2026-06-01" },
    });

    expect(first.range.startUtc).not.toBe(second.range.startUtc);
  });
});

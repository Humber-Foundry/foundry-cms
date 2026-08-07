import { describe, expect, it } from "vitest";

import {
  analyticsMetricDefinition,
  analyticsMetricKeys,
  analyticsSchemaVersion,
  analyticsSmallCellThreshold,
  AnalyticsComparabilityError,
  AnalyticsPrivacyViolationError,
  AnalyticsVocabularyError,
  assertAggregateAnalyticsPayload,
  comparabilitySignature,
  emptyDimension,
  isAllowedAnalyticsDimension,
  presentSecondaryCell,
  readingFreshness,
  summableSeries,
  unavailableValue,
} from "./analytics-model";

const observedAt = "2026-08-01T00:10:00.000Z";

function reading(
  overrides: Partial<Parameters<typeof comparabilitySignature>[0]> = {},
) {
  return {
    metricKey: "campaign.delivered" as const,
    definitionVersion: 1,
    source: "provider" as const,
    sourceName: "brevo",
    sourceMetric: "delivered",
    ...overrides,
  };
}

describe("canonical analytics vocabulary", () => {
  it("pins the schema version the projection and dashboard share", () => {
    expect(analyticsSchemaVersion).toBe("foundry.analytics.v1");
  });

  it("declares every canonical metric with its source and unit", () => {
    const pageViews = analyticsMetricDefinition("web.page_views");

    expect(pageViews.source).toBe("cloudflare_web");
    expect(pageViews.unit).toBe("count");
    expect(pageViews.defaultQuality).toBe("estimated");
    expect(pageViews.subjectTypes).toContain("site");
  });

  it("keeps provider-reported engagement below operational outcomes", () => {
    expect(
      analyticsMetricDefinition("campaign.unique_opens_reported"),
    ).toMatchObject({ defaultQuality: "unreliable", prominence: "collapsed" });
    expect(
      analyticsMetricDefinition("campaign.unique_clicks_reported"),
    ).toMatchObject({
      defaultQuality: "directional",
      prominence: "secondary",
    });
    expect(analyticsMetricDefinition("campaign.delivered")).toMatchObject({
      defaultQuality: "provider_reported",
      prominence: "primary",
    });
  });

  it("measures Web Vitals in milliseconds and score", () => {
    expect(analyticsMetricDefinition("web.vitals.lcp_p75").unit).toBe(
      "milliseconds",
    );
    expect(analyticsMetricDefinition("web.vitals.cls_p75").unit).toBe("score");
  });

  it("refuses a metric key outside the canonical vocabulary", () => {
    expect(() => analyticsMetricDefinition("web.unique_visitors")).toThrow(
      AnalyticsVocabularyError,
    );
  });

  it("exposes every registered key for schema seeding", () => {
    expect(analyticsMetricKeys).toContain("form.submissions_accepted");
    expect(analyticsMetricKeys).not.toContain("web.unique_visitors");
    expect(new Set(analyticsMetricKeys).size).toBe(
      analyticsMetricKeys.length,
    );
  });
});

describe("prohibited analytics fields", () => {
  it("accepts an aggregate fact carrying only product identifiers", () => {
    expect(() =>
      assertAggregateAnalyticsPayload({
        metricKey: "content.page_views",
        subjectType: "content",
        subjectId: "content_home",
        dimensionKey: "referrer_host",
        dimensionValue: "example.com",
        value: 12,
        sourceName: "cloudflare",
      }),
    ).not.toThrow();
  });

  it.each([
    ["visitorId", { visitorId: "v1" }],
    ["sessionId", { sessionId: "s1" }],
    ["requestId", { requestId: "r1" }],
    ["subscriberId", { subscriberId: "sub_1" }],
    ["contactId", { contactId: "c1" }],
    ["providerMessageId", { providerMessageId: "m1" }],
    ["recipient", { recipient: "someone" }],
    ["respondentName", { respondentName: "someone" }],
    ["email", { email: "person@example.com" }],
    ["emailHash", { emailHash: "abc" }],
    ["ipAddress", { ipAddress: "198.51.100.4" }],
    ["userAgent", { userAgent: "Mozilla/5.0" }],
    ["latitude", { latitude: 48.4 }],
    ["referrerPath", { referrerPath: "/pricing" }],
    ["queryString", { queryString: "utm_source=x" }],
    ["properties", { properties: { anything: true } }],
    ["rawEvent", { rawEvent: {} }],
    ["sessionReplayUrl", { sessionReplayUrl: "https://replay" }],
  ])("rejects a payload carrying %s", (field, payload) => {
    expect(() => assertAggregateAnalyticsPayload(payload)).toThrow(
      AnalyticsPrivacyViolationError,
    );
    try {
      assertAggregateAnalyticsPayload(payload);
    } catch (error) {
      expect((error as AnalyticsPrivacyViolationError).field).toBe(field);
    }
  });

  it("rejects a personal value under a field name that is not prohibited", () => {
    expect(() =>
      assertAggregateAnalyticsPayload({ label: "person@example.com" }),
    ).toThrow(AnalyticsPrivacyViolationError);
    expect(() =>
      assertAggregateAnalyticsPayload({ label: "198.51.100.4" }),
    ).toThrow(AnalyticsPrivacyViolationError);
    expect(() =>
      assertAggregateAnalyticsPayload({
        label: "https://example.com/pricing?utm_source=news",
      }),
    ).toThrow(AnalyticsPrivacyViolationError);
  });

  it("walks nested structures and arrays", () => {
    expect(() =>
      assertAggregateAnalyticsPayload({
        facts: [{ subjectId: "form_contact" }, { ip: "203.0.113.9" }],
      }),
    ).toThrow(AnalyticsPrivacyViolationError);
  });

  it("names the path of the offending field", () => {
    try {
      assertAggregateAnalyticsPayload({ facts: [{ visitorId: "v" }] });
      expect.unreachable("the payload should be rejected");
    } catch (error) {
      expect((error as AnalyticsPrivacyViolationError).path).toBe(
        "facts[0].visitorId",
      );
    }
  });
});

describe("dimension allowlist", () => {
  it("treats the empty sentinel as the ordinary site total", () => {
    expect(emptyDimension).toEqual({ key: "", value: "" });
    expect(isAllowedAnalyticsDimension(emptyDimension)).toBe(true);
  });

  it("allows only normalized referrer dimensions in v1", () => {
    expect(
      isAllowedAnalyticsDimension({ key: "referrer_host", value: "example.com" }),
    ).toBe(true);
    expect(
      isAllowedAnalyticsDimension({ key: "referrer_channel", value: "search" }),
    ).toBe(true);
    expect(
      isAllowedAnalyticsDimension({ key: "country", value: "CA" }),
    ).toBe(false);
    expect(
      isAllowedAnalyticsDimension({ key: "utm_source", value: "news" }),
    ).toBe(false);
  });

  it("rejects an allowlisted key carrying an unbounded value", () => {
    expect(
      isAllowedAnalyticsDimension({
        key: "referrer_host",
        value: "example.com/pricing?utm_source=news",
      }),
    ).toBe(false);
  });
});

describe("small-cell suppression", () => {
  it("suppresses a secondary dimension row below the threshold", () => {
    expect(analyticsSmallCellThreshold).toBe(5);
    expect(presentSecondaryCell(4)).toEqual({
      state: "suppressed",
      label: "fewer than 5",
    });
  });

  it("reports a row at or above the threshold exactly", () => {
    expect(presentSecondaryCell(5)).toEqual({ state: "available", value: 5 });
  });

  it("keeps an absent measurement unavailable", () => {
    expect(presentSecondaryCell(null)).toEqual({
      state: "unavailable",
      reason: "not_measured",
    });
    expect(unavailableValue("provider_omitted")).toEqual({
      state: "unavailable",
      reason: "provider_omitted",
    });
  });

  it("never rewrites a measured zero as suppressed", () => {
    expect(presentSecondaryCell(0)).toEqual({ state: "available", value: 0 });
  });
});

describe("comparability", () => {
  it("builds the comparability signature from every defining field", () => {
    expect(comparabilitySignature(reading())).toBe(
      "campaign.delivered|provider|brevo|delivered|1",
    );
  });

  it("sums a series that shares one definition", () => {
    expect(
      summableSeries([
        { ...reading(), value: 3 },
        { ...reading(), value: 4 },
      ]),
    ).toBe(7);
  });

  it("refuses to add two providers' differently defined measurements", () => {
    expect(() =>
      summableSeries([
        { ...reading(), value: 3 },
        { ...reading({ sourceName: "postmark" }), value: 4 },
      ]),
    ).toThrow(AnalyticsComparabilityError);
  });

  it("refuses to add across a definition version change", () => {
    expect(() =>
      summableSeries([
        { ...reading(), value: 3 },
        { ...reading({ definitionVersion: 2 }), value: 4 },
      ]),
    ).toThrow(AnalyticsComparabilityError);
  });

  it("reports an empty selection as absent", () => {
    expect(summableSeries([])).toBeNull();
  });

  it("refuses to add a D1 count to a provider-reported count", () => {
    expect(() =>
      summableSeries([
        { ...reading(), value: 3 },
        {
          ...reading({
            metricKey: "subscriber.unsubscribed",
            source: "d1",
            sourceName: "foundry",
            sourceMetric: "suppression_unsubscribed",
          }),
          value: 4,
        },
      ]),
    ).toThrow(AnalyticsComparabilityError);
  });
});

describe("freshness", () => {
  it("marks a bucket still accumulating as in progress", () => {
    expect(
      readingFreshness({
        completeThrough: "2026-08-01T00:00:00.000Z",
        bucketEndUtc: "2026-08-02T00:00:00.000Z",
        observedAt,
        now: "2026-08-01T00:15:00.000Z",
        expectedLagSeconds: 3_600,
      }),
    ).toBe("in_progress");
  });

  it("marks a closed and fully observed bucket fresh", () => {
    expect(
      readingFreshness({
        completeThrough: "2026-08-02T00:00:00.000Z",
        bucketEndUtc: "2026-08-02T00:00:00.000Z",
        observedAt: "2026-08-02T00:20:00.000Z",
        now: "2026-08-02T00:30:00.000Z",
        expectedLagSeconds: 3_600,
      }),
    ).toBe("fresh");
  });

  it("marks a source delayed once its expected reporting lag has elapsed", () => {
    expect(
      readingFreshness({
        completeThrough: "2026-08-02T00:00:00.000Z",
        bucketEndUtc: "2026-08-02T00:00:00.000Z",
        observedAt: "2026-08-02T00:20:00.000Z",
        now: "2026-08-02T03:00:00.000Z",
        expectedLagSeconds: 3_600,
      }),
    ).toBe("delayed");
  });

  it("marks a long-unobserved source stale", () => {
    expect(
      readingFreshness({
        completeThrough: "2026-08-02T00:00:00.000Z",
        bucketEndUtc: "2026-08-02T00:00:00.000Z",
        observedAt: "2026-08-02T00:20:00.000Z",
        now: "2026-08-05T00:00:00.000Z",
        expectedLagSeconds: 3_600,
      }),
    ).toBe("stale");
  });
});

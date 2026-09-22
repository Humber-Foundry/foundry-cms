import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { campaignAnalyticsMeasurements } from "@humber-foundry/application";

import {
  AnalyticsEngineSourceError,
  interactionRollupSql,
  normalizeAnalyticsEngineRows,
  normalizeWebTrafficRows,
  queryAnalyticsEngine,
  webTrafficRollupSql,
} from "./analytics-engine-source";
import {
  brevoAnalyticsCapabilities,
  brevoCampaignSnapshot,
  createBrevoCampaignAnalyticsAdapter,
} from "./brevo-campaign-analytics-adapter";

describe("Analytics Engine rollups", () => {
  const row = {
    bucket_start: "2026-08-01",
    event_kind: "form_impression",
    subject_id: "form_contact",
    weighted_count: 240,
    sample_interval: 10,
  };

  it("weights a sampled interaction and keeps it best effort", () => {
    expect(normalizeAnalyticsEngineRows([row])).toEqual([
      {
        metricKey: "interaction.form_impressions",
        bucketStartUtc: "2026-08-01T00:00:00.000Z",
        bucketEndUtc: "2026-08-02T00:00:00.000Z",
        granularity: "day",
        subjectType: "form",
        subjectId: "form_contact",
        dimension: { key: "", value: "" },
        unit: "count",
        quality: "best_effort",
        sampleInterval: 10,
        value: 240,
        unavailableReason: null,
      },
    ]);
  });

  it("maps a call-to-action activation to its own subject type", () => {
    expect(
      normalizeAnalyticsEngineRows([
        { ...row, event_kind: "cta_activation", subject_id: "cta_book" },
      ])[0],
    ).toMatchObject({
      metricKey: "interaction.cta_activations",
      subjectType: "cta",
    });
  });

  it("refuses an event kind nobody declared", () => {
    expect(() =>
      normalizeAnalyticsEngineRows([{ ...row, event_kind: "page_scroll" }]),
    ).toThrow(AnalyticsEngineSourceError);
  });

  it("refuses a subject that is not a public CMS identifier", () => {
    expect(() =>
      normalizeAnalyticsEngineRows([
        { ...row, subject_id: "person@example.com" },
      ]),
    ).toThrow(AnalyticsEngineSourceError);
  });

  it("reports an hour bucket when asked for one", () => {
    expect(
      normalizeAnalyticsEngineRows(
        [{ ...row, bucket_start: "2026-08-01 13:00:00" }],
        "hour",
      )[0],
    ).toMatchObject({
      bucketStartUtc: "2026-08-01T13:00:00.000Z",
      bucketEndUtc: "2026-08-01T14:00:00.000Z",
      granularity: "hour",
    });
  });

  it("refuses a day bucket where an hour bucket was asked for", () => {
    expect(() =>
      normalizeAnalyticsEngineRows([row], "hour"),
    ).toThrow(AnalyticsEngineSourceError);
  });

  it("groups by the hour when the hourly statement is built", () => {
    const sql = interactionRollupSql({
      dataset: "foundry_interactions",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-02T00:00:00.000Z",
      granularity: "hour",
    });

    expect(sql).toMatch(/toStartOfHour\(timestamp\)/u);
    expect(sql).toMatch(/GROUP BY bucket_start, event_kind, subject_id/u);
  });

  it("selects only the two blobs the collector writes", () => {
    const sql = interactionRollupSql({
      dataset: "foundry_interactions",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-02T00:00:00.000Z",
    });

    expect(sql).toMatch(/blob1 AS event_kind/u);
    expect(sql).toMatch(/blob2 AS subject_id/u);
    expect(sql).not.toMatch(/blob3|index1|\*/u);
    expect(sql).toMatch(/SUM\(_sample_interval\)/u);
  });

  it("refuses to build a statement from an unvalidated instant", () => {
    expect(() =>
      interactionRollupSql({
        dataset: "foundry_interactions",
        since: "2026-08-01' OR '1'='1",
        until: "2026-08-02T00:00:00.000Z",
      }),
    ).toThrow(AnalyticsEngineSourceError);
  });

  it("refuses to build a statement from an unvalidated dataset name", () => {
    expect(() =>
      interactionRollupSql({
        dataset: "foundry; DROP TABLE analytics_facts",
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-02T00:00:00.000Z",
      }),
    ).toThrow(AnalyticsEngineSourceError);
  });

  it("reports an unavailable query as a failure", async () => {
    const fetchImplementation = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;

    await expect(
      queryAnalyticsEngine({
        accountId: "account",
        apiToken: "token",
        dataset: "foundry_interactions",
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-02T00:00:00.000Z",
        fetchImplementation,
      }),
    ).rejects.toThrow(AnalyticsEngineSourceError);
  });
});

describe("the web traffic rollup", () => {
  const siteId = "site_reference";

  const row = {
    bucket_start: "2026-08-01",
    content_id: "page_about",
    referrer_key: "referrer_host",
    referrer_value: "partner.example.com",
    weighted_page_views: 40,
    weighted_visits: 25,
    sample_interval: 1,
  };

  function measurementsFor(
    rows: ReadonlyArray<Record<string, unknown>>,
  ) {
    return normalizeWebTrafficRows({
      rows: rows as Parameters<typeof normalizeWebTrafficRows>[0]["rows"],
      granularity: "day",
      siteId,
    });
  }

  it("reads only the page view columns the Worker writes", () => {
    const sql = webTrafficRollupSql({
      dataset: "foundry_reference_interactions",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-08T00:00:00.000Z",
    });

    expect(sql).toContain("blob1 = 'page_view'");
    expect(sql).toContain("SUM(double1 * _sample_interval)");
    expect(sql).toContain("SUM(double2 * _sample_interval)");
    expect(sql).not.toMatch(/blob[5-9]/u);
  });

  it("keeps a page view point out of the interaction rollup", () => {
    const sql = interactionRollupSql({
      dataset: "foundry_reference_interactions",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-08T00:00:00.000Z",
    });

    expect(sql).toContain("blob1 IN ('form_impression', 'cta_activation')");
  });

  it("reports page views, arrivals, the page and the referrer", () => {
    const measurements = measurementsFor([row]);

    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "web.page_views" && entry.dimension.key === "",
      ),
    ).toMatchObject({ subjectType: "site", subjectId: siteId, value: 40 });
    expect(
      measurements.find((entry) => entry.metricKey === "web.visits"),
    ).toMatchObject({ value: 25 });
    expect(
      measurements.find((entry) => entry.metricKey === "content.page_views"),
    ).toMatchObject({ subjectType: "content", subjectId: "page_about", value: 40 });
    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "web.page_views" &&
          entry.dimension.key === "referrer_host",
      ),
    ).toMatchObject({ dimension: { key: "referrer_host", value: "partner.example.com" }, value: 40 });
  });

  it("adds the days it is given and weights a sampled row", () => {
    const measurements = measurementsFor([
      { ...row, weighted_page_views: 400, sample_interval: 10 },
      {
        ...row,
        referrer_key: "referrer_channel",
        referrer_value: "direct",
        weighted_page_views: 100,
        weighted_visits: 100,
        sample_interval: 10,
      },
    ]);

    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "web.page_views" && entry.dimension.key === "",
      ),
    ).toMatchObject({ value: 500, sampleInterval: 10 });
  });

  it("leaves a page it does not own out of the per-page rows", () => {
    const measurements = measurementsFor([{ ...row, content_id: "" }]);

    expect(
      measurements.some((entry) => entry.metricKey === "content.page_views"),
    ).toBe(false);
    expect(
      measurements.find(
        (entry) =>
          entry.metricKey === "web.page_views" && entry.dimension.key === "",
      )?.value,
    ).toBe(40);
  });

  it("counts a move inside the site as a page view with no referrer row", () => {
    const measurements = measurementsFor([
      { ...row, referrer_key: "", referrer_value: "", weighted_visits: 0 },
    ]);

    expect(
      measurements.every((entry) => entry.dimension.key === ""),
    ).toBe(true);
    expect(
      measurements.find((entry) => entry.metricKey === "web.visits")?.value,
    ).toBe(0);
  });

  it("refuses a referrer that is not a bare host or a known channel", () => {
    expect(() =>
      measurementsFor([
        { ...row, referrer_value: "https://partner.example.com/page?a=b" },
      ]),
    ).toThrow(AnalyticsEngineSourceError);
  });

  it("refuses a page id that is not a public id", () => {
    expect(() =>
      measurementsFor([{ ...row, content_id: "someone@example.com" }]),
    ).toThrow(AnalyticsEngineSourceError);
  });

  it("refuses a count that is not a whole, non-negative reading", () => {
    expect(() =>
      measurementsFor([{ ...row, weighted_page_views: -1 }]),
    ).toThrow(AnalyticsEngineSourceError);
    expect(() =>
      measurementsFor([{ ...row, sample_interval: 0 }]),
    ).toThrow(AnalyticsEngineSourceError);
  });
});

describe("the Brevo campaign analytics adapter", () => {
  const report = {
    id: 9931,
    sentDate: "2026-07-01T16:00:00.000Z",
    modifiedAt: "2026-07-02T08:00:00.000Z",
    statistics: {
      globalStats: {
        sent: 500,
        delivered: 480,
        softBounces: 8,
        hardBounces: 12,
        complaints: 1,
        unsubscriptions: 4,
        uniqueClicks: 63,
        uniqueViews: 210,
      },
    },
  };

  it("declares how each provider metric is counted", () => {
    expect(
      brevoAnalyticsCapabilities.metrics["campaign.unique_opens_reported"],
    ).toMatchObject({
      countingMode: "inferred",
      privacyProxyFiltering: "selectable",
      providerMetric: "uniqueViews",
    });
    expect(
      brevoAnalyticsCapabilities.metrics["campaign.delivered"],
    ).toMatchObject({ countingMode: "total", providerMetric: "delivered" });
  });

  it("maps a report onto the Foundry campaign identity", () => {
    const snapshot = brevoCampaignSnapshot({
      campaignId: "campaign_1",
      report,
      observedAt: "2026-07-02T09:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      campaignId: "campaign_1",
      providerCampaignId: "9931",
      sentAt: "2026-07-01T16:00:00.000Z",
    });
    expect(snapshot.metrics["campaign.delivered"]).toEqual({
      state: "available",
      value: 480,
    });
  });

  it("reports a statistic the provider omitted as unavailable", () => {
    const snapshot = brevoCampaignSnapshot({
      campaignId: "campaign_1",
      report: {
        ...report,
        statistics: { globalStats: { delivered: 480 } },
      },
      observedAt: "2026-07-02T09:00:00.000Z",
    });

    expect(snapshot.metrics["campaign.unique_clicks_reported"]).toEqual({
      state: "unavailable",
      reason: "provider_omitted",
    });
  });

  it("produces measurements the projection accepts", () => {
    const measurements = campaignAnalyticsMeasurements({
      snapshot: brevoCampaignSnapshot({
        campaignId: "campaign_1",
        report,
        observedAt: "2026-07-02T09:00:00.000Z",
      }),
      capabilities: brevoAnalyticsCapabilities,
    });

    expect(
      measurements.find((entry) => entry.metricKey === "campaign.delivered"),
    ).toMatchObject({ value: 480, granularity: "campaign" });
    expect(measurements).toHaveLength(8);
  });

  it("reports a quota response as source degradation with a retry time", async () => {
    const fetchImplementation = (async () =>
      new Response("", {
        status: 429,
        headers: { "retry-after": "120" },
      })) as unknown as typeof fetch;
    const adapter = createBrevoCampaignAnalyticsAdapter({
      apiKey: "key",
      campaignIdForProviderCampaign: () => "campaign_1",
      fetchImplementation,
      now: () => "2026-07-02T09:00:00.000Z",
    });

    await expect(
      adapter.getCampaignAnalytics({
        campaignId: "campaign_1",
        providerCampaignId: "9931",
      }),
    ).rejects.toThrow();
    expect(await adapter.getAnalyticsHealth()).toMatchObject({
      status: "unavailable",
      errorCode: "quota_exceeded",
      nextRetryAt: "2026-07-02T09:02:00.000Z",
    });
  });

  it("keeps adversarial provider identifiers on the fixed Brevo endpoint", async () => {
    const requests: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(report), { status: 200 });
    });
    const adapter = createBrevoCampaignAnalyticsAdapter({
      apiKey: "key",
      campaignIdForProviderCampaign: () => "campaign_1",
      fetchImplementation,
      now: () => "2026-07-02T09:00:00.000Z",
    });
    const adversarial =
      "http://169.254.169.254/latest/meta-data/?token=${env.PROVIDER_KEY}";

    await adapter.getCampaignAnalytics({
      campaignId: "campaign_1",
      providerCampaignId: adversarial,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const outgoing = new URL(requests[0]!);
    expect(outgoing.origin).toBe("https://api.brevo.com");
    expect(outgoing.pathname).toBe(
      `/v3/emailCampaigns/${encodeURIComponent(adversarial)}`,
    );
    expect(outgoing.search).toBe("?statistics=globalStats");
  });

  it("ignores a provider campaign Foundry does not own", async () => {
    const fetchImplementation = (async () =>
      new Response(JSON.stringify({ campaigns: [report], count: 1 }), {
        status: 200,
      })) as unknown as typeof fetch;
    const adapter = createBrevoCampaignAnalyticsAdapter({
      apiKey: "key",
      campaignIdForProviderCampaign: () => null,
      fetchImplementation,
      now: () => "2026-07-02T09:00:00.000Z",
    });

    expect(
      await adapter.listChangedCampaignAnalytics({
        cursor: null,
        since: "2026-07-01T00:00:00.000Z",
      }),
    ).toEqual({ snapshots: [], nextCursor: null });
  });
});

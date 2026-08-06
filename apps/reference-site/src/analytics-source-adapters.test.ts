import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { campaignAnalyticsMeasurements } from "@foundry/application";

import {
  AnalyticsEngineSourceError,
  interactionRollupSql,
  normalizeAnalyticsEngineRows,
  queryAnalyticsEngine,
} from "./analytics-engine-source";
import {
  brevoAnalyticsCapabilities,
  brevoCampaignSnapshot,
  createBrevoCampaignAnalyticsAdapter,
} from "./brevo-campaign-analytics-adapter";

describe("Analytics Engine rollups", () => {
  const row = {
    day: "2026-08-01",
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

  it("treats an unavailable query as a failure, not as no interactions", async () => {
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

describe("the Brevo analytics boundary", () => {
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

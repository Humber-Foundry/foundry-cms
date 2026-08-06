import { describe, expect, it } from "vitest";

import { AnalyticsPrivacyViolationError } from "./analytics-model";
import {
  AnalyticsProviderContractError,
  campaignAnalyticsMeasurements,
  type AnalyticsCapabilities,
  type CampaignAnalyticsSnapshot,
} from "./analytics-provider";

function capability(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    providerMetric: "delivered",
    definition: "The receiving server accepted the message.",
    definitionVersion: 1,
    countingMode: "total" as const,
    denominator: null,
    botFiltering: "unavailable" as const,
    privacyProxyFiltering: "unavailable" as const,
    expectedLagSeconds: 3_600,
    mutableForSeconds: 259_200,
    ...overrides,
  };
}

const capabilities: AnalyticsCapabilities = {
  providerName: "brevo",
  metrics: {
    "campaign.delivered": capability(),
    "campaign.unique_clicks_reported": capability({
      providerMetric: "uniqueClicks",
      countingMode: "unique",
      botFiltering: "selectable",
    }),
    "campaign.unique_opens_reported": capability({
      supported: false,
      providerMetric: "uniqueOpens",
      countingMode: "inferred",
    }),
  },
};

const snapshot: CampaignAnalyticsSnapshot = {
  campaignId: "campaign_1",
  providerCampaignId: "9931",
  observedAt: "2026-07-02T09:00:00.000Z",
  completeThrough: "2026-07-02T08:00:00.000Z",
  providerRevision: 3,
  sentAt: "2026-07-01T16:00:00.000Z",
  metrics: {
    "campaign.delivered": { state: "available", value: 480 },
    "campaign.unique_clicks_reported": {
      state: "unavailable",
      reason: "provider_omitted",
    },
  },
};

describe("normalizing a provider snapshot", () => {
  it("maps a supported metric to a campaign-bucketed measurement", () => {
    const measurements = campaignAnalyticsMeasurements({
      snapshot,
      capabilities,
    });

    expect(
      measurements.find(
        (entry) => entry.metricKey === "campaign.delivered",
      ),
    ).toMatchObject({
      subjectType: "campaign",
      subjectId: "campaign_1",
      granularity: "campaign",
      bucketStartUtc: "2026-07-01T16:00:00.000Z",
      quality: "provider_reported",
      value: 480,
      unavailableReason: null,
    });
  });

  it("reports an unsupported metric as unavailable rather than absent", () => {
    const measurements = campaignAnalyticsMeasurements({
      snapshot,
      capabilities,
    });

    expect(
      measurements.find(
        (entry) => entry.metricKey === "campaign.unique_opens_reported",
      ),
    ).toMatchObject({ value: null, unavailableReason: "not_supported" });
  });

  it("keeps an omitted metric's own reason", () => {
    const measurements = campaignAnalyticsMeasurements({
      snapshot,
      capabilities,
    });

    expect(
      measurements.find(
        (entry) => entry.metricKey === "campaign.unique_clicks_reported",
      ),
    ).toMatchObject({ value: null, unavailableReason: "provider_omitted" });
  });

  it("refuses a snapshot carrying recipient data", () => {
    expect(() =>
      campaignAnalyticsMeasurements({
        snapshot: {
          ...snapshot,
          ...{ recipients: ["person@example.com"] },
        } as CampaignAnalyticsSnapshot,
        capabilities,
      }),
    ).toThrow(AnalyticsPrivacyViolationError);
  });

  it("refuses a metric the adapter never declared", () => {
    expect(() =>
      campaignAnalyticsMeasurements({
        snapshot: {
          ...snapshot,
          metrics: {
            ...snapshot.metrics,
            "campaign.sent": { state: "available", value: 500 },
          },
        },
        capabilities,
      }),
    ).toThrow(AnalyticsProviderContractError);
  });

  it("refuses a value for a metric the provider declared unsupported", () => {
    expect(() =>
      campaignAnalyticsMeasurements({
        snapshot: {
          ...snapshot,
          metrics: {
            ...snapshot.metrics,
            "campaign.unique_opens_reported": {
              state: "available",
              value: 210,
            },
          },
        },
        capabilities,
      }),
    ).toThrow(AnalyticsProviderContractError);
  });

  it("refuses a snapshot whose completeness precedes its send", () => {
    expect(() =>
      campaignAnalyticsMeasurements({
        snapshot: { ...snapshot, completeThrough: "2026-07-01T15:00:00.000Z" },
        capabilities,
      }),
    ).toThrow(AnalyticsProviderContractError);
  });
});

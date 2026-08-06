/**
 * The provider-neutral analytics boundary for newsletter delivery.
 *
 * Delivery adapters already carry person-level data for compliance work. This
 * boundary is deliberately separate: an analytics snapshot declares what each
 * provider metric means, and it may not carry an address, contact, message or
 * raw event. Leakage is refused here rather than filtered downstream.
 */

import {
  analyticsMetricDefinition,
  assertAggregateAnalyticsPayload,
  type AnalyticsMetricKey,
  type AnalyticsQuality,
  type AnalyticsSourceStatus,
  type AnalyticsUnavailableReason,
} from "./analytics-model";
import type { AnalyticsFactMeasurement } from "./analytics-projection";

export type ProviderCountingMode = "total" | "unique" | "inferred";

export type ProviderFiltering =
  | "unavailable"
  | "included"
  | "excluded"
  | "selectable";

export type ProviderMetricCapability = Readonly<{
  supported: boolean;
  providerMetric: string;
  definition: string;
  definitionVersion: number;
  countingMode: ProviderCountingMode;
  denominator: string | null;
  botFiltering: ProviderFiltering;
  privacyProxyFiltering: ProviderFiltering;
  expectedLagSeconds: number;
  mutableForSeconds: number;
}>;

export type AnalyticsCapabilities = Readonly<{
  providerName: string;
  metrics: Readonly<Partial<Record<AnalyticsMetricKey, ProviderMetricCapability>>>;
}>;

export type CampaignAnalyticsSnapshot = Readonly<{
  /** The stable Foundry campaign identity, never a provider contact record. */
  campaignId: string;
  providerCampaignId: string;
  observedAt: string;
  completeThrough: string;
  providerRevision: number;
  sentAt: string;
  metrics: Readonly<
    Partial<
      Record<
        AnalyticsMetricKey,
        | Readonly<{ state: "available"; value: number }>
        | Readonly<{
            state: "unavailable";
            reason: AnalyticsUnavailableReason;
          }>
      >
    >
  >;
}>;

export type ProviderAnalyticsHealth = Readonly<{
  status: AnalyticsSourceStatus;
  errorCode: string | null;
  nextRetryAt: string | null;
  observedAt: string;
}>;

export interface NewsletterAnalyticsAdapter {
  getAnalyticsCapabilities(): Promise<AnalyticsCapabilities>;
  getCampaignAnalytics(input: {
    campaignId: string;
    providerCampaignId: string;
    asOf?: string;
  }): Promise<CampaignAnalyticsSnapshot>;
  listChangedCampaignAnalytics(input: {
    cursor: string | null;
    since: string;
  }): Promise<
    Readonly<{
      snapshots: ReadonlyArray<CampaignAnalyticsSnapshot>;
      nextCursor: string | null;
    }>
  >;
  getAnalyticsHealth(): Promise<ProviderAnalyticsHealth>;
}

export class AnalyticsProviderContractError extends Error {
  readonly code:
    | "metric_not_declared"
    | "unsupported_metric_reported"
    | "campaign_bucket_invalid";
  readonly metricKey: string | null;

  constructor(
    code: AnalyticsProviderContractError["code"],
    metricKey: string | null = null,
  ) {
    super(
      `The provider analytics snapshot was refused: ${code}${
        metricKey === null ? "" : ` (${metricKey})`
      }.`,
    );
    this.name = "AnalyticsProviderContractError";
    this.code = code;
    this.metricKey = metricKey;
  }
}

/**
 * Turns one provider snapshot into canonical measurements.
 *
 * A metric the provider does not support becomes an explicit `unavailable`
 * measurement so the dashboard can say so, rather than an absent row that
 * would read as a zero once totals are summed.
 */
export function campaignAnalyticsMeasurements({
  snapshot,
  capabilities,
}: {
  snapshot: CampaignAnalyticsSnapshot;
  capabilities: AnalyticsCapabilities;
}): ReadonlyArray<AnalyticsFactMeasurement> {
  assertAggregateAnalyticsPayload(snapshot);

  if (Date.parse(snapshot.sentAt) >= Date.parse(snapshot.completeThrough)) {
    throw new AnalyticsProviderContractError("campaign_bucket_invalid");
  }

  const declared = Object.entries(capabilities.metrics) as ReadonlyArray<
    [AnalyticsMetricKey, ProviderMetricCapability]
  >;

  for (const metricKey of Object.keys(snapshot.metrics)) {
    if (!(metricKey in capabilities.metrics)) {
      throw new AnalyticsProviderContractError(
        "metric_not_declared",
        metricKey,
      );
    }
  }

  return declared.map(([metricKey, capability]) => {
    const definition = analyticsMetricDefinition(metricKey);
    const reported = snapshot.metrics[metricKey];
    if (!capability.supported && reported?.state === "available") {
      throw new AnalyticsProviderContractError(
        "unsupported_metric_reported",
        metricKey,
      );
    }
    const measured =
      capability.supported && reported?.state === "available"
        ? reported
        : null;
    return {
      metricKey,
      bucketStartUtc: snapshot.sentAt,
      bucketEndUtc: snapshot.completeThrough,
      granularity: "campaign" as const,
      subjectType: "campaign" as const,
      subjectId: snapshot.campaignId,
      dimension: { key: "", value: "" },
      unit: definition.unit,
      quality: definition.defaultQuality satisfies AnalyticsQuality,
      sampleInterval: 1,
      value: measured === null ? null : measured.value,
      unavailableReason:
        measured !== null
          ? null
          : !capability.supported
            ? "not_supported"
            : (reported?.state === "unavailable"
                ? reported.reason
                : "provider_omitted"),
    };
  });
}

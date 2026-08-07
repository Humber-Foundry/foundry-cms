import {
  assertAggregateAnalyticsPayload,
  type AnalyticsCapabilities,
  type CampaignAnalyticsSnapshot,
  type ProviderMetricCapability,
  type NewsletterAnalyticsAdapter,
  type ProviderAnalyticsHealth,
} from "@foundry/application";

/**
 * The Brevo analytics adapter. It reads aggregate campaign reports.
 *
 * Compliance webhooks take a separate path: subscriber-level webhook data
 * updates the operational ledger through its own adapter. Only the aggregate
 * reports read here become analytics facts.
 *
 * Contract: https://developers.brevo.com/reference/get-email-campaign
 */

export const brevoAnalyticsSourceName = "brevo";
export const brevoAnalyticsDefinitionVersion = 1;

const hourSeconds = 3_600;

/**
 * Builds one metric capability from Brevo's defaults. The provider's own
 * metric name and its plain-language meaning are required, so a metric cannot
 * ship with an empty definition beside its number on `/dash`.
 */
function capability(
  entry: Pick<ProviderMetricCapability, "providerMetric" | "definition"> &
    Partial<ProviderMetricCapability>,
): ProviderMetricCapability {
  return Object.freeze({
    supported: true,
    definitionVersion: brevoAnalyticsDefinitionVersion,
    countingMode: "total" as const,
    denominator: null,
    botFiltering: "unavailable" as const,
    privacyProxyFiltering: "unavailable" as const,
    expectedLagSeconds: hourSeconds,
    mutableForSeconds: 72 * hourSeconds,
    ...entry,
  });
}

export const brevoAnalyticsCapabilities: AnalyticsCapabilities = Object.freeze({
  providerName: brevoAnalyticsSourceName,
  metrics: Object.freeze({
    "campaign.sent": capability({
      providerMetric: "sent",
      definition: "Messages Brevo reports as sent for this campaign.",
    }),
    "campaign.delivered": capability({
      providerMetric: "delivered",
      definition:
        "The receiving server accepted the message. Not inbox placement.",
    }),
    "campaign.soft_bounced": capability({
      providerMetric: "softBounces",
      definition: "Temporary delivery failure. This value can still change.",
      mutableForSeconds: 30 * 24 * hourSeconds,
    }),
    "campaign.hard_bounced": capability({
      providerMetric: "hardBounces",
      definition: "Permanent delivery failure.",
    }),
    "campaign.complained": capability({
      providerMetric: "complaints",
      definition: "Recipient-reported spam complaints.",
    }),
    "campaign.unsubscribed": capability({
      providerMetric: "unsubscriptions",
      definition: "Unsubscribes Brevo attributes to this campaign.",
    }),
    "campaign.unique_clicks_reported": capability({
      providerMetric: "uniqueClicks",
      definition:
        "Unique clicks. Security scanners and link protection can inflate this.",
      countingMode: "unique",
      denominator: "delivered",
      botFiltering: "selectable",
    }),
    "campaign.unique_opens_reported": capability({
      providerMetric: "uniqueViews",
      definition:
        "Unique opens inferred from a remote image fetch. Apple Mail Privacy Protection can fetch it before anyone reads the message.",
      countingMode: "inferred",
      denominator: "delivered",
      botFiltering: "selectable",
      privacyProxyFiltering: "selectable",
      mutableForSeconds: 30 * 24 * hourSeconds,
    }),
  }),
});

export class BrevoAnalyticsError extends Error {
  readonly code: "request_failed" | "response_invalid" | "quota_exceeded";
  readonly nextRetryAt: string | null;

  constructor(
    code: BrevoAnalyticsError["code"],
    nextRetryAt: string | null = null,
  ) {
    super(`The Brevo analytics request was refused: ${code}.`);
    this.name = "BrevoAnalyticsError";
    this.code = code;
    this.nextRetryAt = nextRetryAt;
  }
}

type BrevoStatistics = Readonly<{
  sent?: number;
  delivered?: number;
  softBounces?: number;
  hardBounces?: number;
  complaints?: number;
  unsubscriptions?: number;
  uniqueClicks?: number;
  uniqueViews?: number;
}>;

type BrevoCampaignReport = Readonly<{
  id: number;
  sentDate?: string;
  modifiedAt?: string;
  statistics?: Readonly<{ globalStats?: BrevoStatistics }>;
}>;

function metricValue(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? ({ state: "available" as const, value })
    : ({ state: "unavailable" as const, reason: "provider_omitted" as const });
}

/**
 * Maps one Brevo report to a canonical snapshot. Only aggregate counts and the
 * metadata needed to interpret them are copied across. The campaign identity
 * is Foundry's, so replacing the provider leaves campaign history intact.
 */
export function brevoCampaignSnapshot({
  campaignId,
  report,
  observedAt,
}: {
  campaignId: string;
  report: BrevoCampaignReport;
  observedAt: string;
}): CampaignAnalyticsSnapshot {
  const statistics = report.statistics?.globalStats ?? {};
  const sentAt = report.sentDate;
  if (sentAt === undefined || Number.isNaN(Date.parse(sentAt))) {
    throw new BrevoAnalyticsError("response_invalid");
  }
  const snapshot: CampaignAnalyticsSnapshot = {
    campaignId,
    providerCampaignId: String(report.id),
    observedAt,
    completeThrough: observedAt,
    providerRevision: Date.parse(report.modifiedAt ?? observedAt),
    sentAt: new Date(Date.parse(sentAt)).toISOString(),
    metrics: {
      "campaign.sent": metricValue(statistics.sent),
      "campaign.delivered": metricValue(statistics.delivered),
      "campaign.soft_bounced": metricValue(statistics.softBounces),
      "campaign.hard_bounced": metricValue(statistics.hardBounces),
      "campaign.complained": metricValue(statistics.complaints),
      "campaign.unsubscribed": metricValue(statistics.unsubscriptions),
      "campaign.unique_clicks_reported": metricValue(statistics.uniqueClicks),
      "campaign.unique_opens_reported": metricValue(statistics.uniqueViews),
    },
  };
  // Check the snapshot here, where it is built. An adapter that starts
  // returning contact rows then throws at this line.
  assertAggregateAnalyticsPayload(snapshot);
  return snapshot;
}

export function createBrevoCampaignAnalyticsAdapter({
  apiKey,
  campaignIdForProviderCampaign,
  fetchImplementation = fetch,
  now = () => new Date().toISOString(),
}: {
  apiKey: string;
  campaignIdForProviderCampaign(providerCampaignId: string): string | null;
  fetchImplementation?: typeof fetch;
  now?: () => string;
}): NewsletterAnalyticsAdapter {
  let lastError: BrevoAnalyticsError | null = null;

  async function getReport(
    providerCampaignId: string,
  ): Promise<BrevoCampaignReport> {
    const response = await fetchImplementation(
      `https://api.brevo.com/v3/emailCampaigns/${encodeURIComponent(
        providerCampaignId,
      )}?statistics=globalStats`,
      { headers: { "api-key": apiKey, accept: "application/json" } },
    );
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "60");
      const failure = new BrevoAnalyticsError(
        "quota_exceeded",
        new Date(
          Date.parse(now()) +
            (Number.isFinite(retryAfter) ? retryAfter : 60) * 1_000,
        ).toISOString(),
      );
      lastError = failure;
      throw failure;
    }
    if (!response.ok) {
      lastError = new BrevoAnalyticsError("request_failed");
      throw lastError;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      lastError = new BrevoAnalyticsError("response_invalid");
      throw lastError;
    }
    lastError = null;
    return body as BrevoCampaignReport;
  }

  return {
    async getAnalyticsCapabilities() {
      return brevoAnalyticsCapabilities;
    },

    async getCampaignAnalytics({ campaignId, providerCampaignId, asOf }) {
      return brevoCampaignSnapshot({
        campaignId,
        report: await getReport(providerCampaignId),
        observedAt: asOf ?? now(),
      });
    },

    async listChangedCampaignAnalytics({ cursor, since }) {
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new BrevoAnalyticsError("request_failed");
      }
      const response = await fetchImplementation(
        `https://api.brevo.com/v3/emailCampaigns?statistics=globalStats&limit=50&offset=${offset}&startDate=${encodeURIComponent(
          since.slice(0, 10),
        )}`,
        { headers: { "api-key": apiKey, accept: "application/json" } },
      );
      if (!response.ok) {
        lastError = new BrevoAnalyticsError("request_failed");
        throw lastError;
      }
      const body = (await response.json()) as {
        campaigns?: ReadonlyArray<BrevoCampaignReport>;
        count?: number;
      };
      const campaigns = body.campaigns ?? [];
      const observedAt = now();
      const snapshots = campaigns.flatMap((report) => {
        const campaignId = campaignIdForProviderCampaign(String(report.id));
        // A provider campaign Foundry does not own is not analytics data.
        if (campaignId === null || report.sentDate === undefined) return [];
        return [brevoCampaignSnapshot({ campaignId, report, observedAt })];
      });
      lastError = null;
      return {
        snapshots,
        nextCursor:
          campaigns.length === 50 ? String(offset + campaigns.length) : null,
      };
    },

    async getAnalyticsHealth(): Promise<ProviderAnalyticsHealth> {
      return {
        status: lastError === null ? "healthy" : "unavailable",
        errorCode: lastError === null ? null : lastError.code,
        nextRetryAt: lastError?.nextRetryAt ?? null,
        observedAt: now(),
      };
    },
  };
}

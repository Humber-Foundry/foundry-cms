import "server-only";

import {
  campaignAnalyticsMeasurements,
  createAnalyticsProjection,
  type AnalyticsFactMeasurement,
  type AnalyticsSource,
  type AnalyticsSourceState,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import {
  analyticsEngineDefinitionVersion,
  analyticsEngineSourceName,
  normalizeAnalyticsEngineRows,
  queryAnalyticsEngine,
} from "./analytics-engine-source";
import {
  brevoAnalyticsCapabilities,
  brevoAnalyticsDefinitionVersion,
  brevoAnalyticsSourceName,
  createBrevoCampaignAnalyticsAdapter,
} from "./brevo-campaign-analytics-adapter";
import {
  cloudflareWebAnalyticsDefinitionVersion,
  cloudflareWebAnalyticsSourceName,
  fetchCloudflareWebAnalytics,
  normalizeCloudflareWebAnalytics,
  type PublishedRouteHistoryEntry,
} from "./cloudflare-web-analytics-source";
import { createD1AnalyticsStore } from "./d1-analytics-store";
import {
  createD1OperationalAnalyticsSource,
  operationalAnalyticsDefinitionVersion,
  operationalAnalyticsSourceName,
} from "./d1-operational-analytics-source";
import type { HumanAccessEnvironment } from "./human-access-configuration";

/**
 * The scheduled projector. Each source runs on its own cadence and reports its
 * own health, so one degraded source never blocks another and never advances
 * completeness it did not earn.
 */

export type AnalyticsProjectionEnvironment = HumanAccessEnvironment &
  Readonly<{
    FOUNDRY_CLOUDFLARE_WEB_ANALYTICS_SITE_TAG?: string;
    FOUNDRY_ANALYTICS_API_TOKEN?: string;
    FOUNDRY_ANALYTICS_ENGINE_DATASET?: string;
  }>;

/** D1 is local and cheap; external sources are polled far less often. */
const refreshIntervalSeconds: Readonly<Record<AnalyticsSource, number>> =
  Object.freeze({
    d1: 300,
    cloudflare_web: 21_600,
    analytics_engine: 21_600,
    provider: 3_600,
  });

/**
 * Web Analytics and Analytics Engine revise recent buckets as late data lands,
 * so every run re-reads the previous week rather than only the newest day.
 */
const externalRefreshDays = 7;
const hourlyRetentionDays = 90;

function utcDayStart(instant: string): string {
  return `${instant.slice(0, 10)}T00:00:00.000Z`;
}

function addDays(instant: string, days: number): string {
  return new Date(Date.parse(instant) + days * 86_400_000).toISOString();
}

function addSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1_000).toISOString();
}

/** Our own contract failures are bugs, not source outages. */
const contractErrorNames = new Set([
  "AnalyticsProjectionError",
  "AnalyticsPrivacyViolationError",
  "AnalyticsVocabularyError",
  "AnalyticsProviderContractError",
]);

/** A monotonic revision so a later run always supersedes an earlier one. */
function revisionFor(now: string): number {
  return Math.floor(Date.parse(now) / 1_000);
}

export function isSourceDue({
  state,
  source,
  now,
}: {
  state: AnalyticsSourceState | null;
  source: AnalyticsSource;
  now: string;
}): boolean {
  if (state === null) return true;
  if (state.nextRetryAt !== null) {
    return Date.parse(now) >= Date.parse(state.nextRetryAt);
  }
  return (
    Date.parse(now) - Date.parse(state.lastAttemptAt) >=
    refreshIntervalSeconds[source] * 1_000
  );
}

/**
 * The published paths each content item owned over time. Route history is not
 * yet persisted, so the current published definition is treated as having
 * always owned its paths; a later route change will need a recorded history to
 * keep two content items' traffic apart.
 */
export function currentRouteHistory(): ReadonlyArray<PublishedRouteHistoryEntry> {
  return [
    {
      path: "/",
      contentId: referenceSiteDefinition.home.id,
      fromUtc: "1970-01-01T00:00:00.000Z",
      toUtc: null,
    },
    ...referenceSiteDefinition.blog.posts.map((post) => ({
      path: `/blog/${post.slug}`,
      contentId: post.id,
      fromUtc: "1970-01-01T00:00:00.000Z",
      toUtc: null as string | null,
    })),
  ];
}

export async function runScheduledAnalyticsProjection(
  environment: AnalyticsProjectionEnvironment,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  const database = environment.FOUNDRY_DB;
  if (database === undefined) return;

  const siteId = referenceSiteDefinition.site.id;
  const store = createD1AnalyticsStore(database, siteId);
  const projection = createAnalyticsProjection({ siteId, store, now });
  const observedAt = now();
  const revision = revisionFor(observedAt);
  const completeThrough = utcDayStart(observedAt);
  const externalWindowStart = addDays(completeThrough, -externalRefreshDays);

  async function projectSource(
    source: AnalyticsSource,
    sourceName: string,
    definitionVersion: number,
    collect: () => Promise<ReadonlyArray<AnalyticsFactMeasurement>>,
    sourceMetric: string,
    notConfigured = false,
  ) {
    const state = await store.findCurrentSourceState({ source, sourceName });
    if (!isSourceDue({ state, source, now: observedAt })) return;
    if (notConfigured) {
      await projection.project({
        outcome: "unavailable",
        source,
        sourceName,
        definitionVersion,
        errorCode: "source_not_configured",
        attemptedAt: observedAt,
        nextRetryAt: null,
      });
      return;
    }
    try {
      const facts = await collect();
      await projection.project({
        source,
        sourceName,
        sourceMetric,
        definitionVersion,
        revision,
        observedAt,
        completeThrough,
        facts,
      });
    } catch (error) {
      // A normalizer that broke its own contract must not be reported as a
      // provider outage; that would hide our bug behind their name.
      if (error instanceof Error && contractErrorNames.has(error.name)) {
        throw error;
      }
      await projection.project({
        outcome: "unavailable",
        source,
        sourceName,
        definitionVersion,
        // Stable and non-secret: a provider message must never reach the
        // source state, because `/dash` shows it.
        errorCode: "source_query_failed",
        attemptedAt: observedAt,
        nextRetryAt: addSeconds(observedAt, refreshIntervalSeconds[source]),
      });
            // The failure class only; a provider message could carry request
      // detail we have no business writing to logs.
      console.error("analytics_source_failed", {
        source,
        sourceName,
        failure: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const operational = createD1OperationalAnalyticsSource(database, siteId);
  await projectSource(
    "d1",
    operationalAnalyticsSourceName,
    operationalAnalyticsDefinitionVersion,
    async () =>
      operational.measurements({
        startUtc: addDays(completeThrough, -2),
        endUtc: completeThrough,
        formIds: await operational.listFormIds(),
      }),
    "operational_records",
  );

  const accountId = environment.FOUNDRY_CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const analyticsToken = environment.FOUNDRY_ANALYTICS_API_TOKEN?.trim() ?? "";
  const siteTag =
    environment.FOUNDRY_CLOUDFLARE_WEB_ANALYTICS_SITE_TAG?.trim() ?? "";
  await projectSource(
    "cloudflare_web",
    cloudflareWebAnalyticsSourceName,
    cloudflareWebAnalyticsDefinitionVersion,
    async () =>
      normalizeCloudflareWebAnalytics({
        response: {
          pageloads: await fetchCloudflareWebAnalytics({
            accountTag: accountId,
            siteTag,
            apiToken: analyticsToken,
            since: externalWindowStart,
            until: completeThrough,
          }),
          webVitals: [],
        },
        siteId,
        routeHistory: currentRouteHistory(),
      }),
    "pageViews",
    accountId === "" || analyticsToken === "" || siteTag === "",
  );

  const dataset = environment.FOUNDRY_ANALYTICS_ENGINE_DATASET?.trim() ?? "";
  await projectSource(
    "analytics_engine",
    analyticsEngineSourceName,
    analyticsEngineDefinitionVersion,
    async () =>
      normalizeAnalyticsEngineRows(
        await queryAnalyticsEngine({
          accountId,
          apiToken: analyticsToken,
          dataset,
          since: externalWindowStart,
          until: completeThrough,
        }),
      ),
    "interaction_points",
    accountId === "" || analyticsToken === "" || dataset === "",
  );

  const brevoApiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
  await projectSource(
    "provider",
    brevoAnalyticsSourceName,
    brevoAnalyticsDefinitionVersion,
    async () => {
      const { results } = await database
        .prepare(
          `SELECT campaign_id, provider_campaign_id
           FROM campaign_bulk_send_operations
           WHERE site_id = ?1 AND provider_campaign_id IS NOT NULL`,
        )
        .bind(siteId)
        .all<{ campaign_id: string; provider_campaign_id: string }>();
      const campaignIdByProvider = new Map(
        results.map((row) => [row.provider_campaign_id, row.campaign_id]),
      );
      const adapter = createBrevoCampaignAnalyticsAdapter({
        apiKey: brevoApiKey,
        campaignIdForProviderCampaign: (providerCampaignId) =>
          campaignIdByProvider.get(providerCampaignId) ?? null,
        now,
      });
      const measurements: AnalyticsFactMeasurement[] = [];
      for (const [providerCampaignId, campaignId] of campaignIdByProvider) {
        const snapshot = await adapter.getCampaignAnalytics({
          campaignId,
          providerCampaignId,
        });
        measurements.push(
          ...campaignAnalyticsMeasurements({
            snapshot,
            capabilities: brevoAnalyticsCapabilities,
          }),
        );
      }
      return measurements;
    },
    "campaign_report",
    brevoApiKey === "",
  );

  const compaction = await projection.compact({ hourlyRetentionDays });
  if (
    compaction.daysSkippedForComparability > 0 ||
    compaction.daysSkippedForMixedAvailability > 0
  ) {
    // Not silent: a day that could not be merged keeps its hourly facts, and
    // saying so is what stops "compacted" from implying "complete".
    console.warn("analytics_compaction_skipped_days", compaction);
  }
}

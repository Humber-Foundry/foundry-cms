import {
  addUtcDays,
  addUtcSeconds,
  analyticsRetention,
  campaignAnalyticsMeasurements,
  createAnalyticsProjection,
  utcDayStart,
  type AnalyticsFactMeasurement,
  type AnalyticsSource,
  type AnalyticsSourceState,
  type CampaignAnalyticsSnapshot,
  type NewsletterAnalyticsAdapter,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";

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
 * own health, so one degraded source never blocks another, and none advances
 * completeness it did not earn.
 *
 * `custom-worker.ts` imports this module and the source adapters it reaches,
 * so none of them may import `server-only`. That package throws when it is
 * loaded outside a React Server Component, which stops the Worker starting.
 * Every other runtime the Worker entry imports follows the same rule.
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
 * Web Analytics and Analytics Engine revise recent buckets when late data
 * arrives, so every run re-reads the previous seven days.
 */
const externalRefreshDays = 7;
const hourlyRetentionDays = 90;

/** Fifty campaigns a page, so one run reads at most a thousand campaigns. */
const providerMaximumPagesPerRun = 20;

/** 90 days plus one week of slack, so the day-90 poll always happens. */
const widestProviderPollDays = 97;

/** These errors mean a normalizer broke its own contract. They are our bugs. */
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
 * How far back a provider run asks for changed campaigns.
 *
 * ADR-0003 asks for three bands: poll recently sent campaigns often for 72
 * hours, daily through 30 days, and once more at 90 days. The band is chosen
 * from the last successful run, so the projector keeps its place without any
 * extra stored state:
 *
 * - a different UTC week from the last success — the 97-day band
 * - a different UTC day — the 30-day band
 * - otherwise — the 72-hour band every scheduled run covers
 *
 * The widest band covers 97 days. A weekly band bounded at exactly 90 days
 * would last request a campaign at about day 83, so the extra week puts the
 * final reconciliation at or after day 90. Past 97 days a campaign is left
 * out: its facts are projected and the provider stops revising them.
 */
export function providerPollWindowDays({
  lastSuccessAt,
  now,
}: {
  lastSuccessAt: string | null;
  now: string;
}): number {
  if (lastSuccessAt === null) return widestProviderPollDays;
  if (utcWeekKey(lastSuccessAt) !== utcWeekKey(now)) {
    return widestProviderPollDays;
  }
  if (lastSuccessAt.slice(0, 10) !== now.slice(0, 10)) return 30;
  return 3;
}

/** The ISO week an instant falls in, as a sortable `YYYY-Www` key. */
function utcWeekKey(instant: string): string {
  const date = new Date(Date.parse(instant));
  date.setUTCHours(0, 0, 0, 0);
  // Thursday decides the ISO week-numbering year.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The provider campaigns this site owns, keyed by the provider's own ID. */
async function ownedProviderCampaigns(
  database: NonNullable<AnalyticsProjectionEnvironment["FOUNDRY_DB"]>,
  siteId: string,
): Promise<Map<string, string>> {
  const { results } = await database
    .prepare(
      `SELECT campaign_id, provider_campaign_id
       FROM campaign_bulk_send_operations
       WHERE site_id = ?1 AND provider_campaign_id IS NOT NULL`,
    )
    .bind(siteId)
    .all<{ campaign_id: string; provider_campaign_id: string }>();
  return new Map(
    results.map((row) => [row.provider_campaign_id, row.campaign_id]),
  );
}

/**
 * Pages through the provider's changed-campaign list with its cursor. One
 * request returns up to fifty campaigns. Requesting each campaign separately
 * would cost one request per campaign, which a free-tier quota cannot cover.
 */
async function listChangedCampaignSnapshots({
  adapter,
  since,
  maximumPages = providerMaximumPagesPerRun,
}: {
  adapter: NewsletterAnalyticsAdapter;
  since: string;
  maximumPages?: number;
}): Promise<ReadonlyArray<CampaignAnalyticsSnapshot>> {
  const snapshots: CampaignAnalyticsSnapshot[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maximumPages; page += 1) {
    const result = await adapter.listChangedCampaignAnalytics({
      cursor,
      since,
    });
    snapshots.push(...result.snapshots);
    cursor = result.nextCursor;
    if (cursor === null) return snapshots;
  }
  // Records that this run stopped at the page cap and read only part of the
  // provider's changed-campaign list.
  console.warn("analytics_provider_pages_capped", { maximumPages, since });
  return snapshots;
}

/**
 * The published paths each content item owned over time. Route history is not
 * stored yet, so the current published definition is treated as having always
 * owned its paths. A later route change will need a stored history to keep two
 * content items' traffic apart.
 */
export function currentRouteHistory(): ReadonlyArray<PublishedRouteHistoryEntry> {
  return [
    {
      path: "/",
      contentId: installedSiteDefinition.home.id,
      fromUtc: "1970-01-01T00:00:00.000Z",
      toUtc: null,
    },
    ...installedSiteDefinition.blog.posts.map((post) => ({
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

  const siteId = installedSiteDefinition.site.id;
  const store = createD1AnalyticsStore(database, siteId);
  const projection = createAnalyticsProjection({ siteId, store, now });
  const observedAt = now();
  const revision = revisionFor(observedAt);
  // External platforms revise a day until it closes, so they may only
  // claim completeness through the last closed UTC day.
  const lastClosedDay = utcDayStart(observedAt);
  const externalWindowStart = addUtcDays(lastClosedDay, -externalRefreshDays);

  async function projectSource({
    source,
    sourceName,
    definitionVersion,
    sourceMetric,
    collect,
    completeThrough,
    configured,
  }: {
    source: AnalyticsSource;
    sourceName: string;
    definitionVersion: number;
    sourceMetric: string;
    collect: (
      state: AnalyticsSourceState | null,
    ) => Promise<ReadonlyArray<AnalyticsFactMeasurement>>;
    /** The latest instant through which this source has complete data. */
    completeThrough: string;
    configured: boolean;
  }) {
    const state = await store.findCurrentSourceState({ source, sourceName });
    if (!isSourceDue({ state, source, now: observedAt })) return;
    if (!configured) {
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
      const facts = await collect(state);
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
      // A normalizer that broke its own contract is an internal error.
      // Recording it as a provider outage would misattribute it.
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
        nextRetryAt: addUtcSeconds(observedAt, refreshIntervalSeconds[source]),
      });
      // The failure class only; a provider message could carry request detail
      // we have no business writing to logs.
      console.error("analytics_source_failed", {
        source,
        sourceName,
        failure: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // D1 is exact and local, so it reports through the current instant. Today's
  // bucket ends after that instant, which is what marks the range in
  // progress.
  const operational = createD1OperationalAnalyticsSource(database, siteId);
  await projectSource({
    source: "d1",
    sourceName: operationalAnalyticsSourceName,
    definitionVersion: operationalAnalyticsDefinitionVersion,
    sourceMetric: "operational_records",
    completeThrough: observedAt,
    configured: true,
    collect: async () =>
      operational.measurements({
        startUtc: addUtcDays(utcDayStart(observedAt), -2),
        endUtc: observedAt,
        formIds: await operational.listFormIds(),
      }),
  });

  const accountId = environment.FOUNDRY_CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const analyticsToken = environment.FOUNDRY_ANALYTICS_API_TOKEN?.trim() ?? "";
  const siteTag =
    environment.FOUNDRY_CLOUDFLARE_WEB_ANALYTICS_SITE_TAG?.trim() ?? "";
  await projectSource({
    source: "cloudflare_web",
    sourceName: cloudflareWebAnalyticsSourceName,
    definitionVersion: cloudflareWebAnalyticsDefinitionVersion,
    sourceMetric: "pageViews",
    completeThrough: lastClosedDay,
    configured: accountId !== "" && analyticsToken !== "" && siteTag !== "",
    collect: async () =>
      normalizeCloudflareWebAnalytics({
        response: {
          pageloads: await fetchCloudflareWebAnalytics({
            accountTag: accountId,
            siteTag,
            apiToken: analyticsToken,
            since: externalWindowStart,
            until: lastClosedDay,
          }),
          // Web Vitals collection is not shipped. See "What this does not
          // do" in docs/architecture/privacy-first-aggregate-analytics.md.
          // The normalizer below handles them once the query is confirmed.
          // Until then the three metrics have state `unavailable`.
          webVitals: [],
        },
        siteId,
        routeHistory: currentRouteHistory(),
      }),
  });

  // Analytics Engine reports hours as well as days. The hourly facts serve an
  // intraday range for 90 days and then compact away; the daily facts carry
  // the history past Analytics Engine's own three-month retention.
  const dataset = environment.FOUNDRY_ANALYTICS_ENGINE_DATASET?.trim() ?? "";
  await projectSource({
    source: "analytics_engine",
    sourceName: analyticsEngineSourceName,
    definitionVersion: analyticsEngineDefinitionVersion,
    sourceMetric: "interaction_points",
    completeThrough: lastClosedDay,
    configured: accountId !== "" && analyticsToken !== "" && dataset !== "",
    collect: async () => {
      const engineQuery = {
        accountId,
        apiToken: analyticsToken,
        dataset,
        since: externalWindowStart,
        until: lastClosedDay,
      };
      const [daily, hourly] = await Promise.all([
        queryAnalyticsEngine({ ...engineQuery, granularity: "day" }),
        queryAnalyticsEngine({ ...engineQuery, granularity: "hour" }),
      ]);
      return [
        ...normalizeAnalyticsEngineRows(daily, "day"),
        ...normalizeAnalyticsEngineRows(hourly, "hour"),
      ];
    },
  });

  const brevoApiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
  await projectSource({
    source: "provider",
    sourceName: brevoAnalyticsSourceName,
    definitionVersion: brevoAnalyticsDefinitionVersion,
    sourceMetric: "campaign_report",
    completeThrough: observedAt,
    configured: brevoApiKey !== "",
    collect: async (providerState) => {
      const campaignIdByProvider = await ownedProviderCampaigns(
        database,
        siteId,
      );
      const adapter = createBrevoCampaignAnalyticsAdapter({
        apiKey: brevoApiKey,
        campaignIdForProviderCampaign: (providerCampaignId) =>
          campaignIdByProvider.get(providerCampaignId) ?? null,
        now,
      });
      const windowDays = providerPollWindowDays({
        lastSuccessAt: providerState?.lastSuccessAt ?? null,
        now: observedAt,
      });
      const snapshots = await listChangedCampaignSnapshots({
        adapter,
        since: addUtcDays(observedAt, -windowDays),
      });
      return snapshots.flatMap((snapshot) =>
        campaignAnalyticsMeasurements({
          snapshot,
          capabilities: brevoAnalyticsCapabilities,
        }),
      );
    },
  });

  const compaction = await projection.compact({ hourlyRetentionDays });
  if (
    compaction.daysSkippedForComparability > 0 ||
    compaction.daysSkippedForMixedAvailability > 0
  ) {
    // Records which days compaction skipped and therefore still hold their
    // hourly facts.
    console.warn("analytics_compaction_skipped_days", compaction);
  }

  await projection.purge({
    aggregateFactMonths: analyticsRetention.aggregateFactMonths,
  });
}

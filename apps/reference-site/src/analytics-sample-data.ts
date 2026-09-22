import "server-only";

import {
  analyticsMetricDefinition,
  analyticsRetention,
  analyticsSchemaVersion,
  availableValue,
  comparabilitySignature,
  resolveReportingRange,
  type AnalyticsMetricKey,
  type AnalyticsReading,
  type AnalyticsReferrerRow,
  type AnalyticsTrafficDay,
} from "@humber-foundry/application";
import type { SiteId } from "@humber-foundry/site-definition";

import type { AnalyticsDashboardData } from "./analytics-dashboard-runtime";
import type { ReportingPeriodDays } from "./analytics-reporting-period";

/**
 * Made-up figures for local development.
 *
 * `next dev` has no D1 binding, so the read model cannot answer and the
 * Visitors screen would be empty on a developer's machine. These figures let
 * the screen be reviewed locally. Every one of them is marked as a sample on
 * screen, and `loadAnalyticsDashboard` builds them only when `NODE_ENV` is
 * `development`. A deployed site never reaches this module.
 *
 * The numbers are worked out from the date, so the same day always gives the
 * same screen and a review can be repeated.
 */

const sampleSourceName = "sample";
const sampleSourceMetric = "sample_points";

function seededHash(label: string, dayIndex: number): number {
  let hash = 2_166_136_261;
  for (const character of `${label}:${dayIndex}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

/** A small, repeatable number from a label and a day. */
function seededCount(label: string, dayIndex: number, size: number): number {
  return (
    Math.round(size * 0.55) +
    (seededHash(label, dayIndex) % Math.round(size * 0.9))
  );
}

/**
 * The arrivals among one day's page views. A visit is always one of that
 * day's page views, so this is a share of them and never more.
 */
function seededVisits(dayIndex: number, pageViews: number): number {
  const share = 0.45 + (seededHash("visits", dayIndex) % 25) / 100;
  return Math.max(1, Math.round(pageViews * share));
}

function sampleReading({
  metricKey,
  value,
  subjectType = "site",
  subjectId = null,
  observedAt,
  completeThrough,
  buckets,
}: {
  metricKey: AnalyticsMetricKey;
  value: number;
  subjectType?: AnalyticsReading["subjectType"];
  subjectId?: string | null;
  observedAt: string;
  completeThrough: string;
  buckets: number;
}): AnalyticsReading {
  const definition = analyticsMetricDefinition(metricKey);
  const identity = {
    metricKey,
    source: "analytics_engine" as const,
    sourceName: sampleSourceName,
    sourceMetric: sampleSourceMetric,
    definitionVersion: definition.definitionVersion,
  };
  return Object.freeze({
    metricKey,
    definition: definition.definition,
    unit: definition.unit,
    prominence: definition.prominence,
    aggregation: definition.aggregation,
    subjectType,
    subjectId,
    source: identity.source,
    sourceName: identity.sourceName,
    sourceMetric: identity.sourceMetric,
    definitionVersion: identity.definitionVersion,
    quality: definition.defaultQuality,
    sampleInterval: 1,
    observedAt,
    completeThrough,
    freshness: "fresh" as const,
    value: availableValue(value),
    measuredBuckets: buckets,
    unavailableBuckets: 0,
    comparabilitySignature: comparabilitySignature(identity),
  });
}

function sampleReferrer(
  dimensionKey: string,
  dimensionValue: string,
  value: number,
): AnalyticsReferrerRow {
  const identity = {
    metricKey: "web.page_views" as const,
    source: "analytics_engine" as const,
    sourceName: sampleSourceName,
    sourceMetric: sampleSourceMetric,
    definitionVersion: analyticsMetricDefinition("web.page_views")
      .definitionVersion,
  };
  return Object.freeze({
    dimensionKey,
    dimensionValue,
    value: availableValue(value),
    source: identity.source,
    sourceName: identity.sourceName,
    comparabilitySignature: comparabilitySignature(identity),
  });
}

export function sampleAnalyticsDashboard({
  now,
  periodDays,
  timeZone,
  siteId,
  contentTitles,
  contentPaths,
}: {
  now: string;
  periodDays: ReportingPeriodDays;
  timeZone: string;
  siteId: SiteId;
  contentTitles: Readonly<Record<string, string>>;
  contentPaths: Readonly<Record<string, string>>;
}): AnalyticsDashboardData {
  const nowMs = Date.parse(now);
  const toLocalDate = new Date(nowMs).toISOString().slice(0, 10);
  const fromLocalDate = new Date(nowMs - (periodDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const resolved = resolveReportingRange({
    fromLocalDate,
    toLocalDate,
    timeZone,
    now,
  });
  const range = Object.freeze({
    ...resolved,
    containsIncompleteBucket: true,
    clampedToRetention: false,
  });
  const observedAt = now;
  const completeThrough = `${toLocalDate}T00:00:00.000Z`;

  const days: AnalyticsTrafficDay[] = [];
  let pageViewTotal = 0;
  let visitTotal = 0;
  for (let index = 0; index < periodDays; index += 1) {
    const bucketStartUtc = `${new Date(
      nowMs - (periodDays - 1 - index) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10)}T00:00:00.000Z`;
    const pageViews = seededCount("page_views", index, 90);
    const visits = seededVisits(index, pageViews);
    pageViewTotal += pageViews;
    visitTotal += visits;
    days.push(
      Object.freeze({
        bucketStartUtc,
        pageViews: availableValue(pageViews),
        visits: availableValue(visits),
      }),
    );
  }

  // The period before, so the screen can show a change. It is built the same
  // way, one period further back.
  let previousPageViews = 0;
  let previousVisits = 0;
  for (let index = 0; index < periodDays; index += 1) {
    const pageViews = seededCount("page_views", index - periodDays, 90);
    previousPageViews += pageViews;
    previousVisits += seededVisits(index - periodDays, pageViews);
  }

  const envelope = { schemaVersion: analyticsSchemaVersion, siteId, range };
  const reading = (metricKey: AnalyticsMetricKey, value: number) =>
    sampleReading({
      metricKey,
      value,
      observedAt,
      completeThrough,
      buckets: periodDays,
    });

  const contentIds = Object.keys(contentPaths).slice(0, 5);
  const contentItems = contentIds.map((subjectId, index) => ({
    subjectId,
    readings: [
      sampleReading({
        metricKey: "content.page_views",
        value: Math.max(
          1,
          Math.round(pageViewTotal / (contentIds.length + index * 2)),
        ),
        subjectType: "content" as const,
        subjectId,
        observedAt,
        completeThrough,
        buckets: periodDays,
      }),
    ],
    vitals: [],
  }));

  return {
    periodDays,
    sample: true,
    overview: {
      ...envelope,
      metrics: [
        reading("web.visits", visitTotal),
        reading("web.page_views", pageViewTotal),
      ],
      referrers: [
        sampleReferrer("referrer_channel", "direct", Math.round(visitTotal * 0.5)),
        sampleReferrer("referrer_channel", "search", Math.round(visitTotal * 0.3)),
        sampleReferrer(
          "referrer_host",
          "sample-partner.example",
          Math.round(visitTotal * 0.2),
        ),
      ],
      comparison: {
        range,
        metrics: [
          reading("web.visits", previousVisits),
          reading("web.page_views", previousPageViews),
        ],
      },
      sources: [],
    },
    traffic: { ...envelope, days, sources: [] },
    content: { ...envelope, items: contentItems, limit: 10, sources: [] },
    contentTitles,
    contentPaths,
    forms: { ...envelope, items: [], sources: [] },
    audience: { ...envelope, metrics: [], sources: [] },
    campaigns: { ...envelope, items: [], limit: 10, sources: [] },
    health: {
      ...envelope,
      sources: [
        {
          source: "analytics_engine",
          sourceName: sampleSourceName,
          status: "healthy",
          lastAttemptAt: observedAt,
          lastSuccessAt: observedAt,
          completeThrough,
          nextRetryAt: null,
          errorCode: null,
          definitionVersion: 1,
          freshness: "fresh",
        },
      ],
      retention: analyticsRetention,
      earliestFactInstant: null,
      disagreements: [],
    },
  } as unknown as AnalyticsDashboardData;
}

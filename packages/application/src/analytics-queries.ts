/**
 * The read side of the aggregate projection. `/dash` asks these queries for
 * every number it shows, so the rules that stop a number from being read
 * wrongly — one granularity per interval, unlike measurements never summed,
 * absent data reported as unavailable, small breakdown rows suppressed — live
 * here rather than in a view.
 */

import type { SiteId } from "@foundry/site-definition";

import {
  analyticsMetricDefinition,
  analyticsMetrics,
  analyticsSchemaVersion,
  analyticsSourceExpectedLagSeconds,
  availableValue,
  comparabilitySignature,
  presentSecondaryCell,
  readingFreshness,
  summableSeries,
  unavailableValue,
  type AnalyticsFreshness,
  type AnalyticsGranularity,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricKey,
  type AnalyticsProminence,
  type AnalyticsQuality,
  type AnalyticsSource,
  type AnalyticsSourceState,
  type AnalyticsSubjectType,
  type AnalyticsUnavailableReason,
  type AnalyticsUnit,
  type AnalyticsValue,
} from "./analytics-model";
import type { StoredAnalyticsFact } from "./analytics-projection";

export const analyticsRetention = Object.freeze({
  aggregateFactMonths: 25,
  hourlyFactDays: 90,
  cloudflareWebAnalyticsMonths: 6,
  analyticsEngineMonths: 3,
});

export const analyticsReadCapability = "analytics.read" as const;

const maximumPageSize = 100;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

export type AnalyticsRangeErrorCode =
  | "local_date_invalid"
  | "range_inverted"
  | "hourly_facts_compacted";

export class AnalyticsRangeError extends Error {
  readonly code: AnalyticsRangeErrorCode;

  constructor(code: AnalyticsRangeErrorCode) {
    super(`The requested analytics range was refused: ${code}.`);
    this.name = "AnalyticsRangeError";
    this.code = code;
  }
}

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  return (
    Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    ) - instantMs
  );
}

/**
 * The UTC instant of local midnight. Solved by fixed point rather than by a
 * fixed offset so a daylight-saving day is a real 23- or 25-hour day.
 */
function zonedMidnight(localDate: string, timeZone: string): string {
  if (!localDatePattern.test(localDate)) {
    throw new AnalyticsRangeError("local_date_invalid");
  }
  const naive = Date.parse(`${localDate}T00:00:00.000Z`);
  if (
    Number.isNaN(naive) ||
    new Date(naive).toISOString().slice(0, 10) !== localDate
  ) {
    throw new AnalyticsRangeError("local_date_invalid");
  }
  let instant = naive - zoneOffsetMs(naive, timeZone);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = naive - zoneOffsetMs(instant, timeZone);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant).toISOString();
}

function addUtcDays(instant: string, days: number): string {
  return new Date(Date.parse(instant) + days * 86_400_000).toISOString();
}

function subtractMonths(instant: string, months: number): string {
  const date = new Date(Date.parse(instant));
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

export type AnalyticsRangeRequest = Readonly<{
  fromLocalDate: string;
  toLocalDate: string;
  granularity?: "auto" | "hour" | "day";
}>;

export type AnalyticsResolvedRange = Readonly<{
  timeZone: string;
  fromLocalDate: string;
  toLocalDate: string;
  startUtc: string;
  endUtc: string;
  granularity: AnalyticsGranularity;
}>;

export function resolveReportingRange({
  fromLocalDate,
  toLocalDate,
  timeZone,
  granularity = "auto",
  now = new Date().toISOString(),
}: AnalyticsRangeRequest & {
  timeZone: string;
  now?: string;
}): AnalyticsResolvedRange {
  const startUtc = zonedMidnight(fromLocalDate, timeZone);
  const endUtc = zonedMidnight(
    new Date(Date.parse(`${toLocalDate}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10),
    timeZone,
  );
  if (Date.parse(endUtc) <= Date.parse(startUtc)) {
    throw new AnalyticsRangeError("range_inverted");
  }
  if (granularity === "hour") {
    const hourlyFloor = addUtcDays(now, -analyticsRetention.hourlyFactDays);
    if (Date.parse(startUtc) < Date.parse(hourlyFloor)) {
      throw new AnalyticsRangeError("hourly_facts_compacted");
    }
  }
  return Object.freeze({
    timeZone,
    fromLocalDate,
    toLocalDate,
    startUtc,
    endUtc,
    granularity: granularity === "hour" ? "hour" : "day",
  });
}

export type AnalyticsRangeEcho = AnalyticsResolvedRange &
  Readonly<{
    containsIncompleteBucket: boolean;
    clampedToRetention: boolean;
  }>;

export type AnalyticsReading = Readonly<{
  metricKey: AnalyticsMetricKey;
  definition: string;
  unit: AnalyticsUnit;
  prominence: AnalyticsProminence;
  aggregation: "sum" | "latest";
  subjectType: AnalyticsSubjectType;
  subjectId: string | null;
  source: AnalyticsSource;
  sourceName: string | null;
  sourceMetric: string | null;
  definitionVersion: number | null;
  quality: AnalyticsQuality;
  sampleInterval: number | null;
  observedAt: string | null;
  completeThrough: string | null;
  freshness: AnalyticsFreshness | "unknown";
  value: AnalyticsValue;
  measuredBuckets: number;
  unavailableBuckets: number;
  comparabilitySignature: string | null;
}>;

export type AnalyticsDerivedRatio = Readonly<{
  metricKey: "form.conversion_rate";
  definition: string;
  unit: "ratio";
  quality: AnalyticsQuality;
  numeratorMetricKey: AnalyticsMetricKey;
  denominatorMetricKey: AnalyticsMetricKey;
  denominatorQuality: AnalyticsQuality | null;
  value: AnalyticsValue;
}>;

export type AnalyticsReferrerRow = Readonly<{
  dimensionKey: string;
  dimensionValue: string;
  value: AnalyticsValue;
}>;

export type AnalyticsSourceHealth = AnalyticsSourceState &
  Readonly<{ freshness: AnalyticsFreshness | "unknown" }>;

export type AnalyticsReadStore = Readonly<{
  listFacts(query: {
    metricKeys: ReadonlyArray<string>;
    granularity: AnalyticsGranularity;
    startUtc: string;
    endUtc: string;
  }): Promise<ReadonlyArray<StoredAnalyticsFact>>;
  listSourceStates(): Promise<ReadonlyArray<AnalyticsSourceState>>;
  earliestFactInstant(): Promise<string | null>;
}>;

type ReadingScope = Readonly<{
  facts: ReadonlyArray<StoredAnalyticsFact>;
  sourceStates: ReadonlyArray<AnalyticsSourceState>;
  outsideRetention: boolean;
  now: string;
}>;

function totalsOnly(
  facts: ReadonlyArray<StoredAnalyticsFact>,
): ReadonlyArray<StoredAnalyticsFact> {
  return facts.filter((fact) => fact.dimensionKey === "");
}

function groupBySignature(
  facts: ReadonlyArray<StoredAnalyticsFact>,
): ReadonlyArray<ReadonlyArray<StoredAnalyticsFact>> {
  const groups = new Map<string, StoredAnalyticsFact[]>();
  for (const fact of facts) {
    const signature = comparabilitySignature(fact);
    const group = groups.get(signature);
    if (group === undefined) groups.set(signature, [fact]);
    else group.push(fact);
  }
  return [...groups.values()];
}

function latestInstant(instants: ReadonlyArray<string>): string {
  return instants.reduce((highest, candidate) =>
    Date.parse(candidate) > Date.parse(highest) ? candidate : highest,
  );
}

function earliestInstant(instants: ReadonlyArray<string>): string {
  return instants.reduce((lowest, candidate) =>
    Date.parse(candidate) < Date.parse(lowest) ? candidate : lowest,
  );
}

function absentReason(
  definition: AnalyticsMetricDefinition,
  scope: ReadingScope,
): AnalyticsUnavailableReason {
  if (scope.outsideRetention) return "outside_retention";
  const state = scope.sourceStates.find(
    (candidate) => candidate.source === definition.source,
  );
  return state?.status === "unavailable" ? "source_unavailable" : "not_measured";
}

function unavailableReading(
  definition: AnalyticsMetricDefinition,
  scope: ReadingScope,
  subject: Readonly<{
    subjectType?: AnalyticsSubjectType;
    subjectId: string | null;
  }>,
  reason: AnalyticsUnavailableReason = absentReason(definition, scope),
): AnalyticsReading {
  const state = scope.sourceStates.find(
    (candidate) => candidate.source === definition.source,
  );
  return Object.freeze({
    metricKey: definition.metricKey,
    definition: definition.definition,
    unit: definition.unit,
    prominence: definition.prominence,
    aggregation: definition.aggregation,
    subjectType: subject.subjectType ?? definition.subjectTypes[0],
    subjectId: subject.subjectId,
    source: definition.source,
    sourceName: state?.sourceName ?? null,
    sourceMetric: null,
    definitionVersion: null,
    quality: definition.defaultQuality,
    sampleInterval: null,
    observedAt: null,
    completeThrough: null,
    freshness: "unknown" as const,
    value: unavailableValue(reason),
    measuredBuckets: 0,
    unavailableBuckets: 0,
    comparabilitySignature: null,
  });
}

function buildReading(
  group: ReadonlyArray<StoredAnalyticsFact>,
  scope: ReadingScope,
  subjectId: string | null,
): AnalyticsReading {
  const first = group[0];
  const definition = analyticsMetricDefinition(first.metricKey);
  const measured = group.filter((fact) => fact.availability === "available");
  const observedAt = earliestInstant(group.map((fact) => fact.observedAt));
  const completeThrough = earliestInstant(
    group.map((fact) => fact.completeThrough),
  );
  const bucketEndUtc = latestInstant(group.map((fact) => fact.bucketEndUtc));

  let value: AnalyticsValue;
  if (measured.length === 0) {
    value = unavailableValue(
      group.find((fact) => fact.unavailableReason !== null)
        ?.unavailableReason ?? "not_measured",
    );
  } else if (definition.aggregation === "latest") {
    const newest = measured.reduce((latest, candidate) =>
      Date.parse(candidate.bucketStartUtc) > Date.parse(latest.bucketStartUtc)
        ? candidate
        : latest,
    );
    value = availableValue(newest.value as number);
  } else {
    const total = summableSeries(
      measured.map((fact) => ({
        metricKey: fact.metricKey as AnalyticsMetricKey,
        source: fact.source,
        sourceName: fact.sourceName,
        sourceMetric: fact.sourceMetric,
        definitionVersion: fact.definitionVersion,
        value: fact.value as number,
      })),
    );
    value =
      total === null ? unavailableValue("not_measured") : availableValue(total);
  }

  return Object.freeze({
    metricKey: first.metricKey as AnalyticsMetricKey,
    definition: definition.definition,
    unit: first.unit,
    prominence: definition.prominence,
    aggregation: definition.aggregation,
    subjectType: first.subjectType,
    subjectId,
    source: first.source,
    sourceName: first.sourceName,
    sourceMetric: first.sourceMetric,
    definitionVersion: first.definitionVersion,
    quality: first.quality,
    sampleInterval: first.sampleInterval,
    observedAt,
    completeThrough,
    freshness: readingFreshness({
      completeThrough,
      bucketEndUtc,
      observedAt,
      now: scope.now,
      expectedLagSeconds: analyticsSourceExpectedLagSeconds[first.source],
    }),
    value,
    measuredBuckets: measured.length,
    unavailableBuckets: group.length - measured.length,
    comparabilitySignature: comparabilitySignature(first),
  });
}

/** One reading per distinct measurement definition; unlike series stay apart. */
function readAggregate(
  metricKey: AnalyticsMetricKey,
  scope: ReadingScope,
): ReadonlyArray<AnalyticsReading> {
  const definition = analyticsMetricDefinition(metricKey);
  const groups = groupBySignature(
    totalsOnly(scope.facts.filter((fact) => fact.metricKey === metricKey)),
  );
  if (groups.length === 0) {
    return [unavailableReading(definition, scope, { subjectId: null })];
  }
  return groups.map((group) => buildReading(group, scope, null));
}

function readSubject(
  metricKey: AnalyticsMetricKey,
  subjectId: string,
  scope: ReadingScope,
): ReadonlyArray<AnalyticsReading> {
  const definition = analyticsMetricDefinition(metricKey);
  const groups = groupBySignature(
    totalsOnly(
      scope.facts.filter(
        (fact) =>
          fact.metricKey === metricKey && fact.subjectId === subjectId,
      ),
    ),
  );
  if (groups.length === 0) {
    return [unavailableReading(definition, scope, { subjectId })];
  }
  return groups.map((group) => buildReading(group, scope, subjectId));
}

function readingValueOrNull(reading: AnalyticsReading): number | null {
  return reading.value.state === "available" ? reading.value.value : null;
}

const crossSourceOutcomes: ReadonlyArray<
  Readonly<{ outcome: string; metricKeys: ReadonlyArray<AnalyticsMetricKey> }>
> = Object.freeze([
  {
    outcome: "unsubscribed",
    metricKeys: ["subscriber.unsubscribed", "campaign.unsubscribed"],
  },
  {
    outcome: "hard_bounced",
    metricKeys: ["subscriber.hard_bounced", "campaign.hard_bounced"],
  },
  {
    outcome: "complained",
    metricKeys: ["subscriber.complained", "campaign.complained"],
  },
]);

const overviewMetrics: ReadonlyArray<AnalyticsMetricKey> = Object.freeze([
  "web.visits",
  "web.page_views",
  "form.submissions_accepted",
  "subscriber.active",
  "subscriber.net_growth",
  "campaign.delivered",
]);

const audienceMetrics: ReadonlyArray<AnalyticsMetricKey> = Object.freeze([
  "subscriber.active",
  "subscriber.confirmed",
  "subscriber.unsubscribed",
  "subscriber.hard_bounced",
  "subscriber.complained",
  "subscriber.net_growth",
]);

const formMetrics: ReadonlyArray<AnalyticsMetricKey> = Object.freeze([
  "form.submissions_accepted",
  "form.submissions_blocked",
  "form.notifications_delivered",
  "form.notifications_failed",
  "interaction.form_impressions",
]);

const campaignMetrics: ReadonlyArray<AnalyticsMetricKey> = Object.freeze(
  analyticsMetrics
    .filter((entry) => entry.bucketGranularity === "campaign")
    .map((entry) => entry.metricKey),
);

const contentVitalMetrics: ReadonlyArray<AnalyticsMetricKey> = Object.freeze([
  "web.vitals.lcp_p75",
  "web.vitals.inp_p75",
  "web.vitals.cls_p75",
]);

export function createAnalyticsQueryApplication<Actor>({
  siteId,
  store,
  reportingTimeZone,
  now = () => new Date().toISOString(),
  authorize,
}: {
  siteId: SiteId;
  store: AnalyticsReadStore;
  reportingTimeZone: string;
  now?: () => string;
  authorize(
    actor: Actor,
    capability: typeof analyticsReadCapability,
  ): Promise<unknown>;
}) {
  async function openScope(
    actor: Actor,
    request: AnalyticsRangeRequest,
    metricKeys: ReadonlyArray<AnalyticsMetricKey>,
  ) {
    await authorize(actor, analyticsReadCapability);
    const observedNow = now();
    const resolved = resolveReportingRange({
      ...request,
      timeZone: reportingTimeZone,
      now: observedNow,
    });
    const retentionFloor = subtractMonths(
      observedNow,
      analyticsRetention.aggregateFactMonths,
    );
    const outsideRetention =
      Date.parse(resolved.endUtc) <= Date.parse(retentionFloor);
    const clampedToRetention =
      Date.parse(resolved.startUtc) < Date.parse(retentionFloor);
    const startUtc = clampedToRetention ? retentionFloor : resolved.startUtc;

    const sourceStates = await store.listSourceStates();
    const rangeKeys = metricKeys.filter(
      (key) =>
        analyticsMetricDefinition(key).bucketGranularity === "range",
    );
    const perCampaignKeys = metricKeys.filter(
      (key) =>
        analyticsMetricDefinition(key).bucketGranularity === "campaign",
    );
    const facts = outsideRetention
      ? []
      : [
          ...(rangeKeys.length === 0
            ? []
            : await store.listFacts({
                metricKeys: rangeKeys,
                granularity: resolved.granularity,
                startUtc,
                endUtc: resolved.endUtc,
              })),
          ...(perCampaignKeys.length === 0
            ? []
            : await store.listFacts({
                metricKeys: perCampaignKeys,
                granularity: "campaign",
                startUtc,
                endUtc: resolved.endUtc,
              })),
        ];

    const scope: ReadingScope = {
      facts,
      sourceStates,
      outsideRetention,
      now: observedNow,
    };
    const range: AnalyticsRangeEcho = Object.freeze({
      ...resolved,
      containsIncompleteBucket:
        Date.parse(resolved.endUtc) > Date.parse(observedNow) ||
        facts.some(
          (fact) =>
            Date.parse(fact.bucketEndUtc) > Date.parse(fact.completeThrough),
        ),
      clampedToRetention,
    });
    return { scope, range, sourceStates, observedNow };
  }

  function sourceHealth(
    states: ReadonlyArray<AnalyticsSourceState>,
    observedNow: string,
  ): ReadonlyArray<AnalyticsSourceHealth> {
    return states.map((state) =>
      Object.freeze({
        ...state,
        freshness:
          state.lastSuccessAt === null || state.completeThrough === null
            ? ("unknown" as const)
            : readingFreshness({
                completeThrough: state.completeThrough,
                bucketEndUtc: state.completeThrough,
                observedAt: state.lastSuccessAt,
                now: observedNow,
                expectedLagSeconds:
                  analyticsSourceExpectedLagSeconds[state.source],
              }),
      }),
    );
  }

  function subjectIdsFor(
    scope: ReadingScope,
    metricKeys: ReadonlyArray<AnalyticsMetricKey>,
  ): ReadonlyArray<string> {
    return [
      ...new Set(
        totalsOnly(scope.facts)
          .filter((fact) =>
            metricKeys.includes(fact.metricKey as AnalyticsMetricKey),
          )
          .map((fact) => fact.subjectId),
      ),
    ];
  }

  function envelope(range: AnalyticsRangeEcho) {
    return {
      schemaVersion: analyticsSchemaVersion,
      siteId,
      range,
    };
  }

  return {
    queries: Object.freeze({
      async overview({
        actor,
        range: request,
        comparison,
      }: {
        actor: Actor;
        range: AnalyticsRangeRequest;
        comparison?: "previous_period";
      }) {
        const { scope, range, sourceStates, observedNow } = await openScope(
          actor,
          request,
          overviewMetrics,
        );
        const metrics = overviewMetrics.flatMap((metricKey) =>
          readAggregate(metricKey, scope),
        );
        const referrerFacts = scope.facts.filter(
          (fact) =>
            fact.metricKey === "web.page_views" &&
            fact.dimensionKey !== "",
        );
        const referrerTotals = new Map<string, number>();
        for (const fact of referrerFacts) {
          if (fact.value === null) continue;
          const key = `${fact.dimensionKey} ${fact.dimensionValue}`;
          referrerTotals.set(key, (referrerTotals.get(key) ?? 0) + fact.value);
        }
        const referrers: ReadonlyArray<AnalyticsReferrerRow> = [
          ...referrerTotals.entries(),
        ]
          .sort(([, left], [, right]) => right - left)
          .map(([key, total]) => {
            const [dimensionKey, dimensionValue] = key.split(" ");
            return Object.freeze({
              dimensionKey,
              dimensionValue,
              value: presentSecondaryCell(total),
            });
          });

        let comparisonView = null;
        if (comparison === "previous_period") {
          const days =
            (Date.parse(range.endUtc) - Date.parse(range.startUtc)) /
            86_400_000;
          const previousTo = new Date(
            Date.parse(`${request.fromLocalDate}T00:00:00.000Z`) - 86_400_000,
          )
            .toISOString()
            .slice(0, 10);
          const previousFrom = new Date(
            Date.parse(`${previousTo}T00:00:00.000Z`) -
              (Math.ceil(days) - 1) * 86_400_000,
          )
            .toISOString()
            .slice(0, 10);
          const previous = await openScope(
            actor,
            {
              fromLocalDate: previousFrom,
              toLocalDate: previousTo,
              granularity: request.granularity,
            },
            overviewMetrics,
          );
          comparisonView = {
            range: previous.range,
            metrics: overviewMetrics.flatMap((metricKey) =>
              readAggregate(metricKey, previous.scope),
            ),
          };
        }

        return {
          ...envelope(range),
          metrics,
          referrers,
          comparison: comparisonView,
          sources: sourceHealth(sourceStates, observedNow),
        };
      },

      async content({
        actor,
        range: request,
        limit = maximumPageSize,
      }: {
        actor: Actor;
        range: AnalyticsRangeRequest;
        limit?: number;
      }) {
        const { scope, range, sourceStates, observedNow } = await openScope(
          actor,
          request,
          ["content.page_views", ...contentVitalMetrics],
        );
        const appliedLimit = Math.min(
          Math.max(1, Math.trunc(limit)),
          maximumPageSize,
        );
        const subjectIds = subjectIdsFor(scope, [
          "content.page_views",
          ...contentVitalMetrics,
        ]);
        const items = subjectIds
          .map((subjectId) => {
            const readings = groupBySignature(
              totalsOnly(
                scope.facts.filter(
                  (fact) =>
                    fact.metricKey === "content.page_views" &&
                    fact.subjectId === subjectId,
                ),
              ),
            ).map((group) => buildReading(group, scope, subjectId));
            const vitals = groupBySignature(
              totalsOnly(
                scope.facts.filter(
                  (fact) =>
                    contentVitalMetrics.includes(
                      fact.metricKey as AnalyticsMetricKey,
                    ) && fact.subjectId === subjectId,
                ),
              ),
            ).map((group) => buildReading(group, scope, subjectId));
            return { subjectId, readings, vitals };
          })
          .sort(
            (left, right) =>
              Math.max(
                0,
                ...right.readings.map(
                  (reading) => readingValueOrNull(reading) ?? 0,
                ),
              ) -
              Math.max(
                0,
                ...left.readings.map(
                  (reading) => readingValueOrNull(reading) ?? 0,
                ),
              ),
          )
          .slice(0, appliedLimit);

        return {
          ...envelope(range),
          items,
          limit: appliedLimit,
          sources: sourceHealth(sourceStates, observedNow),
        };
      },

      async forms({
        actor,
        range: request,
      }: {
        actor: Actor;
        range: AnalyticsRangeRequest;
      }) {
        const { scope, range, sourceStates, observedNow } = await openScope(
          actor,
          request,
          formMetrics,
        );
        const items = subjectIdsFor(scope, formMetrics).map((subjectId) => {
          const readingFor = (metricKey: AnalyticsMetricKey) =>
            readSubject(metricKey, subjectId, scope)[0];
          const accepted = readingFor("form.submissions_accepted");
          const impressions = readingFor("interaction.form_impressions");
          const numerator = readingValueOrNull(accepted);
          const denominator = readingValueOrNull(impressions);
          const conversionRate: AnalyticsDerivedRatio = Object.freeze({
            metricKey: "form.conversion_rate" as const,
            definition:
              "Accepted submissions divided by best-effort form impressions. The denominator is not exact, so this is an estimate.",
            unit: "ratio" as const,
            quality: "estimated" as const,
            numeratorMetricKey: "form.submissions_accepted" as const,
            denominatorMetricKey: "interaction.form_impressions" as const,
            denominatorQuality:
              denominator === null ? null : impressions.quality,
            value:
              numerator === null || denominator === null || denominator === 0
                ? unavailableValue("not_measured")
                : availableValue(numerator / denominator),
          });
          return {
            subjectId,
            accepted,
            blocked: readingFor("form.submissions_blocked"),
            notificationsDelivered: readingFor(
              "form.notifications_delivered",
            ),
            notificationsFailed: readingFor("form.notifications_failed"),
            impressions,
            conversionRate,
          };
        });

        return {
          ...envelope(range),
          items,
          sources: sourceHealth(sourceStates, observedNow),
        };
      },

      async audience({
        actor,
        range: request,
      }: {
        actor: Actor;
        range: AnalyticsRangeRequest;
      }) {
        const { scope, range, sourceStates, observedNow } = await openScope(
          actor,
          request,
          audienceMetrics,
        );
        return {
          ...envelope(range),
          metrics: audienceMetrics.flatMap((metricKey) =>
            readAggregate(metricKey, scope),
          ),
          sources: sourceHealth(sourceStates, observedNow),
        };
      },

      async campaigns({
        actor,
        range: request,
        limit = maximumPageSize,
      }: {
        actor: Actor;
        range: AnalyticsRangeRequest;
        limit?: number;
      }) {
        const { scope, range, sourceStates, observedNow } = await openScope(
          actor,
          request,
          campaignMetrics,
        );
        const appliedLimit = Math.min(
          Math.max(1, Math.trunc(limit)),
          maximumPageSize,
        );
        const items = subjectIdsFor(scope, campaignMetrics)
          .map((subjectId) => {
            const subjectFacts = totalsOnly(
              scope.facts.filter((fact) => fact.subjectId === subjectId),
            );
            const allReadings = campaignMetrics.flatMap((metricKey) =>
              groupBySignature(
                subjectFacts.filter((fact) => fact.metricKey === metricKey),
              ).map((group) => buildReading(group, scope, subjectId)),
            );
            return {
              subjectId,
              readings: allReadings.filter(
                (reading) => reading.prominence !== "collapsed",
              ),
              collapsedEngagement: allReadings.filter(
                (reading) => reading.prominence === "collapsed",
              ),
              providerChanged:
                new Set(subjectFacts.map((fact) => fact.sourceName)).size > 1,
            };
          })
          .slice(0, appliedLimit);

        return {
          ...envelope(range),
          items,
          limit: appliedLimit,
          sources: sourceHealth(sourceStates, observedNow),
        };
      },

      async health({
        actor,
        range: request,
      }: {
        actor: Actor;
        range?: AnalyticsRangeRequest;
      }) {
        if (request === undefined) {
          await authorize(actor, analyticsReadCapability);
          const observedNow = now();
          const states = await store.listSourceStates();
          return {
            schemaVersion: analyticsSchemaVersion,
            siteId,
            range: null,
            sources: sourceHealth(states, observedNow),
            retention: analyticsRetention,
            earliestFactInstant: await store.earliestFactInstant(),
            disagreements: [],
          };
        }

        const { scope, range, sourceStates, observedNow } = await openScope(
          actor,
          request,
          crossSourceOutcomes.flatMap((entry) => entry.metricKeys),
        );
        const disagreements = crossSourceOutcomes.flatMap((entry) => {
          const readings = entry.metricKeys
            .flatMap((metricKey) => readAggregate(metricKey, scope))
            .filter((reading) => reading.value.state === "available");
          const sources = new Set(
            readings.map((reading) => `${reading.source}|${reading.sourceName}`),
          );
          const values = new Set(readings.map(readingValueOrNull));
          if (sources.size < 2 || values.size < 2) return [];
          return [
            {
              outcome: entry.outcome,
              readings: readings.map((reading) => ({
                metricKey: reading.metricKey,
                source: reading.source,
                sourceName: reading.sourceName,
                quality: reading.quality,
                value: reading.value,
              })),
            },
          ];
        });

        return {
          ...envelope(range),
          sources: sourceHealth(sourceStates, observedNow),
          retention: analyticsRetention,
          earliestFactInstant: await store.earliestFactInstant(),
          disagreements,
        };
      },
    }),
  };
}

export type AnalyticsQueryApplication<Actor = unknown> = ReturnType<
  typeof createAnalyticsQueryApplication<Actor>
>;

type ViewOf<Name extends keyof AnalyticsQueryApplication["queries"]> = Awaited<
  ReturnType<AnalyticsQueryApplication["queries"][Name]>
>;

export type AnalyticsOverviewView = ViewOf<"overview">;
export type AnalyticsContentView = ViewOf<"content">;
export type AnalyticsFormsView = ViewOf<"forms">;
export type AnalyticsAudienceView = ViewOf<"audience">;
export type AnalyticsCampaignsView = ViewOf<"campaigns">;
export type AnalyticsHealthView = ViewOf<"health">;

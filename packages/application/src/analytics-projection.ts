/**
 * Normalizes one source run into the canonical D1 aggregate projection.
 *
 * Every declared source — Cloudflare Web Analytics, Workers Analytics Engine,
 * D1 operational tables and the newsletter provider — reaches the read model
 * through this seam, so the vocabulary, privacy and comparability rules are
 * enforced once instead of once per adapter.
 */

import type { SiteId } from "@foundry/site-definition";

import {
  addUtcDays,
  analyticsCompositeKey,
  analyticsMetricDefinition,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricKey,
  analyticsSchemaVersion,
  assertAggregateAnalyticsPayload,
  comparabilitySignature,
  earliestInstant,
  isAllowedAnalyticsDimension,
  isSourceGapReason,
  subtractUtcMonths,
  utcDayStart,
  type AnalyticsDimension,
  type AnalyticsGranularity,
  type AnalyticsQuality,
  type AnalyticsSource,
  type AnalyticsSourceState,
  type AnalyticsSourceStatus,
  type AnalyticsSubjectType,
  type AnalyticsUnavailableReason,
  type AnalyticsUnit,
} from "./analytics-model";

export type AnalyticsProjectionErrorCode =
  | "source_does_not_own_metric"
  | "subject_type_not_declared"
  | "unit_not_declared"
  | "dimension_not_allowed"
  | "subject_id_invalid"
  | "value_and_reason_conflict"
  | "value_invalid"
  | "bucket_invalid"
  | "sample_interval_invalid"
  | "revision_invalid"
  | "source_name_invalid"
  | "error_code_invalid";

export class AnalyticsProjectionError extends Error {
  readonly code: AnalyticsProjectionErrorCode;
  readonly metricKey: string | null;

  constructor(
    code: AnalyticsProjectionErrorCode,
    metricKey: string | null = null,
  ) {
    super(
      metricKey === null
        ? `The analytics projection refused the run: ${code}.`
        : `The analytics projection refused "${metricKey}": ${code}.`,
    );
    this.name = "AnalyticsProjectionError";
    this.code = code;
    this.metricKey = metricKey;
  }
}

export type AnalyticsFactMeasurement = Readonly<{
  metricKey: string;
  bucketStartUtc: string;
  bucketEndUtc: string;
  granularity: AnalyticsGranularity;
  subjectType: AnalyticsSubjectType;
  subjectId: string;
  dimension: AnalyticsDimension;
  unit: AnalyticsUnit;
  quality: AnalyticsQuality;
  /**
   * The platform sampling weight already applied to `value`. Analytics Engine
   * points are weighted by `_sample_interval` before they arrive here.
   */
  sampleInterval: number;
  value: number | null;
  unavailableReason: AnalyticsUnavailableReason | null;
}>;

export type StoredAnalyticsFact = Readonly<{
  siteId: SiteId;
  schemaVersion: typeof analyticsSchemaVersion;
  metricKey: AnalyticsMetricKey;
  bucketStartUtc: string;
  bucketEndUtc: string;
  granularity: AnalyticsGranularity;
  subjectType: AnalyticsSubjectType;
  subjectId: string;
  dimensionKey: string;
  dimensionValue: string;
  source: AnalyticsSource;
  sourceName: string;
  sourceMetric: string;
  definitionVersion: number;
  unit: AnalyticsUnit;
  quality: AnalyticsQuality;
  sampleInterval: number;
  availability: "available" | "unavailable";
  value: number | null;
  unavailableReason: AnalyticsUnavailableReason | null;
  observedAt: string;
  completeThrough: string;
  revision: number;
}>;

export type AnalyticsFactRevisionRecord = Readonly<{
  factKey: string;
  siteId: SiteId;
  metricKey: AnalyticsMetricKey;
  bucketStartUtc: string;
  granularity: AnalyticsGranularity;
  subjectType: AnalyticsSubjectType;
  subjectId: string;
  source: AnalyticsSource;
  sourceName: string;
  previousRevision: number;
  previousValue: number | null;
  previousAvailability: "available" | "unavailable";
  nextRevision: number;
  nextValue: number | null;
  nextAvailability: "available" | "unavailable";
  supersededAt: string;
}>;

/** The tuple that names one fact. Nothing outside it may vary a fact's row. */
export type AnalyticsFactIdentity = Pick<
  StoredAnalyticsFact,
  | "siteId"
  | "metricKey"
  | "bucketStartUtc"
  | "granularity"
  | "subjectType"
  | "subjectId"
  | "dimensionKey"
  | "dimensionValue"
  | "source"
  | "sourceName"
>;

export type AnalyticsProjectionStore = Readonly<{
  findCurrentSourceState(input: {
    source: AnalyticsSource;
    sourceName: string;
  }): Promise<AnalyticsSourceState | null>;
  findFacts(
    identities: ReadonlyArray<AnalyticsFactIdentity>,
  ): Promise<ReadonlyArray<StoredAnalyticsFact>>;
  /** Applies facts, revision audit rows and source state as one transaction. */
  commitProjection(input: {
    facts: ReadonlyArray<StoredAnalyticsFact>;
    revisions: ReadonlyArray<AnalyticsFactRevisionRecord>;
    sourceState: AnalyticsSourceState;
  }): Promise<void>;
  listFactsForCompaction(input: {
    before: string;
  }): Promise<ReadonlyArray<StoredAnalyticsFact>>;
  /** Writes daily replacements and removes their covered hours atomically. */
  commitCompaction(input: {
    dailyFacts: ReadonlyArray<StoredAnalyticsFact>;
    removedFacts: ReadonlyArray<StoredAnalyticsFact>;
  }): Promise<void>;
  /** Removes facts and revision audit rows that have passed retention. */
  purgeExpiredFacts(input: {
    before: string;
  }): Promise<AnalyticsPurgeOutcome>;
}>;

export type AnalyticsPurgeOutcome = Readonly<{
  factsRemoved: number;
  revisionsRemoved: number;
}>;

export type AnalyticsMeasuredRun = Readonly<{
  outcome?: "measured";
  source: AnalyticsSource;
  sourceName: string;
  sourceMetric: string;
  definitionVersion: number;
  revision: number;
  observedAt: string;
  completeThrough: string;
  facts: ReadonlyArray<AnalyticsFactMeasurement>;
}>;

export type AnalyticsDegradedRun = Readonly<{
  outcome: "unavailable" | "delayed";
  source: AnalyticsSource;
  sourceName: string;
  definitionVersion: number;
  errorCode: string;
  attemptedAt: string;
  nextRetryAt: string | null;
}>;

export type AnalyticsProjectionRun = AnalyticsMeasuredRun | AnalyticsDegradedRun;

export type AnalyticsCompactionOutcome = Readonly<{
  dailyFactsWritten: number;
  hourlyFactsRemoved: number;
  /** Days whose source already wrote the daily fact, so only hours were removed. */
  daysAlreadyDaily: number;
  daysSkippedForComparability: number;
  daysSkippedForMixedAvailability: number;
}>;

const subjectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const errorCodePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const sourceNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const hourSeconds = 3_600;
const daySeconds = 86_400;

/** A comparable string form of the identity tuple, for in-memory grouping. */
export function analyticsFactKey(fact: AnalyticsFactIdentity): string {
  return analyticsCompositeKey([
    fact.siteId,
    fact.metricKey,
    fact.bucketStartUtc,
    fact.granularity,
    fact.subjectType,
    fact.subjectId,
    fact.dimensionKey,
    fact.dimensionValue,
    fact.source,
    fact.sourceName,
  ]);
}

export function factIdentity(
  fact: AnalyticsFactIdentity,
): AnalyticsFactIdentity {
  return {
    siteId: fact.siteId,
    metricKey: fact.metricKey,
    bucketStartUtc: fact.bucketStartUtc,
    granularity: fact.granularity,
    subjectType: fact.subjectType,
    subjectId: fact.subjectId,
    dimensionKey: fact.dimensionKey,
    dimensionValue: fact.dimensionValue,
    source: fact.source,
    sourceName: fact.sourceName,
  };
}

function bucketSpanSeconds(fact: AnalyticsFactMeasurement): number {
  return (
    (Date.parse(fact.bucketEndUtc) - Date.parse(fact.bucketStartUtc)) / 1_000
  );
}

/** Returns the registry entry the measurement satisfies, or refuses it. */
function assertValidMeasurement(
  measurement: AnalyticsFactMeasurement,
  source: AnalyticsSource,
): AnalyticsMetricDefinition {
  const definition = analyticsMetricDefinition(measurement.metricKey);
  const refuse = (code: AnalyticsProjectionErrorCode) => {
    throw new AnalyticsProjectionError(code, measurement.metricKey);
  };

  if (definition.source !== source) refuse("source_does_not_own_metric");
  if (!definition.subjectTypes.includes(measurement.subjectType)) {
    refuse("subject_type_not_declared");
  }
  if (definition.unit !== measurement.unit) refuse("unit_not_declared");
  if (!isAllowedAnalyticsDimension(measurement.dimension)) {
    refuse("dimension_not_allowed");
  }
  if (!subjectIdPattern.test(measurement.subjectId)) {
    refuse("subject_id_invalid");
  }

  const hasValue = measurement.value !== null;
  const hasReason = measurement.unavailableReason !== null;
  if (hasValue === hasReason) refuse("value_and_reason_conflict");
  if (hasValue) {
    const value = measurement.value as number;
    if (!Number.isFinite(value)) refuse("value_invalid");
    if (value < 0 && definition.valueDomain !== "signed") {
      refuse("value_invalid");
    }
    if (measurement.unit === "count" && !Number.isInteger(value)) {
      refuse("value_invalid");
    }
  }

  const span = bucketSpanSeconds(measurement);
  if (!Number.isFinite(span) || span <= 0) refuse("bucket_invalid");
  if (measurement.granularity === "hour" && span !== hourSeconds) {
    refuse("bucket_invalid");
  }
  if (measurement.granularity === "day" && span !== daySeconds) {
    refuse("bucket_invalid");
  }
  if (
    !Number.isInteger(measurement.sampleInterval) ||
    measurement.sampleInterval < 1
  ) {
    refuse("sample_interval_invalid");
  }
  return definition;
}

function isMaterialChange(
  previous: StoredAnalyticsFact,
  next: StoredAnalyticsFact,
): boolean {
  return (
    previous.value !== next.value ||
    previous.availability !== next.availability ||
    previous.unavailableReason !== next.unavailableReason ||
    previous.quality !== next.quality ||
    previous.sourceMetric !== next.sourceMetric ||
    previous.definitionVersion !== next.definitionVersion
  );
}

function isDegradedRun(
  run: AnalyticsProjectionRun,
): run is AnalyticsDegradedRun {
  return run.outcome === "unavailable" || run.outcome === "delayed";
}

export function createAnalyticsProjection({
  siteId,
  store,
  now = () => new Date().toISOString(),
}: {
  siteId: SiteId;
  store: AnalyticsProjectionStore;
  now?: () => string;
}) {
  async function projectMeasuredRun(run: AnalyticsMeasuredRun): Promise<void> {
    if (!Number.isInteger(run.revision) || run.revision < 1) {
      throw new AnalyticsProjectionError("revision_invalid");
    }
    if (!sourceNamePattern.test(run.sourceName)) {
      throw new AnalyticsProjectionError("source_name_invalid");
    }
    const definitions = run.facts.map((measurement) =>
      assertValidMeasurement(measurement, run.source),
    );

    const candidates: ReadonlyArray<StoredAnalyticsFact> = run.facts.map(
      (measurement, index) => ({
        siteId,
        schemaVersion: analyticsSchemaVersion,
        metricKey: definitions[index].metricKey,
        bucketStartUtc: measurement.bucketStartUtc,
        bucketEndUtc: measurement.bucketEndUtc,
        granularity: measurement.granularity,
        subjectType: measurement.subjectType,
        subjectId: measurement.subjectId,
        dimensionKey: measurement.dimension.key,
        dimensionValue: measurement.dimension.value,
        source: run.source,
        sourceName: run.sourceName,
        sourceMetric: run.sourceMetric,
        definitionVersion: run.definitionVersion,
        unit: measurement.unit,
        quality: measurement.quality,
        sampleInterval: measurement.sampleInterval,
        availability:
          measurement.value === null ? "unavailable" : "available",
        value: measurement.value,
        unavailableReason: measurement.unavailableReason,
        observedAt: run.observedAt,
        completeThrough: run.completeThrough,
        revision: run.revision,
      }),
    );

    const existing = new Map(
      (await store.findFacts(candidates.map(factIdentity))).map((fact) => [
        analyticsFactKey(fact),
        fact,
      ]),
    );

    const facts: StoredAnalyticsFact[] = [];
    const revisions: AnalyticsFactRevisionRecord[] = [];
    for (const candidate of candidates) {
      const key = analyticsFactKey(candidate);
      const previous = existing.get(key);
      if (previous !== undefined && candidate.revision <= previous.revision) {
        continue;
      }
      facts.push(candidate);
      if (previous !== undefined && isMaterialChange(previous, candidate)) {
        revisions.push({
          factKey: key,
          siteId,
          metricKey: candidate.metricKey,
          bucketStartUtc: candidate.bucketStartUtc,
          granularity: candidate.granularity,
          subjectType: candidate.subjectType,
          subjectId: candidate.subjectId,
          source: candidate.source,
          sourceName: candidate.sourceName,
          previousRevision: previous.revision,
          previousValue: previous.value,
          previousAvailability: previous.availability,
          nextRevision: candidate.revision,
          nextValue: candidate.value,
          nextAvailability: candidate.availability,
          supersededAt: now(),
        });
      }
    }

    const previousState = await store.findCurrentSourceState({
      source: run.source,
      sourceName: run.sourceName,
    });
    const reportedIsBehind =
      previousState?.completeThrough != null &&
      Date.parse(run.completeThrough) <
        Date.parse(previousState.completeThrough);
    // A measurement the source was asked for and could not give back is a
    // gap. A measurement that is legitimately absent — a browser reporting no
    // Web Vitals, a capability the provider never claimed — is not, or a
    // healthy source would report `partial` for ever.
    const anyGap = candidates.some(
      (fact) =>
        fact.availability === "unavailable" &&
        isSourceGapReason(fact.unavailableReason),
    );
    const status: AnalyticsSourceStatus =
      reportedIsBehind || anyGap ? "partial" : "healthy";

    await store.commitProjection({
      facts,
      revisions,
      sourceState: {
        source: run.source,
        sourceName: run.sourceName,
        status,
        lastAttemptAt: run.observedAt,
        lastSuccessAt: run.observedAt,
        completeThrough: reportedIsBehind
          ? (previousState?.completeThrough ?? run.completeThrough)
          : run.completeThrough,
        nextRetryAt: null,
        errorCode: null,
        definitionVersion: run.definitionVersion,
      },
    });
  }

  async function projectDegradedRun(run: AnalyticsDegradedRun): Promise<void> {
    if (!sourceNamePattern.test(run.sourceName)) {
      throw new AnalyticsProjectionError("source_name_invalid");
    }
    if (!errorCodePattern.test(run.errorCode)) {
      throw new AnalyticsProjectionError("error_code_invalid");
    }
    const previousState = await store.findCurrentSourceState({
      source: run.source,
      sourceName: run.sourceName,
    });
    await store.commitProjection({
      facts: [],
      revisions: [],
      sourceState: {
        source: run.source,
        sourceName: run.sourceName,
        status: run.outcome,
        lastAttemptAt: run.attemptedAt,
        lastSuccessAt: previousState?.lastSuccessAt ?? null,
        completeThrough: previousState?.completeThrough ?? null,
        nextRetryAt: run.nextRetryAt,
        errorCode: run.errorCode,
        definitionVersion: run.definitionVersion,
      },
    });
  }

  return Object.freeze({
    /**
     * Applies one source run. A degraded run records the outage and leaves the
     * previously projected facts and completeness untouched, so a temporary
     * source failure never reads as a drop to zero.
     */
    async project(run: AnalyticsProjectionRun): Promise<void> {
      assertAggregateAnalyticsPayload(run);
      if (isDegradedRun(run)) {
        await projectDegradedRun(run);
        return;
      }
      await projectMeasuredRun(run);
    },

    /**
     * Rolls closed hourly facts into daily facts once they leave the hourly
     * retention window. A day whose hours do not share one measurement
     * definition, or that mixes measured and unavailable hours, is reported
     * rather than merged, because either merge would invent a number.
     */
    async compact({
      hourlyRetentionDays,
    }: {
      hourlyRetentionDays: number;
    }): Promise<AnalyticsCompactionOutcome> {
      const cutoff = addUtcDays(now(), -hourlyRetentionDays);
      const hourly = (
        await store.listFactsForCompaction({ before: cutoff })
      ).filter(
        (fact) =>
          fact.granularity === "hour" &&
          Date.parse(fact.bucketEndUtc) <= Date.parse(cutoff),
      );

      const days = new Map<string, StoredAnalyticsFact[]>();
      for (const fact of hourly) {
        const dayStart = utcDayStart(fact.bucketStartUtc);
        const key = analyticsFactKey({ ...fact, bucketStartUtc: dayStart });
        const group = days.get(key);
        if (group === undefined) days.set(key, [fact]);
        else group.push(fact);
      }

      const dailyFacts: StoredAnalyticsFact[] = [];
      const removedFacts: StoredAnalyticsFact[] = [];
      let daysSkippedForComparability = 0;
      let daysSkippedForMixedAvailability = 0;
      let daysAlreadyDaily = 0;

      const mergeable: Array<ReadonlyArray<StoredAnalyticsFact>> = [];
      for (const group of days.values()) {
        const signatures = new Set(
          group.map((fact) => comparabilitySignature(fact)),
        );
        if (signatures.size > 1) {
          daysSkippedForComparability += 1;
          continue;
        }
        const availabilities = new Set(group.map((fact) => fact.availability));
        if (availabilities.size > 1) {
          daysSkippedForMixedAvailability += 1;
          continue;
        }
        mergeable.push(group);
      }

      // A source that reports both hours and days already wrote the day, and
      // its own total is the authoritative one. Recomputing the day from its
      // hours could disagree with it, and the revision guard would drop the
      // rewrite anyway while the hours were deleted. So the hours are removed
      // and the source's daily fact is left alone.
      const existingDaily = new Set(
        (
          await store.findFacts(
            mergeable.map((group) =>
              factIdentity({
                ...group[0],
                granularity: "day",
                bucketStartUtc: utcDayStart(group[0].bucketStartUtc),
              }),
            ),
          )
        ).map((fact) => analyticsFactKey(fact)),
      );

      for (const group of mergeable) {
        const first = group[0];
        const dayStart = utcDayStart(first.bucketStartUtc);
        const dayKey = analyticsFactKey({
          ...first,
          granularity: "day",
          bucketStartUtc: dayStart,
        });
        removedFacts.push(...group);
        if (existingDaily.has(dayKey)) {
          daysAlreadyDaily += 1;
          continue;
        }
        const measured = first.availability === "available";
        dailyFacts.push({
          ...first,
          granularity: "day",
          bucketStartUtc: dayStart,
          bucketEndUtc: addUtcDays(dayStart, 1),
          value: measured
            ? group.reduce((total, fact) => total + (fact.value ?? 0), 0)
            : null,
          observedAt: earliestInstant(group.map((fact) => fact.observedAt)),
          completeThrough: earliestInstant(
            group.map((fact) => fact.completeThrough),
          ),
          revision: Math.max(...group.map((fact) => fact.revision)),
        });
      }

      if (dailyFacts.length > 0 || removedFacts.length > 0) {
        await store.commitCompaction({ dailyFacts, removedFacts });
      }

      return {
        dailyFactsWritten: dailyFacts.length,
        hourlyFactsRemoved: removedFacts.length,
        daysAlreadyDaily,
        daysSkippedForComparability,
        daysSkippedForMixedAvailability,
      };
    },

    /**
     * Removes facts whose bucket closed before the retention floor, along with
     * their revision audit rows. ADR-0003 keeps aggregate facts for 25 months;
     * the read side clamps a range beyond that, and this is what makes the
     * clamp true of the stored data as well.
     */
    async purge({
      aggregateFactMonths,
    }: {
      aggregateFactMonths: number;
    }): Promise<AnalyticsPurgeOutcome> {
      return store.purgeExpiredFacts({
        before: subtractUtcMonths(now(), aggregateFactMonths),
      });
    },
  });
}

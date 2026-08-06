import {
  type AnalyticsProjectionStore,
  type AnalyticsReadStore,
  type AnalyticsSourceState,
  type StoredAnalyticsFact,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type FactRow = {
  site_id: string;
  schema_version: string;
  metric_key: string;
  bucket_start_utc: string;
  bucket_end_utc: string;
  granularity: string;
  subject_type: string;
  subject_id: string;
  dimension_key: string;
  dimension_value: string;
  source: string;
  source_name: string;
  source_metric: string;
  definition_version: number;
  unit: string;
  quality: string;
  sample_interval: number;
  availability: string;
  value: number | null;
  unavailable_reason: string | null;
  observed_at: string;
  complete_through: string;
  revision: number;
};

type SourceStateRow = {
  source: string;
  source_name: string;
  status: string;
  last_attempt_at: string;
  last_success_at: string | null;
  complete_through: string | null;
  next_retry_at: string | null;
  error_code: string | null;
  definition_version: number;
};

/**
 * D1 allows at most 100 bound parameters per statement, and one fact identity
 * binds ten, so identity lookups are read in chunks of ten.
 */
const identityColumns = 10;
const identitiesPerStatement = 10;

const factColumns = `site_id, schema_version, metric_key, bucket_start_utc,
  bucket_end_utc, granularity, subject_type, subject_id, dimension_key,
  dimension_value, source, source_name, source_metric, definition_version,
  unit, quality, sample_interval, availability, value, unavailable_reason,
  observed_at, complete_through, revision`;

function toFact(row: FactRow): StoredAnalyticsFact {
  return {
    siteId: row.site_id as SiteId,
    schemaVersion: row.schema_version as StoredAnalyticsFact["schemaVersion"],
    metricKey: row.metric_key as StoredAnalyticsFact["metricKey"],
    bucketStartUtc: row.bucket_start_utc,
    bucketEndUtc: row.bucket_end_utc,
    granularity: row.granularity as StoredAnalyticsFact["granularity"],
    subjectType: row.subject_type as StoredAnalyticsFact["subjectType"],
    subjectId: row.subject_id,
    dimensionKey: row.dimension_key,
    dimensionValue: row.dimension_value,
    source: row.source as StoredAnalyticsFact["source"],
    sourceName: row.source_name,
    sourceMetric: row.source_metric,
    definitionVersion: row.definition_version,
    unit: row.unit as StoredAnalyticsFact["unit"],
    quality: row.quality as StoredAnalyticsFact["quality"],
    sampleInterval: row.sample_interval,
    availability: row.availability as StoredAnalyticsFact["availability"],
    value: row.value,
    unavailableReason:
      row.unavailable_reason as StoredAnalyticsFact["unavailableReason"],
    observedAt: row.observed_at,
    completeThrough: row.complete_through,
    revision: row.revision,
  };
}

function toSourceState(row: SourceStateRow): AnalyticsSourceState {
  return {
    source: row.source as AnalyticsSourceState["source"],
    sourceName: row.source_name,
    status: row.status as AnalyticsSourceState["status"],
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    completeThrough: row.complete_through,
    nextRetryAt: row.next_retry_at,
    errorCode: row.error_code,
    definitionVersion: row.definition_version,
  };
}

function factParameters(fact: StoredAnalyticsFact) {
  return [
    fact.siteId,
    fact.schemaVersion,
    fact.metricKey,
    fact.bucketStartUtc,
    fact.bucketEndUtc,
    fact.granularity,
    fact.subjectType,
    fact.subjectId,
    fact.dimensionKey,
    fact.dimensionValue,
    fact.source,
    fact.sourceName,
    fact.sourceMetric,
    fact.definitionVersion,
    fact.unit,
    fact.quality,
    fact.sampleInterval,
    fact.availability,
    fact.value,
    fact.unavailableReason,
    fact.observedAt,
    fact.completeThrough,
    fact.revision,
  ];
}

/**
 * The only D1 gateway for the aggregate projection. Facts, their revision
 * audit and source health move together in one batch so a partial write can
 * never leave the dashboard reporting completeness it does not have.
 */
export function createD1AnalyticsStore(
  database: D1DatabaseBinding,
  siteId: SiteId,
): AnalyticsProjectionStore & AnalyticsReadStore {
  function upsertFactStatement(fact: StoredAnalyticsFact) {
    return database
      .prepare(
        `INSERT INTO analytics_facts (${factColumns})
         VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
         )
         ON CONFLICT (
           site_id, metric_key, bucket_start_utc, granularity,
           subject_type, subject_id, dimension_key, dimension_value,
           source, source_name
         ) DO UPDATE SET
           bucket_end_utc = excluded.bucket_end_utc,
           source_metric = excluded.source_metric,
           definition_version = excluded.definition_version,
           unit = excluded.unit,
           quality = excluded.quality,
           sample_interval = excluded.sample_interval,
           availability = excluded.availability,
           value = excluded.value,
           unavailable_reason = excluded.unavailable_reason,
           observed_at = excluded.observed_at,
           complete_through = excluded.complete_through,
           revision = excluded.revision
         WHERE excluded.revision > analytics_facts.revision`,
      )
      .bind(...factParameters(fact));
  }

  return {
    async findCurrentSourceState({ source, sourceName }) {
      const row = await database
        .prepare(
          `SELECT source, source_name, status, last_attempt_at,
                  last_success_at, complete_through, next_retry_at,
                  error_code, definition_version
           FROM analytics_source_state
           WHERE source = ?1 AND source_name = ?2`,
        )
        .bind(source, sourceName)
        .first<SourceStateRow>();
      return row === null ? null : toSourceState(row);
    },

    async findFacts(identities) {
      if (identities.length === 0) return [];
      // SQLite row values let one indexed statement fetch the exact identity
      // tuples a projector run touches, rather than scanning the site.
      const chunks: Array<typeof identities> = [];
      for (
        let start = 0;
        start < identities.length;
        start += identitiesPerStatement
      ) {
        chunks.push(identities.slice(start, start + identitiesPerStatement));
      }
      const statements = chunks.map((chunk) =>
        database
          .prepare(
            `SELECT ${factColumns} FROM analytics_facts
             WHERE (
               site_id, metric_key, bucket_start_utc, granularity,
               subject_type, subject_id, dimension_key, dimension_value,
               source, source_name
             ) IN (VALUES ${chunk
               .map(
                 (_identity, index) =>
                   `(${Array.from(
                     { length: identityColumns },
                     (_column, offset) =>
                       `?${index * identityColumns + offset + 1}`,
                   ).join(", ")})`,
               )
               .join(", ")})`,
          )
          .bind(
            ...chunk.flatMap((identity) => [
              identity.siteId,
              identity.metricKey,
              identity.bucketStartUtc,
              identity.granularity,
              identity.subjectType,
              identity.subjectId,
              identity.dimensionKey,
              identity.dimensionValue,
              identity.source,
              identity.sourceName,
            ]),
          ),
      );
      const pages = await Promise.all(
        statements.map((statement) => statement.all<FactRow>()),
      );
      return pages.flatMap((page) => page.results.map(toFact));
    },

    async commitProjection({ facts, revisions, sourceState }) {
      await database.batch([
        ...facts.map(upsertFactStatement),
        ...revisions.map((revision) =>
          database
            .prepare(
              `INSERT INTO analytics_fact_revisions (
                 fact_key, site_id, metric_key, bucket_start_utc, granularity,
                 subject_type, subject_id, source, source_name,
                 previous_revision, previous_value, previous_availability,
                 next_revision, next_value, next_availability, superseded_at
               )
               VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16
               )`,
            )
            .bind(
              revision.factKey,
              revision.siteId,
              revision.metricKey,
              revision.bucketStartUtc,
              revision.granularity,
              revision.subjectType,
              revision.subjectId,
              revision.source,
              revision.sourceName,
              revision.previousRevision,
              revision.previousValue,
              revision.previousAvailability,
              revision.nextRevision,
              revision.nextValue,
              revision.nextAvailability,
              revision.supersededAt,
            ),
        ),
        database
          .prepare(
            `INSERT INTO analytics_source_state (
               source, source_name, status, last_attempt_at, last_success_at,
               complete_through, next_retry_at, error_code, definition_version
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (source, source_name) DO UPDATE SET
               status = excluded.status,
               last_attempt_at = excluded.last_attempt_at,
               last_success_at = excluded.last_success_at,
               complete_through = excluded.complete_through,
               next_retry_at = excluded.next_retry_at,
               error_code = excluded.error_code,
               definition_version = excluded.definition_version`,
          )
          .bind(
            sourceState.source,
            sourceState.sourceName,
            sourceState.status,
            sourceState.lastAttemptAt,
            sourceState.lastSuccessAt,
            sourceState.completeThrough,
            sourceState.nextRetryAt,
            sourceState.errorCode,
            sourceState.definitionVersion,
          ),
      ]);
    },

    async listFactsForCompaction({ before }) {
      const { results } = await database
        .prepare(
          `SELECT ${factColumns} FROM analytics_facts
           WHERE site_id = ?1
             AND granularity = 'hour'
             AND bucket_end_utc <= ?2
           ORDER BY bucket_start_utc`,
        )
        .bind(siteId, before)
        .all<FactRow>();
      return results.map(toFact);
    },

    async commitCompaction({ dailyFacts, removedFacts }) {
      await database.batch([
        ...dailyFacts.map(upsertFactStatement),
        ...removedFacts.map((fact) =>
          database
            .prepare(
              `DELETE FROM analytics_facts
               WHERE site_id = ?1
                 AND metric_key = ?2
                 AND bucket_start_utc = ?3
                 AND granularity = ?4
                 AND subject_type = ?5
                 AND subject_id = ?6
                 AND dimension_key = ?7
                 AND dimension_value = ?8
                 AND source = ?9
                 AND source_name = ?10`,
            )
            .bind(
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
            ),
        ),
      ]);
    },

    async listFacts({ metricKeys, granularity, startUtc, endUtc }) {
      if (metricKeys.length === 0) return [];
      const placeholders = metricKeys
        .map((_key, index) => `?${index + 5}`)
        .join(", ");
      const { results } = await database
        .prepare(
          `SELECT ${factColumns} FROM analytics_facts
           WHERE site_id = ?1
             AND granularity = ?2
             AND bucket_start_utc >= ?3
             AND bucket_start_utc < ?4
             AND metric_key IN (${placeholders})
           ORDER BY metric_key, subject_id, source_name, bucket_start_utc`,
        )
        .bind(siteId, granularity, startUtc, endUtc, ...metricKeys)
        .all<FactRow>();
      return results.map(toFact);
    },

    async listSourceStates() {
      const { results } = await database
        .prepare(
          `SELECT source, source_name, status, last_attempt_at,
                  last_success_at, complete_through, next_retry_at,
                  error_code, definition_version
           FROM analytics_source_state
           ORDER BY source, source_name`,
        )
        .all<SourceStateRow>();
      return results.map(toSourceState);
    },

    async earliestFactInstant() {
      const row = await database
        .prepare(
          `SELECT MIN(bucket_start_utc) AS earliest
           FROM analytics_facts WHERE site_id = ?1`,
        )
        .bind(siteId)
        .first<{ earliest: string | null }>();
      return row?.earliest ?? null;
    },

    /**
     * Deletes facts and their revision audit rows once they pass the retention
     * floor. Without this the read side clamps a range it can no longer honour
     * while the rows stay in D1, and the revision table grows without limit.
     */
    async purgeExpiredFacts({ before }) {
      const [factResult, revisionResult] = await database.batch([
        database
          .prepare(
            `DELETE FROM analytics_facts
             WHERE site_id = ?1 AND bucket_end_utc <= ?2`,
          )
          .bind(siteId, before),
        database
          .prepare(
            `DELETE FROM analytics_fact_revisions
             WHERE site_id = ?1 AND bucket_start_utc < ?2`,
          )
          .bind(siteId, before),
      ]);
      return {
        factsRemoved: factResult?.meta.changes ?? 0,
        revisionsRemoved: revisionResult?.meta.changes ?? 0,
      };
    },
  };
}

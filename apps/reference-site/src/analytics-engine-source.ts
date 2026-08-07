import "server-only";

import type { AnalyticsFactMeasurement } from "@foundry/application";

/**
 * Workers Analytics Engine supplies the one thing Web Analytics cannot:
 * anonymous counts of the interactions the CMS defines.
 *
 * It is best-effort. A dropped event can leave an aggregate interaction count
 * incomplete. It cannot affect an accepted form, a consent record or a send,
 * because none of those depends on Analytics Engine.
 *
 * Contract: https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
 */

export const analyticsEngineSourceName = "cloudflare";
export const analyticsEngineDefinitionVersion = 1;

/** The only interactions a browser may report. Anything else is refused. */
export const allowedInteractionKinds = Object.freeze({
  form_impression: {
    metricKey: "interaction.form_impressions",
    subjectType: "form" as const,
  },
  cta_activation: {
    metricKey: "interaction.cta_activations",
    subjectType: "cta" as const,
  },
});

export type InteractionKind = keyof typeof allowedInteractionKinds;

const subjectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class AnalyticsEngineSourceError extends Error {
  readonly code:
    | "event_kind_not_allowed"
    | "subject_id_invalid"
    | "row_invalid"
    | "query_invalid"
    | "query_failed";

  constructor(code: AnalyticsEngineSourceError["code"]) {
    super(`The Analytics Engine source was refused: ${code}.`);
    this.name = "AnalyticsEngineSourceError";
    this.code = code;
  }
}

/**
 * Analytics Engine is the only source with per-event timestamps, so it is the
 * one that can report hours. It is also the shortest-lived: Cloudflare keeps
 * its points for three months, which is why each run projects hourly facts as
 * well as daily ones. The hourly facts hold intraday detail for the 90 days
 * ADR-0003 allows, then compaction rolls them away and the daily facts carry
 * the history past Analytics Engine's own retention.
 */
export type AnalyticsEngineBucketGranularity = "hour" | "day";

export type AnalyticsEngineRow = Readonly<{
  /** `YYYY-MM-DD` for a day bucket, `YYYY-MM-DD HH:00:00` for an hour. */
  bucket_start: string;
  event_kind: string;
  subject_id: string;
  /** Already multiplied by `_sample_interval` in the SQL projection. */
  weighted_count: number;
  sample_interval: number;
}>;

export function isInteractionKind(value: string): value is InteractionKind {
  return Object.hasOwn(allowedInteractionKinds, value);
}

const dayBucketPattern = /^\d{4}-\d{2}-\d{2}$/u;
const hourBucketPattern = /^\d{4}-\d{2}-\d{2} \d{2}:00:00$/u;

function bucketInstants(
  bucketStart: string,
  granularity: AnalyticsEngineBucketGranularity,
): Readonly<{ bucketStartUtc: string; bucketEndUtc: string }> {
  const spanMs = granularity === "hour" ? 3_600_000 : 86_400_000;
  const matchesShape =
    granularity === "hour"
      ? hourBucketPattern.test(bucketStart)
      : dayBucketPattern.test(bucketStart);
  if (!matchesShape) {
    throw new AnalyticsEngineSourceError("row_invalid");
  }
  const bucketStartUtc =
    granularity === "hour"
      ? `${bucketStart.replace(" ", "T")}.000Z`
      : `${bucketStart}T00:00:00.000Z`;
  const parsed = Date.parse(bucketStartUtc);
  if (Number.isNaN(parsed)) {
    throw new AnalyticsEngineSourceError("row_invalid");
  }
  return {
    bucketStartUtc,
    bucketEndUtc: new Date(parsed + spanMs).toISOString(),
  };
}

/**
 * Turns weighted Analytics Engine rows into best-effort measurements. The SQL
 * applies the weighting, and each measurement includes its sampling interval,
 * so a reader can see how heavily an estimate was sampled.
 */
export function normalizeAnalyticsEngineRows(
  rows: ReadonlyArray<AnalyticsEngineRow>,
  granularity: AnalyticsEngineBucketGranularity = "day",
): ReadonlyArray<AnalyticsFactMeasurement> {
  return rows.map((row) => {
    if (!isInteractionKind(row.event_kind)) {
      throw new AnalyticsEngineSourceError("event_kind_not_allowed");
    }
    if (!subjectIdPattern.test(row.subject_id)) {
      throw new AnalyticsEngineSourceError("subject_id_invalid");
    }
    if (
      !Number.isFinite(row.weighted_count) ||
      row.weighted_count < 0 ||
      !Number.isInteger(row.sample_interval) ||
      row.sample_interval < 1
    ) {
      throw new AnalyticsEngineSourceError("row_invalid");
    }
    const declared = allowedInteractionKinds[row.event_kind];
    return {
      metricKey: declared.metricKey,
      ...bucketInstants(row.bucket_start, granularity),
      granularity,
      subjectType: declared.subjectType,
      subjectId: row.subject_id,
      dimension: { key: "", value: "" },
      unit: "count" as const,
      quality: "best_effort" as const,
      sampleInterval: row.sample_interval,
      value: Math.round(row.weighted_count),
      unavailableReason: null,
    };
  });
}

const datasetPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/**
 * The Analytics Engine SQL API takes a statement, and offers no bound
 * parameters. Every interpolated value is therefore checked against a strict
 * pattern first, and the statement is refused when one fails.
 */
export function interactionRollupSql({
  dataset,
  since,
  until,
  granularity = "day",
}: {
  dataset: string;
  since: string;
  until: string;
  granularity?: AnalyticsEngineBucketGranularity;
}): string {
  if (
    !datasetPattern.test(dataset) ||
    !instantPattern.test(since) ||
    !instantPattern.test(until) ||
    Date.parse(since) >= Date.parse(until)
  ) {
    throw new AnalyticsEngineSourceError("query_invalid");
  }
  const clickhouseInstant = (instant: string) =>
    instant.slice(0, 19).replace("T", " ");
  const bucketExpression =
    granularity === "hour"
      ? "formatDateTime(toStartOfHour(timestamp), '%Y-%m-%d %H:00:00')"
      : "formatDateTime(toDate(timestamp), '%Y-%m-%d')";
  // blob1 is the event kind and blob2 the public CMS object ID. No other
  // column is written, so no other column can be selected.
  return `SELECT
  ${bucketExpression} AS bucket_start,
  blob1 AS event_kind,
  blob2 AS subject_id,
  SUM(_sample_interval) AS weighted_count,
  MAX(_sample_interval) AS sample_interval
FROM ${dataset}
WHERE timestamp >= toDateTime('${clickhouseInstant(since)}')
  AND timestamp < toDateTime('${clickhouseInstant(until)}')
GROUP BY bucket_start, event_kind, subject_id
FORMAT JSON`;
}

export async function queryAnalyticsEngine({
  accountId,
  apiToken,
  dataset,
  since,
  until,
  granularity = "day",
  fetchImplementation = fetch,
}: {
  accountId: string;
  apiToken: string;
  dataset: string;
  since: string;
  until: string;
  granularity?: AnalyticsEngineBucketGranularity;
  fetchImplementation?: typeof fetch;
}): Promise<ReadonlyArray<AnalyticsEngineRow>> {
  const sql = interactionRollupSql({ dataset, since, until, granularity });
  const response = await fetchImplementation(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId,
    )}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "text/plain",
      },
      body: sql,
    },
  );
  if (!response.ok) {
    throw new AnalyticsEngineSourceError("query_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AnalyticsEngineSourceError("query_failed");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new AnalyticsEngineSourceError("query_failed");
  }
  return data as ReadonlyArray<AnalyticsEngineRow>;
}

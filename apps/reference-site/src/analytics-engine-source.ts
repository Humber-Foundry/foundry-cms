import "server-only";

import type { AnalyticsFactMeasurement } from "@foundry/application";

/**
 * Workers Analytics Engine fills the one gap Web Analytics cannot: anonymous
 * counts of interactions the CMS defines. It is deliberately best-effort and
 * never authoritative — losing it costs an estimate, not an accepted form, a
 * consent record or a send.
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

export type AnalyticsEngineRow = Readonly<{
  day: string;
  event_kind: string;
  subject_id: string;
  /** Already multiplied by `_sample_interval` in the SQL projection. */
  weighted_count: number;
  sample_interval: number;
}>;

export function isInteractionKind(value: string): value is InteractionKind {
  return Object.hasOwn(allowedInteractionKinds, value);
}

/**
 * Turns weighted Analytics Engine rows into best-effort measurements. The
 * weighting is applied in SQL, and the interval travels with the value so a
 * heavily sampled estimate is legible as one.
 */
export function normalizeAnalyticsEngineRows(
  rows: ReadonlyArray<AnalyticsEngineRow>,
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
    const bucketStartUtc = `${row.day}T00:00:00.000Z`;
    if (Number.isNaN(Date.parse(bucketStartUtc))) {
      throw new AnalyticsEngineSourceError("row_invalid");
    }
    const declared = allowedInteractionKinds[row.event_kind];
    return {
      metricKey: declared.metricKey,
      bucketStartUtc,
      bucketEndUtc: new Date(
        Date.parse(bucketStartUtc) + 86_400_000,
      ).toISOString(),
      granularity: "day" as const,
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
 * The Analytics Engine SQL API takes a statement rather than bound
 * parameters, so every interpolated value is validated against a strict shape
 * first and the statement is refused otherwise.
 */
export function interactionRollupSql({
  dataset,
  since,
  until,
}: {
  dataset: string;
  since: string;
  until: string;
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
  // blob1 is the event kind and blob2 the public CMS object ID. No other
  // column is written, so no other column can be selected.
  return `SELECT
  formatDateTime(toDate(timestamp), '%Y-%m-%d') AS day,
  blob1 AS event_kind,
  blob2 AS subject_id,
  SUM(_sample_interval) AS weighted_count,
  MAX(_sample_interval) AS sample_interval
FROM ${dataset}
WHERE timestamp >= toDateTime('${clickhouseInstant(since)}')
  AND timestamp < toDateTime('${clickhouseInstant(until)}')
GROUP BY day, event_kind, subject_id
FORMAT JSON`;
}

export async function queryAnalyticsEngine({
  accountId,
  apiToken,
  dataset,
  since,
  until,
  fetchImplementation = fetch,
}: {
  accountId: string;
  apiToken: string;
  dataset: string;
  since: string;
  until: string;
  fetchImplementation?: typeof fetch;
}): Promise<ReadonlyArray<AnalyticsEngineRow>> {
  const sql = interactionRollupSql({ dataset, since, until });
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

import {
  analyticsCompositeKey,
  isAllowedAnalyticsDimension,
  splitAnalyticsCompositeKey,
  type AnalyticsFactMeasurement,
} from "@humber-foundry/application";

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

/**
 * The event kind the Worker request path writes for one public page view.
 * It is deliberately outside `allowedInteractionKinds`: a browser may not
 * report it, and the interaction rollup never reads it.
 */
export const webTrafficEventKind = "page_view";

/** The Worker binding an Analytics Engine dataset provides. */
export type AnalyticsEngineDataset = Readonly<{
  writeDataPoint(point: {
    blobs: ReadonlyArray<string>;
    doubles?: ReadonlyArray<number>;
    indexes?: ReadonlyArray<string>;
  }): void;
}>;

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

export type WebTrafficRow = Readonly<{
  /** `YYYY-MM-DD` for a day bucket, `YYYY-MM-DD HH:00:00` for an hour. */
  bucket_start: string;
  /** The published page or post id, or `""` for a path the site does not own. */
  content_id: string;
  referrer_key: string;
  referrer_value: string;
  /** Already multiplied by `_sample_interval` in the SQL projection. */
  weighted_page_views: number;
  weighted_visits: number;
  sample_interval: number;
}>;

function positiveWeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AnalyticsEngineSourceError("row_invalid");
  }
  return value;
}

function addWeighted(
  totals: Map<string, { value: number; sampleInterval: number }>,
  key: string,
  value: number,
  sampleInterval: number,
): void {
  const current = totals.get(key);
  totals.set(key, {
    value: (current?.value ?? 0) + value,
    sampleInterval: Math.max(current?.sampleInterval ?? 1, sampleInterval),
  });
}

/**
 * Turns weighted page view rows into the three canonical web traffic
 * measurements: page views for the whole site, arrivals for the whole site,
 * and page views for each published page. Page views also carry the referrer
 * dimension, which is where the "where visits came from" rows come from.
 *
 * Every row is checked first. A referrer that is not a bare host or a known
 * channel word, or a page id that is not a public id, is refused rather than
 * stored.
 */
export function normalizeWebTrafficRows({
  rows,
  granularity = "day",
  siteId,
}: {
  rows: ReadonlyArray<WebTrafficRow>;
  granularity?: AnalyticsEngineBucketGranularity;
  siteId: string;
}): ReadonlyArray<AnalyticsFactMeasurement> {
  type Totals = Map<string, { value: number; sampleInterval: number }>;
  const sitePageViews: Totals = new Map();
  const siteVisits: Totals = new Map();
  const referrerPageViews: Totals = new Map();
  const contentPageViews: Totals = new Map();

  for (const row of rows) {
    // `bucketInstants` refuses a bucket that is not the expected shape.
    bucketInstants(row.bucket_start, granularity);
    if (row.content_id !== "" && !subjectIdPattern.test(row.content_id)) {
      throw new AnalyticsEngineSourceError("subject_id_invalid");
    }
    const dimension = { key: row.referrer_key, value: row.referrer_value };
    if (!isAllowedAnalyticsDimension(dimension)) {
      throw new AnalyticsEngineSourceError("row_invalid");
    }
    if (
      !Number.isInteger(row.sample_interval) ||
      row.sample_interval < 1
    ) {
      throw new AnalyticsEngineSourceError("row_invalid");
    }
    const pageViews = positiveWeight(row.weighted_page_views);
    const visits = positiveWeight(row.weighted_visits);
    const bucket = row.bucket_start;
    const interval = row.sample_interval;

    addWeighted(sitePageViews, bucket, pageViews, interval);
    addWeighted(siteVisits, bucket, visits, interval);
    if (dimension.key !== "") {
      addWeighted(
        referrerPageViews,
        analyticsCompositeKey([bucket, dimension.key, dimension.value]),
        pageViews,
        interval,
      );
    }
    if (row.content_id !== "") {
      addWeighted(
        contentPageViews,
        analyticsCompositeKey([bucket, row.content_id]),
        pageViews,
        interval,
      );
    }
  }

  const measurement = (
    metricKey: string,
    bucket: string,
    subjectType: "site" | "content",
    subjectId: string,
    dimension: { key: string; value: string },
    total: { value: number; sampleInterval: number },
  ): AnalyticsFactMeasurement => ({
    metricKey,
    ...bucketInstants(bucket, granularity),
    granularity,
    subjectType,
    subjectId,
    dimension,
    unit: "count" as const,
    // Analytics Engine samples under load, and the request path counts every
    // caller, so a machine that reads pages is counted as well as a person.
    quality: "estimated" as const,
    sampleInterval: total.sampleInterval,
    value: Math.round(total.value),
    unavailableReason: null,
  });

  const emptyDimension = { key: "", value: "" };
  const measurements: AnalyticsFactMeasurement[] = [];

  for (const [bucket, total] of sitePageViews) {
    measurements.push(
      measurement(
        "web.page_views",
        bucket,
        "site",
        siteId,
        emptyDimension,
        total,
      ),
    );
  }
  for (const [bucket, total] of siteVisits) {
    measurements.push(
      measurement("web.visits", bucket, "site", siteId, emptyDimension, total),
    );
  }
  for (const [key, total] of referrerPageViews) {
    const [bucket, dimensionKey, dimensionValue] =
      splitAnalyticsCompositeKey(key);
    measurements.push(
      measurement(
        "web.page_views",
        bucket,
        "site",
        siteId,
        { key: dimensionKey, value: dimensionValue },
        total,
      ),
    );
  }
  for (const [key, total] of contentPageViews) {
    const [bucket, contentId] = splitAnalyticsCompositeKey(key);
    measurements.push(
      measurement(
        "content.page_views",
        bucket,
        "content",
        contentId,
        emptyDimension,
        total,
      ),
    );
  }

  return measurements;
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
  // blob1 is the event kind and blob2 the public CMS object ID. The kinds are
  // named here, so a page view point never reaches the interaction rollup.
  const kinds = Object.keys(allowedInteractionKinds)
    .map((kind) => `'${kind}'`)
    .join(", ");
  return `SELECT
  ${bucketExpression} AS bucket_start,
  blob1 AS event_kind,
  blob2 AS subject_id,
  SUM(_sample_interval) AS weighted_count,
  MAX(_sample_interval) AS sample_interval
FROM ${dataset}
WHERE timestamp >= toDateTime('${clickhouseInstant(since)}')
  AND timestamp < toDateTime('${clickhouseInstant(until)}')
  AND blob1 IN (${kinds})
GROUP BY bucket_start, event_kind, subject_id
FORMAT JSON`;
}

/**
 * The rollup for the page views the Worker request path counts.
 *
 * blob1 is the event kind, blob2 the published page or post id, blob3 and
 * blob4 the referrer dimension, double1 the page view and double2 the
 * arrival marker. No other column is written, so no other column can be
 * selected, and none of them can describe a person.
 */
export function webTrafficRollupSql({
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
  return `SELECT
  ${bucketExpression} AS bucket_start,
  blob2 AS content_id,
  blob3 AS referrer_key,
  blob4 AS referrer_value,
  SUM(double1 * _sample_interval) AS weighted_page_views,
  SUM(double2 * _sample_interval) AS weighted_visits,
  MAX(_sample_interval) AS sample_interval
FROM ${dataset}
WHERE timestamp >= toDateTime('${clickhouseInstant(since)}')
  AND timestamp < toDateTime('${clickhouseInstant(until)}')
  AND blob1 = '${webTrafficEventKind}'
GROUP BY bucket_start, content_id, referrer_key, referrer_value
FORMAT JSON`;
}

/** Runs one statement against the Analytics Engine SQL API. */
async function runAnalyticsEngineSql({
  accountId,
  apiToken,
  sql,
  fetchImplementation = fetch,
}: {
  accountId: string;
  apiToken: string;
  sql: string;
  fetchImplementation?: typeof fetch;
}): Promise<ReadonlyArray<unknown>> {
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
  return data;
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
  const rows = await runAnalyticsEngineSql({
    accountId,
    apiToken,
    sql: interactionRollupSql({ dataset, since, until, granularity }),
    fetchImplementation,
  });
  return rows as ReadonlyArray<AnalyticsEngineRow>;
}

export async function queryWebTraffic({
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
}): Promise<ReadonlyArray<WebTrafficRow>> {
  const rows = await runAnalyticsEngineSql({
    accountId,
    apiToken,
    sql: webTrafficRollupSql({ dataset, since, until, granularity }),
    fetchImplementation,
  });
  return rows as ReadonlyArray<WebTrafficRow>;
}

import "server-only";

import {
  analyticsCompositeKey,
  splitAnalyticsCompositeKey,
  type AnalyticsFactMeasurement,
} from "@foundry/application";

/**
 * Cloudflare Web Analytics is the traffic authority. Foundry imports only the
 * host, published path, normalized referrer host and Web Vitals aggregates it
 * declares; query strings, geography, device and browser breakdowns are never
 * requested and are refused here if a response volunteers them.
 *
 * Contract: https://developers.cloudflare.com/analytics/graphql-api/
 */

export const cloudflareWebAnalyticsSourceName = "cloudflare";
export const cloudflareWebAnalyticsDefinitionVersion = 1;

const allowedGroupDimensions = new Set(["date", "requestPath", "refererHost"]);

export type CloudflareWebAnalyticsGroup = Readonly<{
  count: number;
  sum: Readonly<{ visits: number }>;
  avg: Readonly<{ sampleInterval: number }>;
  dimensions: Readonly<{
    date: string;
    requestPath: string;
    refererHost: string;
  }>;
}>;

export type CloudflareWebVitalsGroup = Readonly<{
  dimensions: Readonly<{ date: string; requestPath: string }>;
  quantiles: Readonly<{
    lcpP75: number | null;
    inpP75: number | null;
    clsP75: number | null;
  }>;
}>;

/** One Web Vital's canonical metric, its unit, and how to read it. */
type WebVitalMapping = Readonly<{
  metricKey: AnalyticsFactMeasurement["metricKey"];
  unit: AnalyticsFactMeasurement["unit"];
  read(group: CloudflareWebVitalsGroup): number | null;
}>;

export type CloudflareWebAnalyticsResponse = Readonly<{
  pageloads: ReadonlyArray<CloudflareWebAnalyticsGroup>;
  webVitals: ReadonlyArray<CloudflareWebVitalsGroup>;
}>;

export class CloudflareWebAnalyticsSourceError extends Error {
  readonly code:
    | "unexpected_dimension"
    | "response_invalid"
    | "query_failed"
    | "path_invalid";

  constructor(code: CloudflareWebAnalyticsSourceError["code"]) {
    super(`The Cloudflare Web Analytics source was refused: ${code}.`);
    this.name = "CloudflareWebAnalyticsSourceError";
    this.code = code;
  }
}

/**
 * One published path's owner over a time bucket. A route change therefore
 * cannot silently merge two content items' history.
 */
export type PublishedRouteHistoryEntry = Readonly<{
  path: string;
  contentId: string;
  fromUtc: string;
  toUtc: string | null;
}>;

const referrerChannels: ReadonlyArray<
  Readonly<{ channel: string; hosts: ReadonlyArray<string> }>
> = Object.freeze([
  {
    channel: "search",
    hosts: ["google.", "bing.", "duckduckgo.", "search.", "ecosia."],
  },
  {
    channel: "social",
    hosts: [
      "facebook.",
      "instagram.",
      "linkedin.",
      "mastodon.",
      "reddit.",
      "bsky.",
      "x.com",
      "t.co",
    ],
  },
]);

/** Reduces a referrer to a bare host, or to a channel when there is none. */
export function normalizeReferrer(
  refererHost: string,
): Readonly<{ key: string; value: string }> {
  const host = refererHost.trim().toLowerCase();
  if (host === "" || host === "(none)" || host === "direct") {
    return { key: "referrer_channel", value: "direct" };
  }
  const channel = referrerChannels.find((entry) =>
    entry.hosts.some((candidate) => host.startsWith(candidate)),
  );
  if (channel !== undefined) {
    return { key: "referrer_channel", value: channel.channel };
  }
  return { key: "referrer_host", value: host };
}

/** Drops the query string and fragment a published path never needs. */
export function normalizePublishedPath(requestPath: string): string {
  if (!requestPath.startsWith("/")) {
    throw new CloudflareWebAnalyticsSourceError("path_invalid");
  }
  return requestPath.split("?")[0].split("#")[0];
}

function utcDayBucket(date: string) {
  const bucketStartUtc = `${date}T00:00:00.000Z`;
  const parsed = Date.parse(bucketStartUtc);
  if (Number.isNaN(parsed)) {
    throw new CloudflareWebAnalyticsSourceError("response_invalid");
  }
  return {
    bucketStartUtc,
    bucketEndUtc: new Date(parsed + 86_400_000).toISOString(),
  };
}

function contentIdForPath(
  path: string,
  bucketStartUtc: string,
  routeHistory: ReadonlyArray<PublishedRouteHistoryEntry>,
): string | null {
  const owner = routeHistory.find(
    (entry) =>
      entry.path === path &&
      Date.parse(entry.fromUtc) <= Date.parse(bucketStartUtc) &&
      (entry.toUtc === null ||
        Date.parse(entry.toUtc) > Date.parse(bucketStartUtc)),
  );
  return owner?.contentId ?? null;
}

function add(
  totals: Map<string, { value: number; sampleInterval: number }>,
  key: string,
  value: number,
  sampleInterval: number,
) {
  const current = totals.get(key);
  if (current === undefined) {
    totals.set(key, { value, sampleInterval });
    return;
  }
  totals.set(key, {
    value: current.value + value,
    sampleInterval: Math.max(current.sampleInterval, sampleInterval),
  });
}

/**
 * Normalizes one Web Analytics response into canonical measurements.
 *
 * A sampled response keeps the quality `estimated` and the sampling interval
 * the platform reported. Each measurement includes both, so a later reader can
 * tell an estimate from an exact count.
 */
export function normalizeCloudflareWebAnalytics({
  response,
  siteId,
  routeHistory,
}: {
  response: CloudflareWebAnalyticsResponse;
  siteId: string;
  routeHistory: ReadonlyArray<PublishedRouteHistoryEntry>;
}): ReadonlyArray<AnalyticsFactMeasurement> {
  const pageViews = new Map<string, { value: number; sampleInterval: number }>();
  const visits = new Map<string, { value: number; sampleInterval: number }>();
  const contentViews = new Map<
    string,
    { value: number; sampleInterval: number }
  >();
  const referrerViews = new Map<
    string,
    { value: number; sampleInterval: number }
  >();

  for (const group of response.pageloads) {
    for (const dimension of Object.keys(group.dimensions)) {
      if (!allowedGroupDimensions.has(dimension)) {
        throw new CloudflareWebAnalyticsSourceError("unexpected_dimension");
      }
    }
    if (
      !Number.isFinite(group.count) ||
      !Number.isFinite(group.sum.visits) ||
      !Number.isInteger(group.avg.sampleInterval) ||
      group.avg.sampleInterval < 1
    ) {
      throw new CloudflareWebAnalyticsSourceError("response_invalid");
    }
    const { date } = group.dimensions;
    const path = normalizePublishedPath(group.dimensions.requestPath);
    const sampleInterval = group.avg.sampleInterval;

    add(pageViews, date, group.count, sampleInterval);
    add(visits, date, group.sum.visits, sampleInterval);

    const { bucketStartUtc } = utcDayBucket(date);
    const contentId = contentIdForPath(path, bucketStartUtc, routeHistory);
    if (contentId !== null) {
      add(
        contentViews,
        analyticsCompositeKey([date, contentId]),
        group.count,
        sampleInterval,
      );
    }
    const referrer = normalizeReferrer(group.dimensions.refererHost);
    add(
      referrerViews,
      analyticsCompositeKey([date, referrer.key, referrer.value]),
      group.count,
      sampleInterval,
    );
  }

  // Referral-based visits, platform bot filtering and query sampling all make
  // these estimates. Each measurement includes its sampling interval, so a
  // reader can see how heavily it was sampled.
  const quality = "estimated" as const;

  const measurements: AnalyticsFactMeasurement[] = [];

  for (const [date, total] of pageViews) {
    measurements.push({
      metricKey: "web.page_views",
      ...utcDayBucket(date),
      granularity: "day",
      subjectType: "site",
      subjectId: siteId,
      dimension: { key: "", value: "" },
      unit: "count",
      quality,
      sampleInterval: total.sampleInterval,
      value: total.value,
      unavailableReason: null,
    });
  }

  for (const [date, total] of visits) {
    measurements.push({
      metricKey: "web.visits",
      ...utcDayBucket(date),
      granularity: "day",
      subjectType: "site",
      subjectId: siteId,
      dimension: { key: "", value: "" },
      unit: "count",
      quality,
      sampleInterval: total.sampleInterval,
      value: total.value,
      unavailableReason: null,
    });
  }

  for (const [key, total] of contentViews) {
    const [date, contentId] = splitAnalyticsCompositeKey(key);
    measurements.push({
      metricKey: "content.page_views",
      ...utcDayBucket(date),
      granularity: "day",
      subjectType: "content",
      subjectId: contentId,
      dimension: { key: "", value: "" },
      unit: "count",
      quality,
      sampleInterval: total.sampleInterval,
      value: total.value,
      unavailableReason: null,
    });
  }

  for (const [key, total] of referrerViews) {
    const [date, dimensionKey, dimensionValue] =
      splitAnalyticsCompositeKey(key);
    measurements.push({
      metricKey: "web.page_views",
      ...utcDayBucket(date),
      granularity: "day",
      subjectType: "site",
      subjectId: siteId,
      dimension: { key: dimensionKey, value: dimensionValue },
      unit: "count",
      quality,
      sampleInterval: total.sampleInterval,
      value: total.value,
      unavailableReason: null,
    });
  }

  const vitals: ReadonlyArray<WebVitalMapping> = [
    {
      metricKey: "web.vitals.lcp_p75",
      unit: "milliseconds",
      read: (group) => group.quantiles.lcpP75,
    },
    {
      metricKey: "web.vitals.inp_p75",
      unit: "milliseconds",
      read: (group) => group.quantiles.inpP75,
    },
    {
      metricKey: "web.vitals.cls_p75",
      unit: "score",
      read: (group) => group.quantiles.clsP75,
    },
  ];

  for (const group of response.webVitals) {
    const path = normalizePublishedPath(group.dimensions.requestPath);
    const { bucketStartUtc, bucketEndUtc } = utcDayBucket(
      group.dimensions.date,
    );
    const contentId = contentIdForPath(path, bucketStartUtc, routeHistory);
    if (contentId === null) continue;
    for (const vital of vitals) {
      const value = vital.read(group);
      measurements.push({
        metricKey: vital.metricKey,
        bucketStartUtc,
        bucketEndUtc,
        granularity: "day",
        subjectType: "content",
        subjectId: contentId,
        dimension: { key: "", value: "" },
        unit: vital.unit,
        // Only browsers that report Web Vitals contribute, so this is never a
        // whole-population measurement.
        quality: "partial_population",
        sampleInterval: 1,
        value,
        unavailableReason: value === null ? "not_measured" : null,
      });
    }
  }

  return measurements;
}

const pageloadQuery = `query FoundryWebAnalytics(
  $accountTag: String!
  $siteTag: String!
  $since: Time!
  $until: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      pageloads: rumPageloadEventsAdaptiveGroups(
        limit: 5000
        filter: {
          siteTag: $siteTag
          datetime_geq: $since
          datetime_lt: $until
          bot: 0
        }
        orderBy: [date_ASC]
      ) {
        count
        sum { visits }
        avg { sampleInterval }
        dimensions { date requestPath refererHost }
      }
    }
  }
}`;

/**
 * Requests only the declared aggregates. The analytics token is account- and
 * zone-scoped and reaches neither the dashboard nor MCP.
 */
export async function fetchCloudflareWebAnalytics({
  accountTag,
  siteTag,
  apiToken,
  since,
  until,
  fetchImplementation = fetch,
}: {
  accountTag: string;
  siteTag: string;
  apiToken: string;
  since: string;
  until: string;
  fetchImplementation?: typeof fetch;
}): Promise<ReadonlyArray<CloudflareWebAnalyticsGroup>> {
  const response = await fetchImplementation(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: pageloadQuery,
        variables: { accountTag, siteTag, since, until },
      }),
    },
  );
  if (!response.ok) {
    throw new CloudflareWebAnalyticsSourceError("query_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudflareWebAnalyticsSourceError("response_invalid");
  }
  const accounts = (
    body as {
      data?: { viewer?: { accounts?: ReadonlyArray<Record<string, unknown>> } };
      errors?: unknown;
    }
  )?.data?.viewer?.accounts;
  if ((body as { errors?: unknown }).errors !== undefined) {
    throw new CloudflareWebAnalyticsSourceError("query_failed");
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new CloudflareWebAnalyticsSourceError("response_invalid");
  }
  const pageloads = accounts[0].pageloads;
  if (!Array.isArray(pageloads)) {
    throw new CloudflareWebAnalyticsSourceError("response_invalid");
  }
  return pageloads as ReadonlyArray<CloudflareWebAnalyticsGroup>;
}

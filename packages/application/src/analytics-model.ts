/**
 * The aggregate vocabulary shared by the analytics projectors, the `/dash`
 * query service and every later analytics surface.
 *
 * ADR-0003 states one rule that this module enforces at runtime: an analytics
 * fact describes a product object over a time bucket. It never describes a
 * person. `assertAggregateAnalyticsPayload` checks every payload against that
 * rule before it is written, so a projector cannot add an unreviewed field to
 * the read model.
 */

export const analyticsSchemaVersion = "foundry.analytics.v1" as const;

export type AnalyticsSource =
  | "cloudflare_web"
  | "analytics_engine"
  | "d1"
  | "provider";

export type AnalyticsGranularity = "hour" | "day" | "campaign" | "current";

export type AnalyticsSubjectType =
  | "site"
  | "content"
  | "form"
  | "cta"
  | "campaign";

export type AnalyticsQuality =
  | "exact"
  | "derived_exact"
  | "estimated"
  | "partial_population"
  | "best_effort"
  | "provider_reported"
  | "directional"
  | "unreliable";

export type AnalyticsUnit = "count" | "ratio" | "milliseconds" | "score";

/**
 * How prominently a metric may be presented. Delivery outcomes tell an owner
 * whether a send worked, so they lead. Reported engagement signals are kept
 * out of the primary reading order, so a provider's inflated open count cannot
 * read as an operational fact.
 */
export type AnalyticsProminence = "primary" | "secondary" | "collapsed";

export type AnalyticsMetricKey =
  | "web.page_views"
  | "web.visits"
  | "web.vitals.lcp_p75"
  | "web.vitals.inp_p75"
  | "web.vitals.cls_p75"
  | "content.page_views"
  | "interaction.form_impressions"
  | "interaction.cta_activations"
  | "form.submissions_accepted"
  | "form.submissions_blocked"
  | "form.notifications_delivered"
  | "form.notifications_failed"
  | "subscriber.confirmed"
  | "subscriber.unsubscribed"
  | "subscriber.hard_bounced"
  | "subscriber.complained"
  | "subscriber.active"
  | "subscriber.net_growth"
  | "campaign.sent"
  | "campaign.delivered"
  | "campaign.soft_bounced"
  | "campaign.hard_bounced"
  | "campaign.complained"
  | "campaign.unsubscribed"
  | "campaign.unique_opens_reported"
  | "campaign.unique_clicks_reported";

export type AnalyticsMetricDefinition = Readonly<{
  metricKey: AnalyticsMetricKey;
  source: AnalyticsSource;
  subjectTypes: ReadonlyArray<AnalyticsSubjectType>;
  unit: AnalyticsUnit;
  defaultQuality: AnalyticsQuality;
  definitionVersion: number;
  prominence: AnalyticsProminence;
  /**
   * How buckets combine over a range. A point-in-time snapshot and a
   * percentile cannot be added up, so they report their latest closed bucket
   * instead.
   */
  aggregation: "sum" | "latest";
  /** Each send defines one campaign measurement bucket. */
  bucketGranularity: "range" | "campaign";
  /**
   * Whether the measurement can legitimately fall below zero. Net growth can;
   * a count cannot, and storing a negative count would mean a projector bug.
   */
  valueDomain: "non_negative" | "signed";
  /** The plain-language meaning the dashboard must show beside the number. */
  definition: string;
}>;

/**
 * How long after a bucket closes each source is expected to have reported it.
 * A source that exceeds this is labelled `delayed`, so the reader sees the
 * delay beside the number.
 */
export const analyticsSourceExpectedLagSeconds: Readonly<
  Record<AnalyticsSource, number>
> = Object.freeze({
  cloudflare_web: 86_400,
  analytics_engine: 86_400,
  d1: 900,
  provider: 21_600,
});

export const analyticsDaySeconds = 86_400;

/**
 * Joins parts into one Map key. The separator is the ASCII unit separator. No
 * metric key, subject ID, referrer host or instant may contain that character,
 * so a value cannot split a key.
 */
const compositeKeySeparator = "\u001f";

export function analyticsCompositeKey(
  parts: ReadonlyArray<string | number>,
): string {
  return parts.join(compositeKeySeparator);
}

export function splitAnalyticsCompositeKey(
  key: string,
): ReadonlyArray<string> {
  return key.split(compositeKeySeparator);
}

/** The UTC midnight that starts the day containing `instant`. */
export function utcDayStart(instant: string): string {
  return `${instant.slice(0, 10)}T00:00:00.000Z`;
}

export function addUtcDays(instant: string, days: number): string {
  return new Date(
    Date.parse(instant) + days * analyticsDaySeconds * 1_000,
  ).toISOString();
}

export function addUtcSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1_000).toISOString();
}

export function earliestInstant(instants: ReadonlyArray<string>): string {
  return instants.reduce((lowest, candidate) =>
    Date.parse(candidate) < Date.parse(lowest) ? candidate : lowest,
  );
}

/**
 * Steps back whole calendar months. A day the shorter month lacks is clamped
 * to that month's last day. Retention is stated in calendar months, and a
 * fixed day count would give a different date.
 */
export function subtractUtcMonths(instant: string, months: number): string {
  const date = new Date(Date.parse(instant));
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const daysInTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(targetDay, daysInTargetMonth));
  return date.toISOString();
}

export class AnalyticsVocabularyError extends Error {
  readonly metricKey: string;

  constructor(metricKey: string) {
    super(`"${metricKey}" is not a canonical analytics metric.`);
    this.name = "AnalyticsVocabularyError";
    this.metricKey = metricKey;
  }
}

type AnalyticsMetricEntry = Omit<
  AnalyticsMetricDefinition,
  "aggregation" | "bucketGranularity" | "valueDomain"
> &
  Partial<
    Pick<
      AnalyticsMetricDefinition,
      "aggregation" | "bucketGranularity" | "valueDomain"
    >
  >;

function metric(entry: AnalyticsMetricEntry): AnalyticsMetricDefinition {
  return Object.freeze({
    aggregation: "sum" as const,
    valueDomain: "non_negative" as const,
    bucketGranularity: entry.metricKey.startsWith("campaign.")
      ? ("campaign" as const)
      : ("range" as const),
    ...entry,
  });
}

const registry: ReadonlyArray<AnalyticsMetricDefinition> = Object.freeze([
  metric({
    metricKey: "web.page_views",
    source: "cloudflare_web",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "estimated",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Page views reported by Cloudflare Web Analytics, bots excluded where the platform supports it.",
  }),
  metric({
    metricKey: "web.visits",
    source: "cloudflare_web",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "estimated",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Referral-based visits. This is not a count of unique people or sessions.",
  }),
  metric({
    metricKey: "web.vitals.lcp_p75",
    aggregation: "latest",
    source: "cloudflare_web",
    subjectTypes: ["site", "content"],
    unit: "milliseconds",
    defaultQuality: "partial_population",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "75th-percentile Largest Contentful Paint from browsers that report Web Vitals.",
  }),
  metric({
    metricKey: "web.vitals.inp_p75",
    aggregation: "latest",
    source: "cloudflare_web",
    subjectTypes: ["site", "content"],
    unit: "milliseconds",
    defaultQuality: "partial_population",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "75th-percentile Interaction to Next Paint from browsers that report Web Vitals.",
  }),
  metric({
    metricKey: "web.vitals.cls_p75",
    aggregation: "latest",
    source: "cloudflare_web",
    subjectTypes: ["site", "content"],
    unit: "score",
    defaultQuality: "partial_population",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "75th-percentile Cumulative Layout Shift from browsers that report Web Vitals.",
  }),
  metric({
    metricKey: "content.page_views",
    source: "cloudflare_web",
    subjectTypes: ["content"],
    unit: "count",
    defaultQuality: "estimated",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Page views joined to the content item that owned the published path in that bucket.",
  }),
  metric({
    metricKey: "interaction.form_impressions",
    source: "analytics_engine",
    subjectTypes: ["form"],
    unit: "count",
    defaultQuality: "best_effort",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "Anonymous best-effort count of a form becoming viewable. Collection loss is expected.",
  }),
  metric({
    metricKey: "interaction.cta_activations",
    source: "analytics_engine",
    subjectTypes: ["cta"],
    unit: "count",
    defaultQuality: "best_effort",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "Anonymous best-effort count of a call-to-action activation. Collection loss is expected.",
  }),
  metric({
    metricKey: "form.submissions_accepted",
    source: "d1",
    subjectTypes: ["form"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Committed, non-synthetic form submissions recorded by the CMS transaction.",
  }),
  metric({
    metricKey: "form.submissions_blocked",
    source: "d1",
    subjectTypes: ["form"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "Rejected automated submissions. Analytics keeps no payload or rejection detail.",
  }),
  metric({
    metricKey: "form.notifications_delivered",
    source: "d1",
    subjectTypes: ["form"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "primary",
    definition: "Completed staff notification intents for accepted submissions.",
  }),
  metric({
    metricKey: "form.notifications_failed",
    source: "d1",
    subjectTypes: ["form"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "primary",
    definition: "Exhausted or permanently failed staff notification intents.",
  }),
  metric({
    metricKey: "subscriber.confirmed",
    source: "d1",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "primary",
    definition: "Consent-ledger transitions into the confirmed, active state.",
  }),
  metric({
    metricKey: "subscriber.unsubscribed",
    source: "d1",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Suppression-ledger unsubscribe transitions from either the local or provider surface.",
  }),
  metric({
    metricKey: "subscriber.hard_bounced",
    source: "d1",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "secondary",
    definition: "Hard-bounce suppressions applied to the ledger.",
  }),
  metric({
    metricKey: "subscriber.complained",
    source: "d1",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "secondary",
    definition: "Complaint suppressions applied to the ledger.",
  }),
  metric({
    metricKey: "subscriber.active",
    aggregation: "latest",
    source: "d1",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "exact",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Point-in-time count of lawfully active subscribers, snapshotted daily.",
  }),
  metric({
    metricKey: "subscriber.net_growth",
    valueDomain: "signed",
    source: "d1",
    subjectTypes: ["site"],
    unit: "count",
    defaultQuality: "derived_exact",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Confirmed additions minus every suppressing exit within the range.",
  }),
  metric({
    metricKey: "campaign.sent",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "provider_reported",
    definitionVersion: 1,
    prominence: "primary",
    definition: "Provider-defined sent count for one campaign.",
  }),
  metric({
    metricKey: "campaign.delivered",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "provider_reported",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "The receiving server accepted the message. This is not inbox placement.",
  }),
  metric({
    metricKey: "campaign.soft_bounced",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "provider_reported",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "Provider-defined temporary delivery failure. This value can still change.",
  }),
  metric({
    metricKey: "campaign.hard_bounced",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "provider_reported",
    definitionVersion: 1,
    prominence: "primary",
    definition: "Provider-defined permanent delivery failure.",
  }),
  metric({
    metricKey: "campaign.complained",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "provider_reported",
    definitionVersion: 1,
    prominence: "primary",
    definition: "Provider-reported spam complaints for one campaign.",
  }),
  metric({
    metricKey: "campaign.unsubscribed",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "provider_reported",
    definitionVersion: 1,
    prominence: "primary",
    definition:
      "Campaign-attributed unsubscribes reported by the provider and reconciled with the ledger.",
  }),
  metric({
    metricKey: "campaign.unique_opens_reported",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "unreliable",
    definitionVersion: 1,
    prominence: "collapsed",
    definition:
      "Provider-defined unique opens. Privacy proxies and bots can fetch remote content before a person reads it.",
  }),
  metric({
    metricKey: "campaign.unique_clicks_reported",
    source: "provider",
    subjectTypes: ["campaign"],
    unit: "count",
    defaultQuality: "directional",
    definitionVersion: 1,
    prominence: "secondary",
    definition:
      "Provider-defined unique clicks. Security scanners and link protection can still alter this.",
  }),
]);

const registryByKey = new Map<string, AnalyticsMetricDefinition>(
  registry.map((entry) => [entry.metricKey, entry]),
);

export const analyticsMetricKeys: ReadonlyArray<AnalyticsMetricKey> =
  Object.freeze(registry.map((entry) => entry.metricKey));

export const analyticsMetrics: ReadonlyArray<AnalyticsMetricDefinition> =
  registry;

export function analyticsMetricDefinition(
  metricKey: string,
): AnalyticsMetricDefinition {
  const definition = registryByKey.get(metricKey);
  if (definition === undefined) {
    throw new AnalyticsVocabularyError(metricKey);
  }
  return definition;
}

export function isAnalyticsMetricKey(
  value: string,
): value is AnalyticsMetricKey {
  return registryByKey.has(value);
}

export class AnalyticsPrivacyViolationError extends Error {
  readonly field: string;
  readonly path: string;

  constructor(field: string, path: string) {
    super(
      `The analytics payload carries "${path}", which cannot enter the aggregate read model.`,
    );
    this.name = "AnalyticsPrivacyViolationError";
    this.field = field;
    this.path = path;
  }
}

/**
 * Substrings that identify a person, a device or a single request wherever
 * they appear in a field name. These are matched against the field name with
 * separators removed, so `visitor_id`, `visitorId` and `VisitorID` all match.
 */
const prohibitedFieldSubstrings: ReadonlyArray<string> = Object.freeze([
  "visitor",
  "session",
  "requestid",
  "subscriber",
  "contact",
  "recipient",
  "respondent",
  "email",
  "ipaddress",
  "useragent",
  "latitude",
  "longitude",
  "coordinate",
  "referrerpath",
  "querystring",
  "rawevent",
  "cookie",
  "fingerprint",
  "replay",
  "messageid",
  "properties",
]);

/** Field names that are only ever personal or free-form when used alone. */
const prohibitedExactFields: ReadonlySet<string> = new Set([
  "ip",
  "ips",
  "ua",
  "url",
  "urls",
  "path",
  "query",
  "address",
  "user",
  "userid",
  "person",
]);

const emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const ipv4Pattern =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/u;
const ipv6Pattern = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/iu;

function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function prohibitedField(field: string): boolean {
  const normalized = normalizeFieldName(field);
  return (
    prohibitedExactFields.has(normalized) ||
    prohibitedFieldSubstrings.some((token) => normalized.includes(token))
  );
}

function prohibitedValue(value: string): boolean {
  return (
    emailPattern.test(value) ||
    ipv4Pattern.test(value) ||
    ipv6Pattern.test(value) ||
    value.includes("://") ||
    value.includes("?")
  );
}

/**
 * Throws on anything that would turn an aggregate into a person-level record.
 *
 * Projectors call this on the whole normalized payload before it reaches the
 * store, and provider adapters call it on the snapshot they return. A leak
 * therefore fails at the point it enters the system.
 */
export function assertAggregateAnalyticsPayload(
  payload: unknown,
  path = "",
): void {
  if (Array.isArray(payload)) {
    payload.forEach((entry, index) =>
      assertAggregateAnalyticsPayload(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof payload === "string") {
    if (prohibitedValue(payload)) {
      const field = path.split(".").at(-1) ?? path;
      throw new AnalyticsPrivacyViolationError(field, path);
    }
    return;
  }
  if (typeof payload !== "object" || payload === null) {
    return;
  }
  for (const [field, value] of Object.entries(payload)) {
    const fieldPath = path === "" ? field : `${path}.${field}`;
    if (prohibitedField(field)) {
      throw new AnalyticsPrivacyViolationError(field, fieldPath);
    }
    assertAggregateAnalyticsPayload(value, fieldPath);
  }
}

export type AnalyticsDimension = Readonly<{ key: string; value: string }>;

/** The sentinel that names an undimensioned total for a subject. */
export const emptyDimension: AnalyticsDimension = Object.freeze({
  key: "",
  value: "",
});

/**
 * V1 imports no geographic, demographic, device or campaign-tag breakdown.
 * Referrer detail is reduced to a normalized host or channel before it ever
 * reaches the read model.
 */
export const allowedAnalyticsDimensionKeys: ReadonlyArray<string> =
  Object.freeze(["", "referrer_host", "referrer_channel"]);

const referrerChannels: ReadonlySet<string> = new Set([
  "direct",
  "search",
  "social",
  "referral",
  "email",
  "other",
]);

const hostPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/u;

export function isAllowedAnalyticsDimension(
  dimension: AnalyticsDimension,
): boolean {
  if (dimension.key === "") return dimension.value === "";
  if (!allowedAnalyticsDimensionKeys.includes(dimension.key)) return false;
  if (dimension.key === "referrer_channel") {
    return referrerChannels.has(dimension.value);
  }
  return dimension.value.length <= 253 && hostPattern.test(dimension.value);
}

export type AnalyticsUnavailableReason =
  | "not_measured"
  | "provider_omitted"
  | "source_unavailable"
  | "outside_retention"
  | "not_supported";

/**
 * The reasons that mean the source failed to deliver a measurement it was
 * asked for. The remaining reasons are expected: a browser that reports no Web
 * Vitals gives `not_measured`, and a capability the provider never claimed
 * gives `not_supported`. Counting those as failures would leave a healthy
 * source reporting `partial` for ever.
 */
const sourceGapReasons: ReadonlySet<AnalyticsUnavailableReason> = new Set([
  "provider_omitted",
  "source_unavailable",
]);

export function isSourceGapReason(
  reason: AnalyticsUnavailableReason | null,
): boolean {
  return reason !== null && sourceGapReasons.has(reason);
}

export type AnalyticsValue =
  | Readonly<{ state: "available"; value: number }>
  | Readonly<{ state: "suppressed"; label: "fewer than 5" }>
  | Readonly<{ state: "unavailable"; reason: AnalyticsUnavailableReason }>;

export const analyticsSmallCellThreshold = 5;

export function availableValue(value: number): AnalyticsValue {
  return Object.freeze({ state: "available" as const, value });
}

export function unavailableValue(
  reason: AnalyticsUnavailableReason,
): AnalyticsValue {
  return Object.freeze({ state: "unavailable" as const, reason });
}

/**
 * Presents a secondary dimension row. A business object's own total is
 * reported exactly even when it is small; only the breakdown rows beneath it
 * are suppressed, because those are what could re-identify a person.
 */
export function presentSecondaryCell(value: number | null): AnalyticsValue {
  if (value === null) return unavailableValue("not_measured");
  if (value > 0 && value < analyticsSmallCellThreshold) {
    return Object.freeze({
      state: "suppressed" as const,
      label: "fewer than 5" as const,
    });
  }
  return availableValue(value);
}

export type AnalyticsMeasurementIdentity = Readonly<{
  metricKey: AnalyticsMetricKey;
  source: AnalyticsSource;
  sourceName: string;
  sourceMetric: string;
  definitionVersion: number;
}>;

export class AnalyticsComparabilityError extends Error {
  readonly signatures: ReadonlyArray<string>;

  constructor(signatures: ReadonlyArray<string>) {
    super(
      `Refusing to combine unlike measurements: ${signatures.join(" vs ")}.`,
    );
    this.name = "AnalyticsComparabilityError";
    this.signatures = signatures;
  }
}

/**
 * Everything that has to match before two numbers mean the same thing. Two
 * providers' "delivered" counts, or one provider's count either side of a
 * definition change, are different measurements that happen to share a name.
 */
export function comparabilitySignature(
  identity: AnalyticsMeasurementIdentity,
): string {
  return [
    identity.metricKey,
    identity.source,
    identity.sourceName,
    identity.sourceMetric,
    identity.definitionVersion,
  ].join("|");
}

/**
 * Adds a series only when every reading shares one measurement definition.
 * An empty selection returns `null`, which the caller reports as unavailable.
 * Returning `0` would present an absence as a measured value.
 */
export function summableSeries(
  readings: ReadonlyArray<AnalyticsMeasurementIdentity & { value: number }>,
): number | null {
  if (readings.length === 0) return null;
  const signatures = [
    ...new Set(readings.map((entry) => comparabilitySignature(entry))),
  ];
  if (signatures.length > 1) {
    throw new AnalyticsComparabilityError(signatures);
  }
  return readings.reduce((total, entry) => total + entry.value, 0);
}

export type AnalyticsFreshness =
  | "fresh"
  | "in_progress"
  | "delayed"
  | "stale";

const staleFloorSeconds = 24 * 60 * 60;

/**
 * Describes how much a reading can be trusted right now. A bucket that has not
 * closed is labelled `in_progress`. A source that has exceeded its expected
 * lag is labelled `delayed`. Both labels reach the reader with the number.
 */
export function readingFreshness({
  completeThrough,
  bucketEndUtc,
  observedAt,
  now,
  expectedLagSeconds,
}: {
  completeThrough: string;
  bucketEndUtc: string;
  observedAt: string;
  now: string;
  expectedLagSeconds: number;
}): AnalyticsFreshness {
  if (Date.parse(bucketEndUtc) > Date.parse(completeThrough)) {
    return "in_progress";
  }
  const ageSeconds = (Date.parse(now) - Date.parse(observedAt)) / 1_000;
  const staleAfter = Math.max(staleFloorSeconds, expectedLagSeconds * 6);
  if (ageSeconds > staleAfter) return "stale";
  if (ageSeconds > expectedLagSeconds * 2) return "delayed";
  return "fresh";
}

export type AnalyticsSourceStatus =
  | "healthy"
  | "delayed"
  | "partial"
  | "unavailable";

export type AnalyticsSourceState = Readonly<{
  source: AnalyticsSource;
  sourceName: string;
  status: AnalyticsSourceStatus;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  completeThrough: string | null;
  nextRetryAt: string | null;
  /** Stable, non-secret code. Never a provider message or credential. */
  errorCode: string | null;
  definitionVersion: number;
}>;

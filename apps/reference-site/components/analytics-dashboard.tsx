import type {
  AnalyticsDerivedRatio,
  AnalyticsReading,
  AnalyticsSourceHealth,
  AnalyticsValue,
} from "@foundry/application";

import type { AnalyticsDashboardData } from "../src/analytics-dashboard-runtime";

/**
 * Presents the aggregate projection. Every number arrives with its source,
 * definition and completeness.
 *
 * This view computes no measurement of its own. An absent measurement shows as
 * unavailable, a small breakdown row shows as suppressed, and two providers'
 * counts appear side by side, each with its own label.
 */

const qualityLabels: Readonly<Record<string, string>> = {
  exact: "Exact",
  derived_exact: "Derived from exact counts",
  estimated: "Estimated",
  partial_population: "Partial population",
  best_effort: "Best effort",
  provider_reported: "Provider reported",
  directional: "Directional",
  unreliable: "Unreliable",
};

const freshnessLabels: Readonly<Record<string, string>> = {
  fresh: "Up to date",
  in_progress: "In progress",
  delayed: "Delayed",
  stale: "Stale",
  unknown: "Never collected",
};

const unavailableLabels: Readonly<Record<string, string>> = {
  not_measured: "Not measured",
  provider_omitted: "Provider did not report this",
  source_unavailable: "Source unavailable",
  outside_retention: "Outside the retained window",
  not_supported: "Provider does not support this",
};

const metricLabels: Readonly<Record<string, string>> = {
  "web.visits": "Referral-based visits",
  "web.page_views": "Page views",
  "form.submissions_accepted": "Accepted form submissions",
  "form.submissions_blocked": "Blocked submissions",
  "form.notifications_delivered": "Notifications delivered",
  "form.notifications_failed": "Notifications failed",
  "subscriber.active": "Active subscribers",
  "subscriber.confirmed": "Confirmed",
  "subscriber.unsubscribed": "Unsubscribed",
  "subscriber.hard_bounced": "Hard bounced",
  "subscriber.complained": "Complaints",
  "subscriber.net_growth": "Net growth",
  "campaign.sent": "Sent",
  "campaign.delivered": "Delivered",
  "campaign.soft_bounced": "Soft bounced",
  "campaign.hard_bounced": "Hard bounced",
  "campaign.complained": "Complaints",
  "campaign.unsubscribed": "Unsubscribed",
  "campaign.unique_clicks_reported": "Unique clicks",
  "campaign.unique_opens_reported": "Unique opens",
  "form.conversion_rate": "Estimated conversion",
  "web.vitals.lcp_p75": "LCP (75th percentile)",
  "web.vitals.inp_p75": "INP (75th percentile)",
  "web.vitals.cls_p75": "CLS (75th percentile)",
};

function metricLabel(metricKey: string) {
  return metricLabels[metricKey] ?? metricKey;
}

function formatValue(value: AnalyticsValue, unit: string) {
  if (value.state === "suppressed") return value.label;
  if (value.state === "unavailable") {
    return unavailableLabels[value.reason] ?? "Unavailable";
  }
  if (unit === "ratio") return `${(value.value * 100).toFixed(1)}%`;
  if (unit === "milliseconds") return `${Math.round(value.value)} ms`;
  if (unit === "score") return value.value.toFixed(2);
  return value.value.toLocaleString("en-CA");
}

function ReadingCell({
  reading,
}: {
  reading: AnalyticsReading | AnalyticsDerivedRatio;
}) {
  const isDerived = !("source" in reading);
  const unavailable = reading.value.state === "unavailable";
  return (
    <div className="analytics-metric">
      <dt>{metricLabel(reading.metricKey)}</dt>
      <dd className={unavailable ? "analytics-value-unavailable" : undefined}>
        {formatValue(reading.value, reading.unit)}
      </dd>
      <p className="analytics-metric-meta">
        <span className={`analytics-quality quality-${reading.quality}`}>
          {qualityLabels[reading.quality] ?? reading.quality}
        </span>
        {isDerived ? null : (
          <>
            {" · "}
            <span>
              {reading.sourceName ?? "no source"}
              {reading.sourceMetric === null
                ? ""
                : ` · ${reading.sourceMetric}`}
              {reading.definitionVersion === null
                ? ""
                : ` · definition v${reading.definitionVersion}`}
            </span>
            {" · "}
            <span>
              {freshnessLabels[reading.freshness] ?? reading.freshness}
            </span>
          </>
        )}
      </p>
      <p className="analytics-metric-definition">{reading.definition}</p>
      {isDerived ? null : (
        <p className="analytics-metric-definition">
          {reading.observedAt === null
            ? "No observation recorded yet."
            : `Observed ${reading.observedAt}; complete through ${reading.completeThrough}.`}
          {reading.unavailableBuckets > 0
            ? ` ${reading.unavailableBuckets} of ${
                reading.measuredBuckets + reading.unavailableBuckets
              } buckets were not measured.`
            : ""}
        </p>
      )}
    </div>
  );
}

function SourceHealthTable({
  sources,
}: {
  sources: ReadonlyArray<AnalyticsSourceHealth>;
}) {
  if (sources.length === 0) {
    return (
      <p className="analytics-empty">
        No source has reported yet. Every measurement below is unavailable.
      </p>
    );
  }
  return (
    <div className="inventory-table" role="table" aria-label="Source health">
      <div className="inventory-row inventory-head" role="row">
        <span role="columnheader">Source</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Complete through</span>
        <span role="columnheader">Last success</span>
      </div>
      {sources.map((source) => (
        <div
          className="inventory-row"
          role="row"
          key={`${source.source}:${source.sourceName}`}
        >
          <strong role="cell">
            {source.sourceName} · {source.source}
          </strong>
          <span role="cell" className="state-label">
            {source.status}
            {source.errorCode === null ? "" : ` (${source.errorCode})`}
            {source.nextRetryAt === null
              ? ""
              : ` · retry ${source.nextRetryAt}`}
          </span>
          <span role="cell">{source.completeThrough ?? "Never"}</span>
          <span role="cell">{source.lastSuccessAt ?? "Never"}</span>
        </div>
      ))}
    </div>
  );
}

export function AnalyticsDashboard({
  analytics,
}: {
  analytics: AnalyticsDashboardData | null;
}) {
  if (analytics === null) {
    return (
      <section aria-labelledby="analytics-heading">
        <div className="dashboard-section-heading">
          <div>
            <h2 id="analytics-heading">Analytics</h2>
            <p>
              The aggregate read model is unavailable, so no measurement is
              shown here.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const { overview, content, forms, audience, campaigns, health } = analytics;
  // Two web sources reporting one referrer arrive as two rows. The source
  // name tells them apart, and is shown only when there is more than one.
  const referrerSourceNames = new Set(
    overview.referrers.map((row) => row.sourceName),
  );

  return (
    <section aria-labelledby="analytics-heading" className="analytics">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="analytics-heading">Analytics</h2>
          <p>
            {overview.range.fromLocalDate} to {overview.range.toLocalDate} in{" "}
            {overview.range.timeZone} ({overview.range.startUtc} to{" "}
            {overview.range.endUtc} UTC), read from {overview.range.granularity}
            {" facts"}.
            {overview.range.containsIncompleteBucket
              ? " The most recent bucket is still in progress."
              : ""}
            {overview.range.clampedToRetention
              ? " Part of this range is older than the retained window."
              : ""}
          </p>
        </div>
      </div>

      <h3>Overview</h3>
      <dl className="analytics-grid">
        {overview.metrics.map((reading) => (
          <ReadingCell
            key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
            reading={reading}
          />
        ))}
      </dl>

      {overview.referrers.length === 0 ? null : (
        <>
          <h3>Where visits came from</h3>
          <div
            className="inventory-table"
            role="table"
            aria-label="Referrers"
          >
            <div className="inventory-row inventory-head" role="row">
              <span role="columnheader">Referrer</span>
              <span role="columnheader">Page views</span>
            </div>
            {overview.referrers.map((row) => (
              <div
                className="inventory-row"
                role="row"
                key={`${row.dimensionKey}:${row.dimensionValue}:${row.comparabilitySignature}`}
              >
                <strong role="cell">
                  {row.dimensionValue}
                  {referrerSourceNames.size > 1 ? (
                    <span className="analytics-note"> {row.sourceName}</span>
                  ) : null}
                </strong>
                <span role="cell">{formatValue(row.value, "count")}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h3>Content</h3>
      {content.items.length === 0 ? (
        <p className="analytics-empty">
          No content measurement has been projected for this range.
        </p>
      ) : (
        content.items.map((item) => (
          <div className="analytics-subject" key={item.subjectId}>
            <h4>{item.subjectId}</h4>
            <dl className="analytics-grid">
              {[...item.readings, ...item.vitals].map((reading) => (
                <ReadingCell
                  key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
                  reading={reading}
                />
              ))}
            </dl>
          </div>
        ))
      )}

      <h3>Forms</h3>
      {forms.items.length === 0 ? (
        <p className="analytics-empty">
          No form measurement has been projected for this range.
        </p>
      ) : (
        forms.items.map((item) => (
          <div className="analytics-subject" key={item.subjectId}>
            <h4>{item.subjectId}</h4>
            <dl className="analytics-grid">
              <ReadingCell reading={item.accepted} />
              <ReadingCell reading={item.blocked} />
              <ReadingCell reading={item.notificationsDelivered} />
              <ReadingCell reading={item.notificationsFailed} />
              <ReadingCell reading={item.impressions} />
              <ReadingCell reading={item.conversionRate} />
            </dl>
          </div>
        ))
      )}

      <h3>Audience</h3>
      <dl className="analytics-grid">
        {audience.metrics.map((reading) => (
          <ReadingCell
            key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
            reading={reading}
          />
        ))}
      </dl>

      <h3>Campaigns</h3>
      {campaigns.items.length === 0 ? (
        <p className="analytics-empty">
          No campaign measurement has been projected for this range.
        </p>
      ) : (
        campaigns.items.map((item) => (
          <div className="analytics-subject" key={item.subjectId}>
            <h4>{item.subjectId}</h4>
            {item.providerChanged ? (
              <p className="analytics-warning" role="note">
                More than one delivery provider reported this campaign. Their
                definitions differ, so the series are shown separately and are
                never added together.
              </p>
            ) : null}
            <dl className="analytics-grid">
              {item.readings.map((reading) => (
                <ReadingCell
                  key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
                  reading={reading}
                />
              ))}
            </dl>
            {item.collapsedEngagement.length === 0 ? null : (
              <details className="analytics-collapsed">
                <summary>Reported engagement signals</summary>
                <p className="analytics-metric-definition">
                  Privacy proxies, security scanners and link protection can
                  all trigger these. They are not evidence that a person read
                  or acted on the message.
                </p>
                <dl className="analytics-grid">
                  {item.collapsedEngagement.map((reading) => (
                    <ReadingCell
                      key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
                      reading={reading}
                    />
                  ))}
                </dl>
              </details>
            )}
          </div>
        ))
      )}

      <h3>Data health</h3>
      <SourceHealthTable sources={health.sources} />
      {health.disagreements.length === 0 ? null : (
        <div className="analytics-warning" role="note">
          <p>
            Two sources measured the same outcome differently. Both are shown;
            neither replaces the other.
          </p>
          <ul>
            {health.disagreements.map((disagreement) => (
              <li key={disagreement.outcome}>
                <strong>{disagreement.outcome}</strong>:{" "}
                {disagreement.readings
                  .map(
                    (reading) =>
                      `${reading.sourceName ?? reading.source} reported ${formatValue(
                        reading.value,
                        "count",
                      )} (${qualityLabels[reading.quality] ?? reading.quality})`,
                  )
                  .join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="analytics-metric-definition">
        Aggregate facts are retained for {health.retention.aggregateFactMonths}{" "}
        months and hourly facts for {health.retention.hourlyFactDays} days.
        Cloudflare Web Analytics exposes{" "}
        {health.retention.cloudflareWebAnalyticsMonths} months and Analytics
        Engine {health.retention.analyticsEngineMonths} months at source.
        {health.earliestFactInstant === null
          ? " No fact has been projected yet."
          : ` The earliest projected fact is ${health.earliestFactInstant}.`}
      </p>
    </section>
  );
}

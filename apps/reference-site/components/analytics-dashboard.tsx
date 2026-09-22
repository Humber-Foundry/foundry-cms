import type {
  AnalyticsDerivedRatio,
  AnalyticsReading,
  AnalyticsSourceHealth,
  AnalyticsTrafficDay,
  AnalyticsValue,
} from "@humber-foundry/application";

import type { AnalyticsDashboardData } from "../src/analytics-dashboard-runtime";
import { reportingPeriodDays } from "../src/analytics-reporting-period";
import { HelpTip } from "./help-tip";

/**
 * The Visitors screen.
 *
 * Every number comes from the aggregate read model. This view works nothing
 * out for itself apart from the change against the period before, which it
 * takes from two readings the read model produced. A measurement that is
 * missing says which part of the site could not report it, instead of
 * blanking the screen.
 */

/** Plain names for the systems that produce a number. */
const sourceNames: Readonly<Record<string, string>> = {
  analytics_engine: "your site's own counter",
  cloudflare_web: "the traffic service",
  d1: "your site's records",
  provider: "the email service",
};

const qualityNotes: Readonly<Record<string, string>> = {
  exact: "Counted exactly",
  derived_exact: "Worked out from exact counts",
  estimated: "A close estimate",
  partial_population: "From some browsers only",
  best_effort: "Best effort, some may be missed",
  provider_reported: "Reported by the email service",
  directional: "A guide, not an exact figure",
  unreliable: "Not reliable",
};

const freshnessNotes: Readonly<Record<string, string>> = {
  fresh: "Up to date",
  in_progress: "Today is still being counted",
  delayed: "Running behind",
  stale: "Out of date",
  unknown: "Nothing counted yet",
};

const sourceStatusNames: Readonly<Record<string, string>> = {
  healthy: "Working normally",
  delayed: "Running behind",
  partial: "Reporting part of the picture",
  unavailable: "Not reporting",
};

const metricNames: Readonly<Record<string, string>> = {
  "web.visits": "Visits",
  "web.page_views": "Page views",
  "form.submissions_accepted": "Messages received",
  "form.submissions_blocked": "Blocked by the spam check",
  "form.notifications_delivered": "Alerts sent to you",
  "form.notifications_failed": "Alerts that failed",
  "subscriber.active": "People on your list",
  "subscriber.confirmed": "Joined",
  "subscriber.unsubscribed": "Left",
  "subscriber.hard_bounced": "Addresses that do not work",
  "subscriber.complained": "Marked as spam",
  "subscriber.net_growth": "Change in list size",
  "campaign.sent": "Sent",
  "campaign.delivered": "Delivered",
  "campaign.soft_bounced": "Held up",
  "campaign.hard_bounced": "Could not be delivered",
  "campaign.complained": "Marked as spam",
  "campaign.unsubscribed": "Left the list",
  "campaign.unique_clicks_reported": "Clicked a link",
  "campaign.unique_opens_reported": "Opened",
  "form.conversion_rate": "Messages for every form seen",
  "web.vitals.lcp_p75": "Time to show the main content",
  "web.vitals.inp_p75": "Time to answer a tap",
  "web.vitals.cls_p75": "Movement while the page loads",
};

function metricName(metricKey: string) {
  return metricNames[metricKey] ?? metricKey;
}

function sourceName(source: string | null | undefined) {
  if (source === null || source === undefined) return "your site";
  return sourceNames[source] ?? "your site";
}

/** Says, in plain words, why a number is missing and who should have it. */
function absenceSentence(value: AnalyticsValue, source: string | null) {
  if (value.state !== "unavailable") return "";
  const who = sourceName(source);
  switch (value.reason) {
    case "source_unavailable":
      return `Not shown, because ${who} is not reporting.`;
    case "provider_omitted":
      return `Not shown, because ${who} did not report it.`;
    case "not_supported":
      return `Not shown, because ${who} does not report it.`;
    case "outside_retention":
      return "Not shown, because this period is older than the figures kept.";
    default:
      return "Nothing has been counted for this period yet.";
  }
}

function formatNumber(value: number) {
  return value.toLocaleString("en-CA");
}

function formatValue(value: AnalyticsValue, unit: string) {
  if (value.state === "suppressed") return value.label;
  if (value.state === "unavailable") return "No figure";
  if (unit === "ratio") return `${(value.value * 100).toFixed(1)}%`;
  if (unit === "milliseconds") return `${Math.round(value.value)} ms`;
  if (unit === "score") return value.value.toFixed(2);
  return formatNumber(value.value);
}

/**
 * A day as the owner reads it, in the site's own reporting time zone. A fact
 * bucket starts at midnight UTC, which is a different clock time here, so the
 * label has to be worked out in the reporting zone or a bar reads as the
 * wrong day.
 */
function dayLabel(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    day: "numeric",
    month: "short",
  }).format(new Date(Date.parse(instant)));
}

/** The number in a value, or null when there is none to read. */
function availableNumber(value: AnalyticsValue): number | null {
  return value.state === "available" ? value.value : null;
}

function readingValue(reading: AnalyticsReading | undefined) {
  if (reading === undefined) return null;
  return availableNumber(reading.value);
}

/** "Up 12% on the 7 days before", and the plain cases around it. */
function changeSentence(
  current: number | null,
  previous: number | null,
  periodDays: number,
) {
  const before = `on the ${periodDays} days before`;
  if (current === null || previous === null) {
    return `No figure for the ${periodDays} days before.`;
  }
  if (previous === 0) {
    return current === 0
      ? `No change ${before}.`
      : `Up from none ${before}.`;
  }
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return `No change ${before}.`;
  return change > 0
    ? `Up ${change}% ${before}.`
    : `Down ${Math.abs(change)}% ${before}.`;
}

function HeadlineNumber({
  reading,
  previous,
  periodDays,
  help,
}: {
  reading: AnalyticsReading | undefined;
  previous: AnalyticsReading | undefined;
  periodDays: number;
  help: string;
}) {
  if (reading === undefined) return null;
  const unavailable = reading.value.state === "unavailable";
  return (
    <div className="analytics-headline">
      <p className="analytics-headline-label">
        {metricName(reading.metricKey)}
        <HelpTip label={`What is ${metricName(reading.metricKey)}?`}>
          {help}
        </HelpTip>
      </p>
      <p
        className={
          unavailable
            ? "analytics-headline-value analytics-value-unavailable"
            : "analytics-headline-value"
        }
      >
        {formatValue(reading.value, reading.unit)}
      </p>
      <p className="analytics-headline-note">
        {unavailable
          ? absenceSentence(reading.value, reading.source)
          : changeSentence(
              readingValue(reading),
              readingValue(previous),
              periodDays,
            )}
      </p>
    </div>
  );
}

const chartBarWidth = 5;
const chartBarGap = 5;
/**
 * The chart is four times as wide as it is tall, in the stylesheet and in the
 * drawing. Matching them keeps the scale even, so a bar's rounded top is not
 * stretched sideways.
 */
const chartAspect = 4;

/**
 * Page views each day, drawn as plain SVG. There is no charting library: the
 * shape is a row of bars, and the tallest day sets the scale.
 */
function PageViewChart({
  days,
  periodDays,
  timeZone,
}: {
  days: ReadonlyArray<AnalyticsTrafficDay>;
  periodDays: number;
  timeZone: string;
}) {
  const counted = days.filter((day) => day.pageViews.state === "available");
  if (counted.length === 0) {
    return (
      <p className="analytics-empty">
        No day in the last {periodDays} days has been counted yet.
      </p>
    );
  }
  const highest = counted.reduce((best, day) =>
    (availableNumber(day.pageViews) ?? 0) >
    (availableNumber(best.pageViews) ?? 0)
      ? day
      : best,
  );
  const highestValue = availableNumber(highest.pageViews) ?? 0;
  if (highestValue === 0) {
    return (
      <p className="analytics-empty">
        Every counted day in the last {periodDays} days had no page views.
      </p>
    );
  }
  const step = chartBarWidth + chartBarGap;
  const width = days.length * step - chartBarGap;
  const chartHeight = width / chartAspect;

  return (
    <>
      <svg
        className="analytics-chart"
        viewBox={`0 0 ${width} ${chartHeight}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Page views each day for the last ${periodDays} days. The busiest day was ${dayLabel(
          highest.bucketStartUtc,
          timeZone,
        )} with ${formatNumber(highestValue)} page views.`}
      >
        {days.map((day, index) => {
          const value = availableNumber(day.pageViews);
          const height =
            value === null
              ? 0
              : Math.max(1, (value / highestValue) * chartHeight);
          return (
            <rect
              key={day.bucketStartUtc}
              x={index * step}
              y={chartHeight - height}
              width={chartBarWidth}
              height={height}
              rx={1}
              className={
                value === null
                  ? "analytics-chart-bar analytics-chart-bar-uncounted"
                  : "analytics-chart-bar"
              }
            />
          );
        })}
      </svg>
      <p className="analytics-chart-scale">
        <span>{dayLabel(days[0].bucketStartUtc, timeZone)}</span>
        <span>
          {dayLabel(days[days.length - 1].bucketStartUtc, timeZone)}
        </span>
      </p>
      <p className="analytics-chart-note">
        Busiest day: {dayLabel(highest.bucketStartUtc, timeZone)},{" "}
        {formatNumber(highestValue)} page views.
        {counted.length < days.length
          ? ` ${days.length - counted.length} of these days have not been counted yet.`
          : ""}
      </p>
    </>
  );
}

function ReadingCell({
  reading,
  timeZone,
}: {
  reading: AnalyticsReading | AnalyticsDerivedRatio;
  timeZone: string;
}) {
  const isDerived = !("source" in reading);
  const unavailable = reading.value.state === "unavailable";
  return (
    <div className="analytics-metric">
      <dt>{metricName(reading.metricKey)}</dt>
      <dd className={unavailable ? "analytics-value-unavailable" : undefined}>
        {formatValue(reading.value, reading.unit)}
      </dd>
      <p className="analytics-metric-meta">
        {unavailable
          ? absenceSentence(
              reading.value,
              isDerived ? null : reading.source,
            )
          : `${qualityNotes[reading.quality] ?? "Counted"}${
              isDerived
                ? ""
                : ` · ${freshnessNotes[reading.freshness] ?? "Up to date"}`
            }.`}
      </p>
      <p className="analytics-metric-definition">{reading.definition}</p>
      {isDerived || unavailable ? null : (
        <p className="analytics-metric-definition">
          {`From ${sourceName(reading.source)}`}
          {reading.completeThrough === null
            ? "."
            : `, counted up to ${dayLabel(reading.completeThrough, timeZone)}.`}
          {reading.unavailableBuckets > 0
            ? ` ${reading.unavailableBuckets} of ${
                reading.measuredBuckets + reading.unavailableBuckets
              } days in this period were not counted.`
            : ""}
        </p>
      )}
    </div>
  );
}

function SourceHealthTable({
  sources,
  timeZone,
}: {
  sources: ReadonlyArray<AnalyticsSourceHealth>;
  timeZone: string;
}) {
  if (sources.length === 0) {
    return (
      <p className="analytics-empty">
        Nothing has reported yet, so no number above has a source.
      </p>
    );
  }
  return (
    <div
      className="inventory-table"
      role="table"
      aria-label="Where these numbers come from"
    >
      <div className="inventory-row inventory-head" role="row">
        <span role="columnheader">Where the number comes from</span>
        <span role="columnheader">How it is doing</span>
        <span role="columnheader">Counted up to</span>
        <span role="columnheader">Last worked</span>
      </div>
      {sources.map((source) => (
        <div
          className="inventory-row"
          role="row"
          key={`${source.source}:${source.sourceName}`}
        >
          <strong role="cell">{sourceName(source.source)}</strong>
          <span role="cell" className="state-label">
            {sourceStatusNames[source.status] ?? source.status}
            {source.nextRetryAt === null ? "" : " · trying again shortly"}
          </span>
          <span role="cell">
            {source.completeThrough === null
              ? "Nothing yet"
              : dayLabel(source.completeThrough, timeZone)}
          </span>
          <span role="cell">
            {source.lastSuccessAt === null
              ? "Never"
              : dayLabel(source.lastSuccessAt, timeZone)}
          </span>
        </div>
      ))}
    </div>
  );
}

function PeriodSwitch({ periodDays }: { periodDays: number }) {
  const periods = reportingPeriodDays;
  return (
    <nav className="analytics-period" aria-label="How far back to look">
      {periods.map((days) => (
        <a
          key={days}
          href={`/dash/analytics?days=${days}`}
          className={
            days === periodDays
              ? "analytics-period-option analytics-period-chosen"
              : "analytics-period-option"
          }
          aria-current={days === periodDays ? "page" : undefined}
        >
          Last {days} days
        </a>
      ))}
    </nav>
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
            <h2 id="analytics-heading">Your numbers</h2>
            <p>
              Your visitor numbers cannot be read at the moment, so none are
              shown here. Nothing has been lost; the counting carries on.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const {
    periodDays,
    sample,
    overview,
    traffic,
    content,
    contentTitles,
    contentPaths,
    forms,
    audience,
    campaigns,
    health,
  } = analytics;

  const metricFor = (metricKey: string) =>
    overview.metrics.find((entry) => entry.metricKey === metricKey);
  const previousFor = (metricKey: string) =>
    overview.comparison?.metrics.find(
      (entry) => entry.metricKey === metricKey,
    );

  const topPages = content.items
    .map((item) => ({
      subjectId: item.subjectId,
      reading: item.readings[0],
    }))
    .filter((item) => item.reading !== undefined);
  // ADR-0003 asks for Web Vitals beside the content they belong to. No source
  // collects them yet, so this part of the screen appears only once one does.
  const pageSpeed = content.items.filter((item) => item.vitals.length > 0);
  const timeZone = overview.range.timeZone;

  return (
    <section className="analytics" aria-label="Visitor numbers">
      <PeriodSwitch periodDays={periodDays} />

      {sample ? (
        <p className="analytics-sample-note" role="note">
          These are made-up sample figures for local development. A published
          site shows only its own counted numbers.
        </p>
      ) : null}

      {overview.range.containsIncompleteBucket ||
      overview.range.clampedToRetention ? (
        <p className="analytics-range-note">
          {overview.range.containsIncompleteBucket
            ? "Today is still being counted, so the newest figures will still rise. "
            : ""}
          {overview.range.clampedToRetention
            ? "Part of this period is older than the figures that are kept, so it is left out."
            : ""}
        </p>
      ) : null}

      <div className="analytics-headlines">
        <HeadlineNumber
          reading={metricFor("web.visits")}
          previous={previousFor("web.visits")}
          periodDays={periodDays}
          help="A visit is one arrival from somewhere else, such as a search result or a link. Your site sets no cookies, so it cannot count how many different people these visits are."
        />
        <HeadlineNumber
          reading={metricFor("web.page_views")}
          previous={previousFor("web.page_views")}
          periodDays={periodDays}
          help="One page view is one page of your site opened. A reader who opens three pages counts as three page views."
        />
      </div>

      <h2>Page views each day</h2>
      <PageViewChart
        days={traffic.days}
        periodDays={periodDays}
        timeZone={timeZone}
      />

      <h2>Your most read pages</h2>
      {topPages.length === 0 ? (
        <p className="analytics-empty">
          No page has been counted in the last {periodDays} days.
        </p>
      ) : (
        <ol className="analytics-rank">
          {topPages.map((item) => (
            <li className="analytics-rank-row" key={item.subjectId}>
              <span className="analytics-rank-name">
                {contentTitles[item.subjectId] ?? item.subjectId}
                <span className="analytics-rank-path">
                  {contentPaths[item.subjectId] ?? ""}
                </span>
              </span>
              <span className="analytics-rank-value">
                {formatValue(item.reading.value, "count")}
              </span>
            </li>
          ))}
        </ol>
      )}

      <h2>Where your visits came from</h2>
      <p className="analytics-metric-definition">
        Counted from the page each reader arrived on. A move from one of your
        pages to another is not an arrival, so it is not listed here.
      </p>
      {overview.referrers.length === 0 ? (
        <p className="analytics-empty">
          Nothing has been counted about where visits came from in the last{" "}
          {periodDays} days.
        </p>
      ) : (
        <ol className="analytics-rank">
          {overview.referrers.map((row) => (
            <li
              className="analytics-rank-row"
              key={`${row.dimensionKey}:${row.dimensionValue}:${row.comparabilitySignature}`}
            >
              <span className="analytics-rank-name">{row.dimensionValue}</span>
              <span className="analytics-rank-value">
                {formatValue(row.value, "count")}
              </span>
            </li>
          ))}
        </ol>
      )}

      {pageSpeed.length === 0 ? null : (
        <>
          <h2>How fast your pages are</h2>
          {pageSpeed.map((item) => (
            <div className="analytics-subject" key={item.subjectId}>
              <h3>{contentTitles[item.subjectId] ?? item.subjectId}</h3>
              <dl className="analytics-grid">
                {item.vitals.map((reading) => (
                  <ReadingCell
                    key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
                    reading={reading}
                    timeZone={timeZone}
                  />
                ))}
              </dl>
            </div>
          ))}
        </>
      )}

      <h2>Messages</h2>
      {forms.items.length === 0 ? (
        <p className="analytics-empty">
          No message has been counted in the last {periodDays} days.
        </p>
      ) : (
        forms.items.map((item) => (
          <div className="analytics-subject" key={item.subjectId}>
            <h3>{item.subjectId}</h3>
            <dl className="analytics-grid">
              <ReadingCell reading={item.accepted} timeZone={timeZone} />
              <ReadingCell reading={item.blocked} timeZone={timeZone} />
              <ReadingCell
                reading={item.notificationsDelivered}
                timeZone={timeZone}
              />
              <ReadingCell
                reading={item.notificationsFailed}
                timeZone={timeZone}
              />
              <ReadingCell reading={item.impressions} timeZone={timeZone} />
              <ReadingCell reading={item.conversionRate} timeZone={timeZone} />
            </dl>
          </div>
        ))
      )}

      <h2>Your mailing list</h2>
      {audience.metrics.length === 0 ? (
        <p className="analytics-empty">
          Nothing has been counted about your mailing list in the last{" "}
          {periodDays} days.
        </p>
      ) : (
        <dl className="analytics-grid">
          {audience.metrics.map((reading) => (
            <ReadingCell
              key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
              reading={reading}
              timeZone={timeZone}
            />
          ))}
        </dl>
      )}

      <h2>Newsletters you sent</h2>
      {campaigns.items.length === 0 ? (
        <p className="analytics-empty">
          No newsletter was sent in the last {periodDays} days.
        </p>
      ) : (
        campaigns.items.map((item) => (
          <div className="analytics-subject" key={item.subjectId}>
            <h3>{item.subjectId}</h3>
            {item.providerChanged ? (
              <p className="analytics-warning" role="note">
                More than one email service reported this newsletter. They
                count differently, so the figures are shown apart and are never
                added together.
              </p>
            ) : null}
            <dl className="analytics-grid">
              {item.readings.map((reading) => (
                <ReadingCell
                  key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
                  reading={reading}
                  timeZone={timeZone}
                />
              ))}
            </dl>
            {item.collapsedEngagement.length === 0 ? null : (
              <details className="analytics-collapsed">
                <summary>Opens and clicks</summary>
                <p className="analytics-metric-definition">
                  Privacy tools, security scanners and link checkers all set
                  these off. They are not proof that a person read the message
                  or acted on it.
                </p>
                <dl className="analytics-grid">
                  {item.collapsedEngagement.map((reading) => (
                    <ReadingCell
                      key={`${reading.metricKey}:${reading.comparabilitySignature ?? "none"}`}
                      reading={reading}
                      timeZone={timeZone}
                    />
                  ))}
                </dl>
              </details>
            )}
          </div>
        ))
      )}

      <h2>
        Where these numbers come from
        <HelpTip label="Where do these numbers come from?">
          Each part of your site that counts something reports whether it is
          working. One part running behind does not change a number already
          shown — it only means the newest figures are still on the way.
        </HelpTip>
      </h2>
      <SourceHealthTable sources={health.sources} timeZone={timeZone} />
      {health.disagreements.length === 0 ? null : (
        <div className="analytics-warning" role="note">
          <p>
            Two parts of your site counted the same thing differently. Both are
            shown, and neither replaces the other.
          </p>
          <ul>
            {health.disagreements.map((disagreement) => (
              <li key={disagreement.outcome}>
                {disagreement.readings
                  .map(
                    (reading) =>
                      `${sourceName(reading.source)} counted ${formatValue(
                        reading.value,
                        "count",
                      )}`,
                  )
                  .join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="analytics-metric-definition">
        Your numbers are kept for {health.retention.aggregateFactMonths}{" "}
        months. Nobody is followed from page to page, and no cookie is set to
        count anything here.
      </p>
    </section>
  );
}

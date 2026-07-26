# ADR-0003: Unified privacy-first analytics architecture

- **Status:** Accepted
- **Date:** 2026-07-26

## Context

Foundry CMS must give every site owner useful website, content, form,
subscriber, and campaign reporting inside `/dash` without requiring a separate
analytics product. The same aggregate data must be safely queryable by an MCP
agent.

The dashboard spans measurements with different owners and meanings:

- Cloudflare Web Analytics measures browser page views and referral-based
  visits.
- Workers Analytics Engine can accept custom, non-durable interaction points.
- D1 contains authoritative form, subscriber, campaign, and scheduling records.
- A newsletter provider reports delivery and engagement using its own
  definitions.

Putting these sources on one screen must not imply that they are equally exact
or directly comparable. The design also cannot create visitor profiles, expose
subscriber identities, or turn an aggregate API into an indirect route to
personal data.

This decision builds on the client-owned deployment and capacity findings in
[issue #8](https://github.com/Humber-Foundry/foundry-cms/issues/8), the form
boundary in [ADR-0001](ADR-0001-default-form-handling-adapter.md), and the
newsletter boundary in
[ADR-0002](ADR-0002-default-newsletter-delivery-adapter.md). It resolves
[issue #18](https://github.com/Humber-Foundry/foundry-cms/issues/18).

## Decision

Use a **source-labelled aggregate projection in D1** as the one read model for
the dashboard and MCP.

Cloudflare Web Analytics, Workers Analytics Engine, D1 operational records, and
newsletter-provider reports remain separate authorities. Scheduled projectors
normalize their useful aggregates into a canonical `AnalyticsFact` schema.
Neither the dashboard nor MCP queries source APIs directly.

Core analytics is enabled and health-checked during guided provisioning. It has
no cookie banner dependency because the product itself does not set analytics
cookies, create visitor identifiers, fingerprint, retain raw IP addresses, or
perform session replay. A client's legal review remains responsible for its
complete privacy notice and jurisdiction-specific obligations.

### Responsibility by source

| Source | Owns | Must not be used for |
|---|---|---|
| Cloudflare Web Analytics | Browser page views, referral-based visits, published-path performance, coarse referrer host, and optional Web Vitals | Custom events, UTM attribution, form truth, subscriber truth, or individual journeys |
| Workers Analytics Engine | Best-effort, anonymous, allowlisted interaction counts that Web Analytics cannot express, such as form impressions and CTA activations | Durable business facts, delivery guarantees, visitor/session identity, subscriber events, or the only copy of a metric |
| D1 operational tables | Accepted forms, delivery state, consent/suppression transitions, active-subscriber state, campaign lifecycle, and other transactional facts | Raw request analytics, replayable visitor histories, or copying form/subscriber payloads into analytics |
| Newsletter provider | Provider-reported sent, delivered, bounce, complaint, unsubscribe, open, and click measurements | Canonical consent, subscriber identity, cross-provider comparability, or the dashboard's historical schema |
| D1 `analytics_*` tables | Normalized aggregate snapshots, definitions, source health, completeness, and retained rollups | Subscriber rows, email addresses or hashes, raw provider events, IP addresses, user agents, query strings, or arbitrary dimensions |

Cloudflare Web Analytics remains the traffic authority because it is free,
privacy-first, has no custom-account setup outside Cloudflare, and deliberately
does not support custom events or query-string/UTM collection. Analytics Engine
fills only the small custom-event gap. D1 remains authoritative whenever the
CMS has already committed the underlying operation.

### Canonical vocabulary and source mapping

Metric keys are stable product vocabulary. Provider and platform field names
are stored as source metadata rather than leaking into dashboard queries.

| Canonical metric | Source | Source measurement | Default quality |
|---|---|---|---|
| `web.page_views` | Cloudflare Web Analytics | Page views grouped by host and path, bots excluded where supported | `estimated` when sampled |
| `web.visits` | Cloudflare Web Analytics | Referral-based visits, not unique people or sessions | `estimated` when sampled |
| `web.vitals.lcp_p75`, `web.vitals.inp_p75`, `web.vitals.cls_p75` | Cloudflare Web Analytics | Browser-supported Web Vitals by published path | `partial_population` |
| `content.page_views` | Cloudflare Web Analytics + D1 route history | `web.page_views` joined to the content revision that owned the path in that time bucket | Inherits web quality |
| `interaction.form_impressions` | Analytics Engine | Allowlisted client event when a form becomes viewable | `best_effort` |
| `interaction.cta_activations` | Analytics Engine | Allowlisted client event with public content and CTA IDs | `best_effort` |
| `form.submissions_accepted` | D1 | Committed, non-synthetic form submissions | `exact` |
| `form.submissions_blocked` | D1 | Rejected automated submissions, without payload or reason detail in analytics | `exact` |
| `form.notifications_delivered` | D1 | Completed notification intents | `exact` |
| `form.notifications_failed` | D1 | Exhausted or permanent notification failures | `exact` |
| `subscriber.confirmed` | D1 consent ledger | Confirmed/active transition | `exact` |
| `subscriber.unsubscribed` | D1 suppression ledger | Unsubscribe transition from either local or provider surface | `exact` |
| `subscriber.hard_bounced` | D1 suppression ledger | Applied hard-bounce suppression | `exact` |
| `subscriber.complained` | D1 suppression ledger | Applied complaint suppression | `exact` |
| `subscriber.active` | D1 | Point-in-time count of lawfully active subscribers | `exact` |
| `subscriber.net_growth` | D1 | Confirmed additions minus all suppressing exits in the range | `derived_exact` |
| `campaign.sent` | Provider aggregate report | Provider-defined sent count | `provider_reported` |
| `campaign.delivered` | Provider aggregate report | Receiving server accepted the message; not inbox placement | `provider_reported` |
| `campaign.soft_bounced` | Provider aggregate report | Provider-defined temporary failure | `provider_reported` |
| `campaign.hard_bounced` | Provider aggregate report | Provider-defined permanent failure | `provider_reported` |
| `campaign.complained` | Provider aggregate report | Provider-reported spam complaint | `provider_reported` |
| `campaign.unsubscribed` | Provider aggregate report reconciled with D1 | Campaign-attributed unsubscribe | `provider_reported` |
| `campaign.unique_opens_reported` | Provider aggregate report | Provider-defined unique opens | `unreliable` |
| `campaign.unique_clicks_reported` | Provider aggregate report | Provider-defined unique clicks | `directional` |

The canonical vocabulary represents an occurrence as a metric, not as a
retained person-level event. Compliance-critical newsletter webhooks still
update the operational suppression ledger promptly. Analytics counts are
projected only after the personal fields have been stripped.

The following analytics fields are prohibited at ingestion: visitor, session,
request, subscriber, contact, or provider-message identifiers; email address or
hash; IP address; user agent; exact geographic coordinate; raw referrer path;
query string; free-form URL; and free-form event properties. Public, stable CMS
IDs for a site, content item, form, CTA, and campaign are permitted dimensions
because they identify product objects, not people.

### Canonical aggregate schema

Every normalized row implements this logical contract:

```text
AnalyticsFact {
  schemaVersion
  siteId
  metricKey
  bucketStartUtc
  bucketEndUtc
  granularity                 // hour | day | campaign | current
  subjectType                 // site | content | form | cta | campaign
  subjectId                   // public CMS object ID; never a person ID
  dimensions                  // fixed allowlist; normally empty
  value
  unit                        // count | ratio | milliseconds | score
  source                      // cloudflare_web | analytics_engine | d1 | provider
  sourceName                  // e.g. cloudflare or brevo
  sourceMetric
  definitionVersion
  quality                     // exact | estimated | best_effort | ...
  sampleInterval
  observedAt
  completeThrough
  revision
}
```

The physical D1 model uses columns and normalized, allowlisted dimension tables
rather than an unrestricted JSON property bag. Key columns are non-null; a site
total uses its site ID as the subject and empty dimension sentinels. Its
uniqueness key is:

```text
(site_id, metric_key, bucket_start_utc, granularity,
 subject_type, subject_id, dimension_key, dimension_value, source)
```

A projector upserts the current row only when its incoming revision is newer.
Material changes append revision metadata to a separate bounded audit table so
ordinary queries cannot double-count old values. Ratios are computed at read
time from stored numerators and denominators; they are not accumulated as if
they were counts.

Source snapshots also store:

```text
AnalyticsSourceState {
  source
  status                      // healthy | delayed | partial | unavailable
  lastAttemptAt
  lastSuccessAt
  completeThrough
  nextRetryAt
  errorCode                   // stable, non-secret
  definitionVersion
}
```

### Collection and projection

#### Web and content

- Provisioning enables Cloudflare Web Analytics for the production hostname and
  verifies a beacon plus a successful aggregate query.
- The projector requests only the required host/path/referrer-host and Web
  Vitals aggregates. V1 does not import country, browser, operating-system, or
  device breakdowns into Foundry.
- Query strings are never imported. Referrer detail is reduced to a normalized
  host/channel before it reaches the read model.
- Published route history maps an aggregate path and time bucket to the
  applicable stable content ID. A route change does not merge two content
  objects accidentally.
- Missing beacons, blockers, unsupported browsers, platform sampling, and bot
  filtering are represented in quality metadata. A visit is labelled
  “referral-based visit,” never “unique visitor” or “session.”

#### Anonymous interactions

- A same-origin, schema-bound endpoint accepts only enumerated event kinds and
  public CMS object IDs that exist in the published site definition.
- The collector discards request headers and query strings and writes no
  request, visitor, or session identifier. Worker observability must not log the
  request body or full URL for this route.
- `form_impression` and `cta_activation` are the initial allowed client events.
  A successful form submission is counted from the D1 transaction, not from a
  browser success event.
- Analytics Engine writes are non-blocking and best-effort. Collection failure
  never changes the result of a form, publish, consent, or send operation.
- Every Analytics Engine query weights values by `_sample_interval`. Its custom
  points are rolled into D1 before the three-month platform retention expires.

#### Forms and subscribers

- Projectors count immutable D1 operational events; they do not copy submission
  content, contact details, consent evidence, or suppression reasons into
  analytics.
- Synthetic health submissions are tagged operationally and excluded.
- `form_conversion_rate` is shown only as
  `submissions_accepted / form_impressions` and is labelled an estimate because
  its denominator is best-effort. Accepted submissions remain visible as an
  exact count beside it.
- Subscriber growth counts state transitions, not provider contact totals. A
  point-in-time active count is snapshotted daily so later erasure does not
  require reconstructing historical identities.

#### Campaigns and provider replacement

- Compliance webhooks and aggregate reporting are two separate paths.
  Subscriber-level webhook data updates the operational ledger; provider report
  polling supplies campaign analytics.
- Webhook event counts are not added to provider report counts. Polling replaces
  the prior snapshot revision and reconciles webhook coverage.
- Historical facts retain `sourceName`, provider definition, filtering
  capability, and retrieval time. Changing provider does not rewrite history.
- The dashboard may sum counts across providers only when the adapter declares
  the metric definitions compatible. Otherwise it shows separate series with a
  provider-change marker.
- Provider migration never changes stable Foundry campaign IDs.

### Newsletter analytics adapter contract

`NewsletterDeliveryAdapter` gains a provider-neutral analytics boundary:

```text
getAnalyticsCapabilities() -> AnalyticsCapabilities
getCampaignAnalytics(providerCampaignId, asOf?) -> CampaignAnalyticsSnapshot
listChangedCampaignAnalytics(cursor, since) -> Page<CampaignAnalyticsSnapshot>
getAnalyticsHealth() -> ProviderAnalyticsHealth
```

`AnalyticsCapabilities` declares, per metric:

```text
supported
providerMetric
definition
definitionVersion
countingMode                  // total | unique | inferred
denominator
botFiltering                 // unavailable | included | excluded | selectable
privacyProxyFiltering        // unavailable | included | excluded | selectable
expectedLag
mutableFor
```

`CampaignAnalyticsSnapshot` contains only a stable Foundry campaign mapping,
aggregate values, observation time, completeness, provider revision/cursor, and
the capability metadata needed to interpret it. The analytics return type
cannot contain an address, contact ID, message ID, recipient row, or raw event.
Adapters must reject and alert on such leakage at the boundary.

An unsupported metric is an explicit `unavailable` value, never zero. A delayed
metric retains its previous value with `completeThrough` and a stale status.
Differently named provider metrics map to canonical keys only after the adapter
documents their definitions.

### Trustworthiness of email metrics

Campaign reporting is ordered by decision value:

1. **Sent, delivered, hard bounce, complaint, and unsubscribe** are primary
   operational outcomes. “Delivered” means accepted by the receiving server,
   not read or placed in an inbox.
2. **Soft bounce** is useful for delivery-health trends but can later change.
3. **Bot-filtered unique clicks**, where a provider documents the filter, are a
   directional engagement signal. Security scanners and link protection can
   still inflate or alter clicks.
4. **Unique opens** are displayed only in a collapsed “reported engagement
   signals” area with an `unreliable` badge. Apple Mail Privacy Protection can
   fetch remote content in the background before a person reads it, and provider
   handling of privacy proxies and bots changes over time.

Foundry does not display click-to-open rate, does not rank content by opens, and
does not compare open rates across providers. Open and click metrics never
trigger subscriber automation or personalize a subscriber record in Foundry.
Where Brevo exposes filters for Apple privacy-proxy and bot activity, the
adapter records which filters were used; it does not relabel the result as
exact.

### Privacy, retention, and deletion

- Cloudflare Web Analytics currently exposes six months of data; unsampled
  beacon data is retained for seven days before long-term aggregation and query
  sampling. Foundry records the returned sampling metadata.
- Analytics Engine retains points for three months. Foundry uses it only for
  anonymous best-effort events and materializes aggregates promptly.
- D1 aggregate facts default to **25 months**, permitting a year-over-year
  comparison plus reconciliation time. Hourly facts compact to daily facts
  after 90 days.
- Provider aggregate snapshots follow the same 25-month default. Operational
  consent, suppression, form, and audit retention remain governed by their own
  policies; this ADR does not shorten compliance evidence.
- Verified raw provider webhook payloads may exist only in the bounded
  operational diagnostic path from ADR-0002. They are never analytics facts.
- Removing a content item preserves its aggregate historical facts under its
  tombstoned public content ID; the UI shows its last non-sensitive title.
- Erasing a subscriber removes or tombstones the operational identity as policy
  requires. Historical site/campaign counts do not change because they cannot
  identify that subscriber.
- Disabling analytics stops new Web Analytics and Analytics Engine collection,
  revokes the analytics API token, and deletes D1 aggregate facts after an
  explicit owner confirmation. Cloudflare-held data ages out under Cloudflare's
  product retention, Analytics Engine does not promise selective point
  deletion, and deleted D1 data can remain recoverable during the account's
  Time Travel or backup window. The UI must state those residual windows before
  confirmation.
- Site decommissioning revokes provider and Cloudflare tokens first, removes
  scheduled projectors, exports an optional aggregate-only archive, deletes D1
  analytics tables, and records the remaining Cloudflare/provider expiry
  windows.

All timestamps are stored as UTC instants. A site has one configured IANA
reporting time zone. Query boundaries are converted from that zone to UTC, and
responses include the zone and UTC interval. Daylight-saving transitions are
handled as real 23- or 25-hour local days rather than shifting events.
Compaction writes the replacement daily fact and removes its covered hourly
facts in one D1 transaction. The query service selects one stored granularity
for every interval, so compaction cannot double-count a range.

### Late data and reconciliation

- D1 operational facts project within minutes and are reconciled nightly.
- Web Analytics and Analytics Engine refresh the previous seven UTC days every
  night so sampling and late platform aggregation may revise a bucket.
- Recently sent provider campaigns poll frequently for 72 hours, daily through
  30 days, and once more at 90 days. The adapter may request a longer mutable
  window.
- A revision replaces a previous value; it is not added to it. Material changes
  after a report was viewed are audit-visible.
- Dashboard ranges containing an incomplete bucket are marked “in progress.”
  Sources with different `completeThrough` values do not silently share one
  freshness label.

### Isolation, credentials, and caching

One client-owned Cloudflare account per installation is a security boundary as
well as the default ownership model. Provisioning creates:

- one Web Analytics site for the production hostname;
- one installation-named Analytics Engine dataset and Worker binding;
- D1 analytics tables in the installation database; and
- a client-owned Cloudflare API token with `Account Analytics: Read`, restricted
  to the relevant account and zones, stored only as a Worker secret.

The Analytics Engine SQL API is account-scoped. Therefore a shared agency
Cloudflare account is not an acceptable strict-isolation mode merely because
each site uses a different dataset name. Shared-account hosting must either add
a separately reviewed query broker that enforces dataset isolation or omit
Analytics Engine; the default remains one client account per installation.

Dashboard and MCP calls use the application-layer query service over D1. They
never receive the Cloudflare or provider token. Query responses use private,
per-site in-process caching for five minutes for current data and one hour for
closed historical ranges. They are not placed in a public CDN cache. Cache keys
include site, authorization scope, metric definition version, range,
granularity, and reporting time zone.

### Dashboard information architecture

The dashboard answers a small set of decisions:

| View | Primary question | Default contents |
|---|---|---|
| Overview | Is attention and response improving? | Referral-based visits, page views, accepted forms, active subscribers/net growth, campaign deliveries, comparison period, source freshness |
| Content | What should we improve or publish more of? | Published content by page views, visit share, CTA activations, form contribution, publish/revision markers, Web Vitals warnings |
| Forms | Are forms being seen, accepted, and acted on? | Exact accepted count, estimated conversion, notifications delivered/failed, trend by form |
| Audience | Is the reachable audience growing safely? | Active, confirmed, unsubscribed, hard-bounced, complained, and net growth; no subscriber table |
| Campaigns | Did delivery succeed and did it lead to useful action? | Sent, delivered, bounce, complaint, unsubscribe, directional clicks, unreliable opens collapsed, source definitions |
| Data health | Can these numbers be trusted right now? | Last success, complete-through time, sampling/quality, provider filters, stale sources, retry status, quota warnings |

No dashboard view exposes arbitrary dimension builders, person-level drilldown,
raw SQL, heatmaps, session replay, or subscriber export. Totals for a business
object may be small, but secondary dimension rows are suppressed below five and
returned as “fewer than 5.” V1 does not provide geographic or demographic
segmentation.

Representative D1 queries use indexed aggregate facts:

```sql
-- Trend for one metric and source.
SELECT bucket_start_utc, SUM(value) AS value,
       MIN(complete_through) AS complete_through
FROM analytics_facts
WHERE site_id = ?1
  AND metric_key = ?2
  AND source = ?3
  AND bucket_start_utc >= ?4
  AND bucket_start_utc < ?5
  AND granularity = ?6
GROUP BY bucket_start_utc
ORDER BY bucket_start_utc;
```

```sql
-- Content performance, preserving source quality.
SELECT subject_id, SUM(value) AS page_views,
       quality
FROM analytics_facts
WHERE site_id = ?1
  AND metric_key = 'content.page_views'
  AND subject_type = 'content'
  AND bucket_start_utc >= ?2
  AND bucket_start_utc < ?3
  AND granularity = ?4
GROUP BY subject_id, quality
ORDER BY page_views DESC
LIMIT ?5;
```

```sql
-- Exact form numerator and best-effort denominator are returned separately.
SELECT metric_key, SUM(value) AS value, source, quality
FROM analytics_facts
WHERE site_id = ?1
  AND subject_type = 'form'
  AND subject_id = ?2
  AND metric_key IN (
    'form.submissions_accepted',
    'interaction.form_impressions'
  )
  AND bucket_start_utc >= ?3
  AND bucket_start_utc < ?4
  AND granularity = ?5
GROUP BY metric_key, source, quality;
```

### Read-only MCP contract

MCP receives the same application-layer results as `/dash`, with typed,
read-only tools:

```text
analytics.summary(range, comparison?)
analytics.content(range, limit?, cursor?)
analytics.forms(range)
analytics.audience(range)
analytics.campaigns(range, limit?, cursor?)
analytics.campaign(campaignId)
analytics.health()
```

Ranges are bounded to retained data, limits are capped, and the service accepts
no raw SQL, arbitrary metric name, arbitrary dimension, subscriber selector, or
free-form filter. Every response includes source, definition, quality,
`observedAt`, and `completeThrough`. MCP applies the same small-cell suppression
as the human dashboard and records query name, actor, site, range, and result
count in the audit trail without copying the result body.

Analytics credentials grant no draft, publish, subscriber-export, campaign-send,
or provider-management capability. An agent may use aggregate findings to
propose a draft, but the normal preview and approval boundary still applies.

### Free-tier usage model

This model is subordinate to the current, full capacity research in
[issue #8](https://github.com/Humber-Foundry/foundry-cms/issues/8).

For the default one-site client-owned account:

- Cloudflare Web Analytics is free. A proxied site does not consume the
  non-proxied ten-site allowance.
- Analytics Engine currently includes 100,000 data points and 10,000 read
  queries per day on Workers Free and retains data for three months. A normal
  site writes only allowlisted custom interactions, not every page view. At
  2,000 custom interactions and fewer than 50 projector queries per day, this is
  below 2% and 0.5% of those daily allowances.
- A representative 50-route, 10-form site with 25 months of daily source-labelled
  facts remains on the order of hundreds of thousands of narrow rows, well below
  the free D1 500 MB per-database limit. Normal indexed dashboard queries and
  daily rollups are far below 5 million rows read and 100,000 rows written per
  day.
- The Cloudflare GraphQL API default user limit is 300 queries per five minutes.
  Scheduled materialization and server-side caching keep Foundry far below it.
- Provider polling is bounded per changed campaign and uses cursors,
  conditional requests where available, and backoff. A provider quota is
  reported as source degradation rather than retried aggressively.

Provisioning warns at 70% and becomes critical at 90% of measured Analytics
Engine, D1, or external API allowance. Anonymous Analytics Engine collection is
the first analytics feature shed under pressure. D1 business writes and
provider compliance ingestion take priority. A busy individual site or a
deliberate shared-account deployment follows issue #8's Workers Paid decision;
analytics does not independently require a paid baseline.

### Failure and degradation

| Failure | Product behaviour |
|---|---|
| Web Analytics query unavailable or token revoked | Serve prior D1 facts with stale timestamp; show web/content as unavailable for the missing interval; retry with backoff; do not estimate from another source |
| Analytics Engine write/query unavailable or sampled away | Continue the user operation; mark custom interaction metrics partial; exact D1 form counts remain available |
| D1 analytics read unavailable | `/dash` and MCP analytics return a typed temporary error; no source API bypass; operational behaviour follows its own D1 contract |
| D1 projector write unavailable | Keep source cursor unchanged, retry idempotently, and show the read model stale; never advance `completeThrough` before commit |
| Provider webhook unavailable | Provider retries where supported; poll as backstop; compliance health is critical and may block sending under ADR-0002 |
| Provider reporting API unavailable or quota-limited | Retain prior campaign snapshot, show provider source stale, honor `Retry-After`, and keep campaign values separate from D1 counts |
| Provider omits a metric | Return `unavailable`, never zero and never infer it from a different event |
| Late or revised source data | Upsert a higher revision, retain observation metadata, and make material post-view revisions audit-visible |
| Free-tier ceiling approached | Shed anonymous custom telemetry first, reduce refresh frequency, warn visibly, and never claim that durable operations succeeded because analytics recorded them |

Source health is part of every response, not a separate status page that users
must remember to check.

## Consequences

- A newly provisioned site has useful analytics without another analytics
  account, cookie identifier, or separate client dashboard.
- The read path is simple and fast because `/dash` and MCP query one indexed D1
  projection.
- D1 rollups preserve useful trends beyond Cloudflare Web Analytics' six-month
  access window without retaining visitor records.
- Analytics Engine remains optional to the correctness of the product. Its loss
  affects estimates, not accepted forms, consent, suppressions, or sends.
- Provider replacement requires a new adapter mapping, not a dashboard or
  historical-schema redesign.
- Source, definition, freshness, sampling, and quality metadata add visible
  complexity, but prevent false precision and unsafe blending.
- Open and click reporting is intentionally less prominent than delivery,
  conversion, complaint, unsubscribe, and downstream operational outcomes.
- Strict isolation reinforces the product's one-client-owned-Cloudflare-account
  deployment model.

## Alternatives considered

- **Store all events in D1** — rejected because page-level event storage would
  recreate visitor-like raw records, consume durable capacity, and duplicate
  Cloudflare's privacy-first aggregate service.
- **Use Analytics Engine for every metric** — rejected because writes are
  best-effort, data is retained for three months, adaptive sampling applies, and
  it must not be authoritative for transactional operations.
- **Query every source live from the dashboard** — rejected because partial
  failures, rate limits, inconsistent time boundaries, and secret distribution
  would make every page load fragile and difficult to interpret.
- **Treat the newsletter provider as the reporting model** — rejected because
  definitions differ, replacement would break history, and provider APIs expose
  person-level data that dashboard and MCP must never receive.
- **Add a third-party analytics product** — rejected because it would require a
  separate account and integration, weaken client-owned simplicity, and often
  introduce cookies or visitor identifiers to solve needs covered by the chosen
  Cloudflare sources.
- **Measure sessions or unique people** — rejected because doing so reliably
  requires client state, fingerprinting, or another persistent identifier.
- **Hide unreliable opens entirely** — rejected because clients reasonably
  expect the provider-reported signal. It is retained with an explicit warning,
  collapsed by default, and excluded from automated recommendations.

## Sources

Cloudflare:

- [Cloudflare Web Analytics overview](https://developers.cloudflare.com/web-analytics/about/)
- [Web Analytics high-level metric definitions](https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/)
- [Web Analytics dimensions](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/)
- [Web Analytics FAQ: sampling, retention, query strings, and custom events](https://developers.cloudflare.com/web-analytics/faq/)
- [Web Analytics limits](https://developers.cloudflare.com/web-analytics/limits/)
- [Web Analytics privacy statement](https://www.cloudflare.com/web-analytics/)
- [Workers Analytics Engine overview](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
- [Analytics Engine limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Analytics Engine pricing and free allowances](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Analytics Engine SQL API and `_sample_interval`](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [GraphQL Analytics API authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/)
- [Configure an Analytics API token](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)
- [GraphQL Analytics API limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)
- [D1 pricing and free allowances](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/)

Email measurement:

- [Apple Mail privacy settings and background remote-content loading](https://support.apple.com/guide/mail/change-privacy-settings-mlhlae4a4fe6/mac)
- [Gmail click-time link protection](https://support.google.com/mail/answer/10173182)
- [Brevo campaign report API](https://developers.brevo.com/reference/get-email-campaign)
- [Brevo marketing webhook events](https://developers.brevo.com/docs/marketing-webhooks)
- [Brevo guidance on Apple Mail Privacy Protection and bot activity](https://help.brevo.com/hc/en-us/articles/4406537065618-About-Apple-Mail-Privacy-Protection-MPP-and-bot-activity-in-Brevo)

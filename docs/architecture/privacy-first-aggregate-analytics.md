# Privacy-first aggregate analytics

How the analytics read model works, and which of its rules the database
enforces rather than leaving to review. The decision behind it is
[ADR-0003](../decisions/ADR-0003-unified-privacy-first-analytics.md).

## How the parts fit together

Four sources report separately. No rendered page queries any of them:

```text
Cloudflare Web Analytics ─┐
Workers Analytics Engine ─┼─▶ normalizer ─▶ analytics projection ─▶ D1
D1 operational tables    ─┤                   (the only writer)     │
Newsletter provider      ─┘                                         ▼
                                            analytics query service
                                                       │
                                                     /dash
```

`packages/application/src/analytics-model.ts` holds the metric registry and the
guards. `analytics-projection.ts` is the only code that writes a fact.
`analytics-queries.ts` is the only code that reads one. The adapters in
`apps/reference-site/src/` each translate one source and know nothing about the
dashboard.

## What each source may report

| Source | `source` | Reports | Quality |
|---|---|---|---|
| Cloudflare Web Analytics | `cloudflare_web` | Page views, referral-based visits, normalized referrer | `estimated` |
| Workers Analytics Engine | `analytics_engine` | Form impressions, CTA activations | `best_effort` |
| D1 operational tables | `d1` | Accepted and blocked submissions, notification outcomes, consent and suppression changes, active subscribers | `exact`, `derived_exact` |
| Newsletter provider | `provider` | Sent, delivered, bounces, complaints, unsubscribes, reported clicks and opens | `provider_reported`, `directional`, `unreliable` |

A projector may only write metrics the registry assigns to its own source. The
`analytics_metric_definitions` table is seeded from that same registry, and
`d1-analytics-store.test.ts` fails if the two drift apart.

The three Web Vitals metrics are registered but no source collects them yet.
See "What this does not do" below.

## Rules the database enforces

Migration `0025_analytics_projection.sql` makes these impossible to break, so a
future projector cannot widen the model without changing the schema:

- **A fact must name a declared metric, from that metric's declared source, in
  that metric's declared unit.** Enforced by a foreign key and a trigger.
- **A dimension must be on the allowlist.** Version 1 allows `referrer_host`
  and `referrer_channel`, and nothing else. No geography, device, browser or
  campaign-tag breakdown can be stored.
- **A missing measurement is `unavailable` with a reason, never a zero.** A
  `CHECK` constraint rejects a row that is unavailable but holds a value, or
  available but holds none.
- **Only a metric whose declared value domain is `signed` may be negative.**
  `subscriber.net_growth` is the only one. A shrinking subscriber list reports
  a real negative number, and a negative count is rejected as the projector bug
  it would be.
- **A revision only moves forward.** A replayed or late source run cannot put
  an older value back over a newer one.
- **A fact's identity cannot be changed**, and **source completeness cannot go
  backwards**.
- **A subject identifier cannot look like an address**, and a dimension value
  cannot contain `@` or a query string.

## Rules the application layer enforces

- `assertAggregateAnalyticsPayload` checks every payload before it is written.
  It rejects any field naming a visitor, session, request, subscriber, contact,
  recipient, respondent or provider message; any email, IP address, user agent,
  coordinate, referrer path, query string or free-form property bag; and any
  *value* shaped like an email address, an IP address or a URL, whatever the
  field is called. Provider adapters run the same check on the snapshot they
  return, so a leak fails at the boundary instead of being filtered later.
- **Unlike measurements are never added together.** `comparabilitySignature`
  combines metric, source, source name, provider metric name and definition
  version. `summableSeries` rejects a series that spans more than one. Two
  providers' "delivered" counts appear as two labelled series, and so do two
  web sources reporting one referrer.
- **An empty selection returns `null`, not `0`**, so the caller has to decide
  how to report the absence.
- **One granularity per interval.** A whole-day range reads daily facts. A
  request that asks for `granularity: "hour"` reads hourly facts, and is
  refused once those have been compacted. Compaction and reads therefore
  cannot double-count. `/dash` does not yet offer a control for the hourly
  range; the query API accepts it, and the MCP tools in
  [issue #57](https://github.com/Humber-Foundry/foundry-cms/issues/57) are its
  first caller.
- **Point-in-time metrics are not summed.** `subscriber.active` and the Web
  Vitals percentiles are marked `aggregation: "latest"`.
- **Breakdown rows below five are suppressed** and reported as "fewer than 5".
  A business object's own total is still reported exactly, because that total
  is not what could identify anyone.
- **Local days are real days.** Range resolution finds the UTC instant of local
  midnight by fixed-point solve, so a daylight-saving day is a genuine 23- or
  25-hour day rather than a shifted 24.

## Caching

Query answers are held in memory per site: five minutes for a range that is
still filling, one hour for a range that has closed. The cache key is the site,
the `analytics.read` capability, a digest of the metric registry's definition
versions, the query name, the reporting time zone, the resolved range, the
granularity and the query's own options.

The cache belongs to the Worker isolate, not to the query application.
`/dash` is dynamic and builds a fresh application on every request, so a cache
owned by the application would be discarded before it was ever read.
`analytics-dashboard-runtime.ts` holds one cache per site and passes it in.

The capability is checked on every call, before the cache is read, so a caller
without `analytics.read` is refused and never served a stored answer. Every
reader holding that capability sees the same rows — the queries do no per-actor
filtering — so the capability name is the whole authorization scope the key
needs. The cache holds at most 200 entries and evicts the oldest first.

## Deviation from ADR-0003

**The uniqueness key adds `source_name`, which the ADR's stated key omits.**

The ADR also requires that changing provider must not rewrite history, and that
incompatible series be shown separately with a provider-change marker. Both
cannot hold under a key that treats `brevo` and a replacement provider as one
slot. Within a single source name, a definition change still replaces the row
and appends to `analytics_fact_revisions`, exactly as the ADR describes.

## Late data, degradation and completeness

- The scheduled projector runs from `custom-worker.ts`. D1 is re-projected
  every five minutes, the Cloudflare sources every six hours, the provider
  hourly. A source that asked for a retry time is left alone until it arrives.
- **D1 reports through the current instant**, not through the last closed day,
  because it is exact and local. Today's counts appear within minutes, and
  today's bucket is marked in progress because it ends after the completeness
  instant.
- **External sources report through the last closed UTC day**, because the
  platforms keep revising a day until it closes. Each run re-reads the previous
  seven days, since sampling and late aggregation revise recent buckets.
- **The provider is polled in three bands**, matching the ADR: campaigns sent
  within 72 hours on every run, within 30 days once a day, within 97 days once
  a week. The band is chosen from the last successful run, so the projector
  needs no extra state to keep its place. The widest band is 97 days rather
  than 90 because a weekly sweep bounded at exactly 90 would last see a
  campaign at about day 83 and never at 90; the extra week guarantees the
  day-90 reconciliation the ADR asks for. Each band pages through the
  provider's changed-campaign cursor, fifty campaigns a request, rather than
  asking once per campaign. A run that hits the page cap says so in the log.
- A degraded run records the outage and leaves the projected facts and
  completeness untouched. A source outage therefore reads as "source
  unavailable", never as a drop to zero.
- An unconfigured source records `source_not_configured` rather than reporting
  no traffic.
- A source is marked `partial` when it failed to give back something it was
  asked for. A measurement that is legitimately absent — a browser that reports
  no Web Vitals, a capability the provider never claimed — leaves the source
  healthy.
- A material change to an already-published value appends to
  `analytics_fact_revisions`, so a revision after someone read a report can be
  audited.
- **Analytics Engine reports hours as well as days.** It is the only source
  with per-event timestamps, and Cloudflare keeps its points for three months.
  The hourly facts serve an intraday range for 90 days and then compact away;
  the daily facts carry the history past Analytics Engine's own retention.
- Compaction rolls closed hourly facts into daily facts after 90 days. Where
  the source already wrote that day's fact — which Analytics Engine does on
  every run — compaction removes the hours and leaves the source's own total
  alone, because recomputing the day from sampled hours could disagree with
  it. A day whose hours span a definition change, or that mixes measured and
  unavailable hours, is **not** merged. Its hourly facts stay and the skip is
  logged, because either merge would invent a number.

## Retention

| Data | Kept for |
|---|---|
| Aggregate facts | 25 months |
| Hourly facts | 90 days, then compacted to daily |
| Cloudflare Web Analytics (at source) | 6 months |
| Analytics Engine (at source) | 3 months |

Every scheduled run deletes facts whose bucket **starts** before the 25-month
floor, along with their revision audit rows. Both use the same test on the same
column, so a fact and its audit history always go together. The read side
clamps its own start to the same floor, so a deleted fact is one no query could
have returned. The dashboard states these windows beside the numbers, and a
range reaching past them is marked as clamped with its readings
`outside_retention`.

## Collection

`/api/analytics/interactions` accepts one enumerated event kind and one public
CMS object ID, and discards everything else about the request — headers, query
string, and the rest of the body. It always answers `204`, because a dropped
interaction costs an estimate and must never change the outcome of a form,
publish, consent or send operation.

## What this does not do

- **Web Vitals collection.** The three `web.vitals.*_p75` metrics are in the
  registry and seeded in the migration, and
  `normalizeCloudflareWebAnalytics` already translates them. Nothing queries
  them yet: the Cloudflare GraphQL dataset is
  `rumWebVitalsEventsAdaptiveGroups`, but its exact quantile and dimension
  field names were not confirmed against the live schema, and a guessed query
  would fail in production while looking correct in review. Until the query is
  confirmed, the metrics read as unavailable and no number is invented.
- **MCP access.** The read-only analytics tools are
  [issue #57](https://github.com/Humber-Foundry/foundry-cms/issues/57). The
  query service they will use is the one `/dash` already reads.
- **Installation capacity and quota diagnostics** are
  [issue #61](https://github.com/Humber-Foundry/foundry-cms/issues/61).
- **A recorded route history.** Content attribution maps a published path to
  the content item that owned it in each bucket, but the site does not yet
  store route changes. `currentRouteHistory()` therefore treats the current
  published paths as having always belonged to their current content. A future
  route change needs a stored history before its traffic can be split
  correctly.
- **Excluding synthetic submissions.** ADR-0003 expects health-check
  submissions to be tagged and excluded. The form schema has no such tag yet,
  so nothing is excluded and nothing pretends to be.

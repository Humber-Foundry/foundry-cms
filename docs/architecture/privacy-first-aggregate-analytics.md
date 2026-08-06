# Privacy-first aggregate analytics

How the shipped analytics read model works, and which of its rules are
structural rather than conventional. The decision behind it is
[ADR-0003](../decisions/ADR-0003-unified-privacy-first-analytics.md).

## The shape of it

Four source families report separately, and none of them is queried by a
rendered page:

```text
Cloudflare Web Analytics ─┐
Workers Analytics Engine ─┼─▶ normalizer ─▶ analytics projection ─▶ D1
D1 operational tables    ─┤                       (one seam)        │
Newsletter provider      ─┘                                         ▼
                                            analytics query service
                                                       │
                                                     /dash
```

`packages/application/src/analytics-model.ts` holds the canonical vocabulary.
`analytics-projection.ts` is the only write path into the read model, and
`analytics-queries.ts` is the only read path out of it. The projectors and
adapters in `apps/reference-site/src/` translate one source each and know
nothing about the dashboard.

## What each source is allowed to say

| Source | `source` | Owns | Quality |
|---|---|---|---|
| Cloudflare Web Analytics | `cloudflare_web` | Page views, referral-based visits, Web Vitals, normalized referrer | `estimated`, `partial_population` |
| Workers Analytics Engine | `analytics_engine` | Form impressions, CTA activations | `best_effort` |
| D1 operational tables | `d1` | Accepted and blocked submissions, notification outcomes, consent and suppression transitions, active subscribers | `exact`, `derived_exact` |
| Newsletter provider | `provider` | Sent, delivered, bounces, complaints, unsubscribes, reported clicks and opens | `provider_reported`, `directional`, `unreliable` |

A projector may only write metrics the registry assigns to its own source.
`analytics_metric_definitions` is seeded from that same registry, and
`d1-analytics-store.test.ts` fails if the two drift apart.

## The rules the schema enforces on its own

These are not review conventions. Migration `0025_analytics_projection.sql`
makes them impossible to break, so a future projector cannot quietly widen the
model:

- **A fact must name a declared metric, from that metric's declared source, in
  that metric's declared unit.** Enforced by foreign key plus trigger.
- **A dimension must be on the allowlist.** V1 allows only `referrer_host` and
  `referrer_channel` beyond the empty sentinel. No geography, device, browser
  or campaign-tag breakdown can be stored.
- **An absent measurement is `unavailable` with a reason, never a zero.** A
  `CHECK` constraint refuses a row that claims to be unavailable while holding
  a value, or available while holding none.
- **Only a metric whose declared value domain is `signed` may be negative.**
  `subscriber.net_growth` is the only one, so a shrinking list reports a real
  negative instead of a floored zero, and a negative count is refused as the
  projector bug it would be.
- **A revision only moves forward.** A replayed or late source run cannot
  resurrect an older value over a newer one.
- **A fact's identity is immutable**, and **source completeness never moves
  backwards**.
- **A subject identifier cannot look like an address**, and a dimension value
  cannot contain `@` or a query string.

## The rules the application layer enforces

- `assertAggregateAnalyticsPayload` walks every payload before it is written
  and refuses any field naming a visitor, session, request, subscriber,
  contact, recipient, respondent or provider message, any email, IP, user
  agent, coordinate, referrer path, query string or free-form property bag —
  and refuses any *value* shaped like an address, an IP or a URL, whatever the
  field is called. Provider adapters call the same guard on the snapshot they
  return, so leakage fails at the boundary rather than being filtered later.
- **Unlike measurements are never added.** `comparabilitySignature` combines
  metric, source, source name, provider metric name and definition version;
  `summableSeries` refuses a series that spans more than one. Two providers'
  "delivered" counts appear as two marked series.
- **An empty selection returns `null`, not `0`**, so the caller has to decide
  how to report absence.
- **One granularity per interval.** A whole-day range reads daily facts; an
  explicit intraday request reads hourly facts and is refused once those have
  compacted. Compaction and reads therefore cannot double-count.
- **Point-in-time metrics are not summed.** `subscriber.active` and the Web
  Vitals percentiles declare `aggregation: "latest"`.
- **Small secondary rows are suppressed** below five and reported as
  "fewer than 5". A business object's own total is still reported exactly,
  because that total is not what could re-identify anyone.
- **Local days are real days.** Range resolution solves for the UTC instant of
  local midnight by fixed point, so a daylight-saving day is a genuine 23- or
  25-hour day rather than a shifted 24.

## Deviation from ADR-0003 worth knowing

The ADR's uniqueness key omits `source_name`. It also requires that changing
provider must not rewrite history and that incompatible series be shown
separately with a provider-change marker. Those cannot both hold under a key
that treats `brevo` and a replacement provider as the same slot, so the shipped
key adds `source_name`. Within one source name, a definition change still
replaces the row and appends to `analytics_fact_revisions`, exactly as the ADR
describes.

## Late data, degradation and completeness

- The scheduled projector runs from `custom-worker.ts`. D1 is re-projected
  every five minutes; Cloudflare sources every six hours; the provider hourly.
  A source that asked for a retry time is left alone until it arrives.
- External sources re-read the previous seven UTC days each run, because
  sampling and late platform aggregation revise recent buckets.
- A degraded run records the outage and leaves the previously projected facts
  and completeness untouched. A source outage therefore reads as
  "source unavailable", never as a drop to zero.
- An unconfigured source records `source_not_configured` rather than reporting
  no traffic.
- A material change to an already-published value appends to
  `analytics_fact_revisions`, so a revision after someone read a report is
  auditable.
- Compaction rolls closed hourly facts into daily facts after 90 days. A day
  whose hours span a definition change, or that mixes measured and unavailable
  hours, is **not** merged; its hourly facts stay and the skip is logged, since
  either merge would invent a number.

## Retention

| Data | Retained |
|---|---|
| Aggregate facts | 25 months |
| Hourly facts | 90 days, then compacted to daily |
| Cloudflare Web Analytics (at source) | 6 months |
| Analytics Engine (at source) | 3 months |

The dashboard states these windows beside the numbers, and a range reaching
past them is marked as clamped with its readings `outside_retention`.

## Collection

`/api/analytics/interactions` accepts one enumerated event kind and one public
CMS object ID, and discards everything else about the request — headers, query
string, body remainder. It always answers `204`, because a dropped interaction
costs an estimate and must never change the outcome of a form, publish,
consent or send operation.

## What is deliberately not here

- **MCP access.** The read-only analytics tools are
  [issue #57](https://github.com/Humber-Foundry/foundry-cms/issues/57); the
  query service they will use is already the one `/dash` reads.
- **Installation capacity and quota diagnostics** are
  [issue #61](https://github.com/Humber-Foundry/foundry-cms/issues/61).
- **A recorded route history.** Content attribution maps a published path to
  the content item that owned it in each bucket, but the site does not yet
  persist route changes, so `currentRouteHistory()` treats the current
  published paths as always having been owned by their current content. A
  future route change needs a recorded history before its traffic can be split
  correctly.
- **Synthetic submission exclusion.** ADR-0003 expects health-check
  submissions to be tagged operationally and excluded; the form schema has no
  such tag yet, so nothing is excluded and nothing pretends to be.

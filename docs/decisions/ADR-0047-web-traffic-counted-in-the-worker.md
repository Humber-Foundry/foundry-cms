# ADR-0047: Web traffic is counted in the Worker request path

- Status: Accepted
- Date: 2026-09-21
- Supersedes in part: [ADR-0003](ADR-0003-unified-privacy-first-analytics.md)
- Issue: [#239](https://github.com/Humber-Foundry/foundry-cms/issues/239)

## Context

ADR-0003 named Cloudflare Web Analytics as the source of page views, visits
and referrers, and Workers Analytics Engine as the source of a small set of
anonymous interaction counts.

Neither produced anything. The Cloudflare Web Analytics source needs a site
tag that is empty in `wrangler.jsonc`, and no beacon was ever added to the
public site, so there was nothing for it to read even with a tag. The Visitors
screen therefore showed one sentence and no numbers.

A beacon would also be the wrong answer here. It needs a script in every page,
it is blocked by many browsers and extensions, and it makes the count depend on
what runs in the reader's browser.

## Decision

The site counts its own traffic. Every public HTML page the Worker serves is
counted in the request path, after the page is made, as one anonymous point in
the Workers Analytics Engine dataset the site already has.

One point holds four labels and two numbers:

- the event kind, `page_view`;
- the published page or post id, or an empty label for an address the site
  does not own;
- the referrer, reduced to a bare host or to a channel word the read model
  allows, such as `direct` or `search`;
- an arrival marker, which is 1 when the reader came from somewhere other than
  this site.

Nothing else about the request is read. The address, its query string, the
reader's network address, the browser name and every other header are dropped
in `web-traffic-collector.ts` and never reach any store. No cookie is set, no
identifier is created, and nothing is written to the browser.

A "visit" stays what ADR-0003 called it: an arrival from somewhere else. It is
never presented as a count of people or of sessions, because without a cookie
or an identifier the site cannot know how many different people these are. The
Visitors screen says so beside the number.

### One metric, more than one source

Migration 0025 let a metric have exactly one source, because one producer was
planned. Migration 0038 adds `analytics_metric_sources`, so `web.page_views`,
`web.visits` and `content.page_views` may be measured by Cloudflare Web
Analytics or by Workers Analytics Engine. The metric registry carries the same
pair through `additionalSources`.

Two sources measuring one metric are still never added together. Each fact
keeps its own source, source name, source metric and definition version, and
the comparability rule keeps the two series apart in every reading.

### The Cloudflare Web Analytics source

It stays in place and stays unconfigured. It is not removed, so an
installation that wants the platform's own bot filtering can still turn it on,
and the two series would then be shown apart rather than mixed.

## Consequences

- Counting is exact for requests the Worker serves. It misses a page served
  from a cache in front of the Worker and a page the browser re-opened from
  its own cache, and it counts a machine that reads pages as well as a person.
  The readings are therefore labelled as an estimate, not as an exact count.
- An arrival is decided from the referring host and from the browser's
  `Sec-Fetch-Site` header. Neither names a person. A browser that sends
  neither is treated as an arrival, so arrivals can read high on a site with
  many such readers.
- Analytics Engine allows 100,000 data points a day on the free plan. One point
  per page view puts a site of a few thousand page views a day well inside
  that. A far busier site would need the paid plan, which ADR-0003 already
  anticipates.
- The projector now reads two rollups from the one dataset in one run, and both
  report under one source state, because one platform serves both.
- The Visitors screen shows visits, page views, a page view chart, the most
  read pages and where visits came from, for the last 7 or the last 30 days.
- `next dev` has no D1 binding, so the screen there shows a clearly labelled
  sample data set. It is built only when `NODE_ENV` is `development`, and a
  deployed site never shows it.

## Alternatives considered

- **A browser beacon.** Rejected: it is blocked often, it puts a script in
  every page, and it needs a consent question a server-side count does not.
- **A cookie or a hashed visitor identifier.** Rejected: it would make the
  facts describe a person, which ADR-0003 forbids.
- **New metric keys for Worker-counted traffic.** Rejected: it would leave two
  page view metrics in the vocabulary, one of them always unavailable, and
  every later screen would have to choose between them.

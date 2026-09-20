# ADR-0026: A view and a media occurrence belong to the page that has them

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

ADR-0016 gave a site a `pages` collection. ADR-0018 gave every page below the
home page its own route. Two things still assumed a site had only the home
page:

- The analytics route history
  (`apps/reference-site/src/analytics-projection-runtime.ts`) attributed
  every published path to `homePage(installedSiteDefinition).id`. A second
  page's traffic had no route history entry, so it could never be attributed
  to that page.
- The anonymous interactions endpoint
  (`apps/reference-site/app/api/analytics/interactions/route.ts`) accepted a
  reported subject id only when it was the home page's own id, one of the
  home page's section ids, or a blog post id. A form or call-to-action on any
  other page could never be counted, because its id was never in the
  allow-list.
- A media occurrence id (`packages/site-definition/src/index.ts`,
  `packages/application/src/media-assets.ts`) was one of exactly two literal
  strings, `occurrence_home_hero` and `occurrence_home_detail`. No other page
  could hold a hero or detail photo of its own.

The Visitors report (`/dash/analytics`, `components/analytics-dashboard.tsx`)
also showed a content measurement's raw internal id,
`<h4>{item.subjectId}</h4>`, because until a site had more than one page, an
id and a title carried the same information for a reader who never saw the
id spelled out as anything but "the page."

This ticket resolves #162, blocked by #154 (ADR-0018).

## Decision

### 1. A view is recorded against the page that was served

`currentRouteHistory()` now builds one route history entry per page in
`installedSiteDefinition.pages`, using `pagePath(page)` and `page.id`, in
place of the one entry it built for `homePage(installedSiteDefinition)`.
Cloudflare Web Analytics traffic for `/about` is now attributed to the
`about` page's own id; before this ticket it produced no attribution at all,
because no route history entry named that path.

The home page's own entry is unchanged: `pagePath` already returns `/` for
the home page and its id has not moved, so **every fact already stored
against the home page's id stays valid, with no migration of old rows.** No
D1 table changes shape — `analytics_facts` already stores `subject_id` as an
unconstrained column, keyed by whatever content id the projector reports.

### 2. The interactions endpoint accepts any page's own ids

`publicSubjectIds()` (moved to its own module,
`apps/reference-site/src/analytics-public-subjects.ts`, so it has a direct
unit test — a route file may not export an arbitrary extra name) now walks
every page in `installedSiteDefinition.pages` and its sections, instead of
reading only the home page. `collectInteraction` (unchanged) still refuses a
reported subject id that is not in this set, so **a caller cannot invent a
fact for a page, section or post id the site never published** — the set is
still built from the current published definition, and still only from
public, stable CMS ids: no visitor, session or request identifier is added
to it or read from the request.

### 3. A media occurrence id is built from its own page's id

`pageMediaOccurrenceId(page, slot)` (`packages/site-definition/src/pages.ts`)
replaces the two hard-coded literal strings:

- The home page keeps its own two ids, `occurrence_home_hero` and
  `occurrence_home_detail`, unchanged. They were published and stored before
  a site could have more than one page, so they carry no page id — the same
  exception ADR-0017 makes for the home page's field paths, and for the same
  reason: renaming them would strand every already-placed occurrence.
- Any other page's id is `occurrence_<pageId>_hero` or
  `occurrence_<pageId>_detail`, built from its own stable page id. A slug
  rename moves nothing this id names.

`SiteMediaOccurrence.occurrenceId` widens from the closed union of two
literals to the template type `` `occurrence_${string}_${"hero" | "detail"}` ``.
`packages/application/src/media-assets.ts` gains
`requirePageMediaOccurrenceId`, which accepts this general shape at the
write path (`replaceOccurrence`, `cropOccurrence`, and the receipt query);
`requireRenderedMediaOccurrenceId` and `renderedMediaOccurrenceIds` are kept
exactly as they were, because they name what the one media-editing screen
today (`components/media-manager.tsx`) actually offers — the home page's two
slots — and that screen is not this ticket's job to change. #158 (the visual
editor on the selected page) is the ticket that gives another page's owner a
screen to place its own hero and detail photo; this ticket only opens the
type and the write path for it to build on.

#### Is this a schema version step?

Applying the same test ADR-0022 used for `SiteHref`: does a definition
stored before this ticket still validate, byte for byte, against the widened
schema? Yes. The two literal occurrence ids a stored definition could ever
have held, `occurrence_home_hero` and `occurrence_home_detail`, both end in
`_hero` or `_detail` and both start with `occurrence_`, so they match the
widened pattern unchanged. **This is a compatible widening: no
`schemaVersion` step, no projection step.** `npm run generate:site-validator`
still regenerates the validator, because the JSON Schema text changed, and
the MCP tool-schema snapshot
(`apps/reference-site/src/__snapshots__/mcp-tool-registry.test.ts.snap`) is
regenerated too, because several tools' output schemas embed a page's
`media` array and therefore hash differently, even though no tool's field
list changed.

JSON Schema cannot compare an occurrence id in a page's `media` array to
that page's own `id` — the same limit ADR-0016 and ADR-0022 already work
around. The schema is loosened only to "at most one occurrence ending in
`_hero`, at most one ending in `_detail`" (`sitePage.media`'s `contains`
blocks) and "the id has the general shape" (`mediaOccurrence.occurrenceId`'s
pattern). `isBaseSiteDefinition` gains the one check JSON Schema cannot
express: every occurrence in a page's `media` matches
`pageMediaOccurrenceId(page, "hero")` or `pageMediaOccurrenceId(page,
"detail")` for that same page, so an occurrence built for one page can never
be stored on another.

### 4. The reference-protected scan and the used-photos scan see every page

`siteDefinitionMediaAssetIds` (`packages/site-definition/src/
media-references.ts`) collected occurrence assets and image-field assets
from `homePage(definition)` only. It now walks every page in
`definition.pages`. This function is the allow-list the public media route
(`app/api/media/[assetId]/route.ts`) checks before it serves an asset, and
the scope a draft's authenticated media access token is widened to
(`app/api/foundry-cms/media/route.ts`), so a photo placed on any page is now
both servable and included in what a draft may fetch at full resolution —
before this ticket, a photo referenced only from a second page's section
would have been refused by the public route and left out of the access
grant, even though it was displayed.

`site-used-photos.ts`'s `imageAddressesOf` (the built-in and external photo
list the gallery shows as "on the page," separate from a gallery asset
reference) is changed the same way, in the smallest diff that does it: the
one loop body is now run once per page instead of once for the home page.
#158 also touches this file, to make the gallery reflect the page the owner
has selected; this ticket's change is one small, separated loop change so
that later diff stays easy to read against this one.

The D1 and in-memory deletion-reference guards
(`d1-media-asset-store.ts`, `in-memory-media-assets.ts`) needed no change:
they already count rows in the occurrence-revision store by `asset_id`
alone, with no filter on which occurrence id or page holds them, so a
page-scoped occurrence id was already counted correctly.

### 5. The Visitors report shows a page's title, not its id

`loadAnalyticsDashboard` (`apps/reference-site/src/
analytics-dashboard-runtime.ts`) now also returns `contentTitles`, a map from
every page and blog post id to `pageDisplayTitle(page)` or the post's title.
`pageDisplayTitle` (`packages/site-definition/src/seo.ts`) is a small shared
helper — a page's own title, or its path when the title is left blank — that
`packages/application/src/content-change-summary.ts`'s review summary
(ADR-0023) already needed and had written locally as `pageTitle`; this
ticket moves it to the one shared place both callers now use.

The Content section of `components/analytics-dashboard.tsx` reads
`contentTitles[item.subjectId]`, falling back to the id only when a subject
has no known title — a removed page or a tombstoned post, still visible
because its historical facts are retained (ADR-0003). No layout changed: the
section was already a list of cards, one per content item, so a single page
today still reads as one card, not a ragged grid row.

## Test fixture

`apps/reference-site/src/test-support/two-page-site-definition.ts` did not
exist on `main` when this ticket started (PR #188, which was expected to add
it, had not merged). This ticket adds its own small fixture — the reference
definition's home page plus one more page, with its own section and its own
detail media occurrence — built the same way `public-page.test.ts` already
built one for ADR-0018. If PR #188 lands a shared fixture later with a
different shape, the two can be reconciled in whichever ticket notices the
duplication; this one does not depend on that having happened.

## Consequences

- A page below the home page now accumulates its own view count and its own
  interaction counts, visible in Visitors by its own title.
- A page below the home page can, at the schema and write-path level, hold
  its own hero and detail photo. No screen offers that yet; #158 is the
  ticket that adds one.
- A photo placed on any page is protected from deletion and correctly served,
  matching what the page actually displays.
- The stored fact shape gained no field: `AnalyticsFact.subjectId` was always
  a public content id, and still is. No visitor, session, request, or other
  identifying field was added anywhere this ticket touches.
- No stored Site Definition, D1 analytics fact, or media occurrence needs
  rewriting to stay valid after this upgrade.

## Alternatives considered

**Add a schema version step for the media occurrence change.** Rejected for
the same reason ADR-0022 rejected one for `SiteHref`: nothing stored needs to
change to stay valid, so a version step would invalidate every open approval
(ADR-0004) for no correctness reason.

**Let `requireRenderedMediaOccurrenceId` accept any page's occurrence id,
instead of adding `requirePageMediaOccurrenceId`.** Rejected because
`renderedMediaOccurrenceIds` is read by `components/media-manager.tsx` to
decide which two slots to show; widening its meaning to "everything the
write path accepts" would have made that list describe the write path
instead of the one screen it actually drives, the first time the two
diverged.

**Keep the reference-protected and used-photos scans home-only until #158
lands.** Rejected: a page-component image field on a second page can already
reference a gallery photo today, independently of the occurrence id change,
because an image field stores a plain asset path and was never
occurrence-scoped. Leaving the scans home-only would keep that photo
silently un-servable by the public route and unprotected from deletion, on
any page but home, which is the exact failure the acceptance criteria name.

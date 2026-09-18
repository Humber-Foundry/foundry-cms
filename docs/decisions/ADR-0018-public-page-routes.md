# ADR-0018: One route serves every page below the home page

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

ADR-0016 gave a site a `pages` collection instead of one `home` object. Only
`/` rendered a page before this ticket. A site with a second page had no route
that served it.

`SiteRenderer` read `homePage(definition)` itself. It could only ever render
the home page, on every route that used it: the public home route, the
preview route, and the two editor surfaces that show a live picture of the
site (`content-editor.tsx`, `design-destination.tsx`).

## Decision

**A dynamic route, `app/[slug]/page.tsx`, serves every page below the home
page. `SiteRenderer` takes the page to render as a prop, and reads no page
from the definition itself.**

### 1. The route

`app/[slug]/page.tsx` follows the same shape as `app/blog/[slug]/page.tsx`:
one loader reads the slug, finds the page, and calls `notFound()` when there
is none; `generateMetadata` and the page component both call it.

The loader, `findPublicPage` in `src/public-page.ts`, refuses two kinds of
slug before it searches the page collection: the home page's own slug (the
empty string, served at `/` through its own route) and every reserved slug
(`__foundry`, `api`, `blog`, `dash`, `newsletter`). The schema already stops a
page from taking a reserved slug, and Next.js always serves a fixed route
ahead of a dynamic one at the same level, so this refusal is a second guard,
not the only one. `src/public-page.test.ts` proves it against every reserved
slug.

### 2. `SiteRenderer` takes a page

`SiteRenderer` no longer calls `homePage(definition)`. It takes `page` as a
required prop. Every caller — the public home route, the new page route, the
preview route, and the two editor surfaces — passes the page it means to
show. The four existing callers all pass `homePage(definition)` today, so
their output is unchanged; the new route is the first caller that can pass a
different page.

### 3. The "Latest posts" list stays home-page furniture

`SiteRenderer` rendered a "Latest posts" list under the sections of whichever
page it drew, because until this ticket it only ever drew the home page. That
list is written to look like part of the home page, not part of every page.
This ticket keeps it there: `SiteRenderer` now shows the list only when the
page it is given is the home page.

This is not called out in #146, #154, or an earlier ADR. It follows from the
one criterion the ticket does state — the home page's output is unchanged —
because leaving the list unconditional would have started repeating it under
every page's sections instead, which is a visible change no ticket asked for.

### 4. No sitemap or other metadata route exists yet

The ticket's acceptance criteria ask that "the sitemap and any metadata
routes list every page." No `sitemap.ts`, `robots.ts`, or other Next.js
metadata route exists anywhere in this repository today; only `page.tsx`
routes emit `generateMetadata`. Each page route now emits its own metadata
through `resolvePageSeo`, so every page's own `<title>`, description, and
Open Graph tags are already correct. There is no separate sitemap file to
update. If one is added later, it must enumerate `definition.pages`.

### 5. No sync-manifest change is needed

`apps/reference-site/scripts/foundation-release-lib.mjs` classifies every
path under `app/` as framework source automatically (`isTemplatePath`). A new
route file under `app/` needs no entry added anywhere; the release
preparation and installation sync already pick it up. `packages/operator/src/
foundation-sync.test.ts` keeps this classifier in lockstep with the sync
tool, so a future change to what counts as framework source is caught there,
not by hand-editing a list.

## Consequences

A site with more than one page is reachable. The reference installation still
ships one page; this ticket adds no second page to it, only a fixture for the
new tests.

Tickets #156 (preview per page) and #162 (analytics and media per page)
build on this: #156 reuses `SiteRenderer`'s page prop for a page-scoped
preview route, and #162 records analytics against the page a visitor viewed
instead of always the home page.

## Alternatives considered

**Give `SiteRenderer` a default page of `homePage(definition)`.** This would
have let existing call sites omit the prop. It was rejected because the
ticket asks `SiteRenderer` to stop reading `definition.home` itself; a
default reintroduces that read under another name, and every call site needs
to state which page it means to show regardless, once more than one page
exists.

**Keep the "Latest posts" list on every page.** Rejected because it changes
what a second page renders compared to today's single-page sites, with no
criterion asking for it, and because a repeated list looks like a mistake
rather than a feature to an owner who adds a second page.

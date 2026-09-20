# ADR-0029: The revision preview gets one route per page, and the preview's own page-href builder keeps a link inside it

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

[Issue #156](https://github.com/Humber-Foundry/foundry-cms/issues/156) asks
for the revision preview to show any page of a revision, not only the home
page, and for a link followed inside the preview to stay inside it. The
owner's words: "you can click on any of them and open up the page, or you can
navigate to it through like the preview." A person reviewing a draft must be
able to move between the pages of that exact revision without leaving the
preview.

ADR-0018 gave every page below the home page its own public route,
`/[slug]`, and gave `SiteRenderer` a `page` prop instead of reading the home
page itself. ADR-0022 gave every navigation item, hero button and
call-to-action button a `pageHref` builder seam: `resolveSiteHref` and
`SiteRenderer` already accept one, so a caller can send a `page:` link to an
address of its own choosing. Until this ticket, no caller used that seam for
anything but the production path — the revision preview passed none, so a
`page:` link inside it resolved to the live public path and left the
preview, dropping its capability and revision context. ADR-0022 named this
gap explicitly and left it for this ticket to close.

The revision preview is authenticated and scoped to one workspace and one
revision (ADR-0004, ADR-0005): a short-lived capability, bound to the
identity, workspace and revision, gates `loadRevisionPreview`. Adding a page
segment to the preview route must not widen what that capability can reach.

## Decision

**A new dynamic route, `app/__foundry/preview/[workspaceId]/[revision]/
[slug]/page.tsx`, serves any page of a revision below its home page, the same
way `app/[slug]/page.tsx` serves one on the public site. Every preview route
builds its links through one new function, `buildRevisionPreviewLinks` in
`revision-preview-page.ts`, and passes the result as `SiteRenderer`'s
`pageHref` (and `homeHref`, `blogHref`, `blogPostHref`).**

### 1. The route and its security boundary

`[slug]/page.tsx` calls the same `loadRevisionPreview` the home page and blog
post preview routes already call. That call is the one place the capability
is checked, and it is checked before any page is looked up: it verifies the
capability names this exact identity, workspace and revision, then returns
the one `SiteDefinition` that revision holds. Only then does the route call
`findPublicPage(revision.definition, slug)` — the same function
`app/[slug]/page.tsx` uses on the public site, unchanged.

This gives the page segment no new reach. A slug is only ever looked up
inside the one definition the capability was already checked against; there
is no code path where a slug can resolve against a different workspace's or
revision's pages, and an unknown slug — including one that is a real page in
a different workspace or revision — gets `findPublicPage`'s existing
`notFound()`, the preview's not-found state, never a fall-through to the
live site. `findPublicPage` already refuses the home page's own slug and
every reserved slug (`__foundry`, `api`, `blog`, `dash`, `newsletter`), so
this route can never shadow the blog post preview route or the home preview
route.

### 2. One place builds every preview link

Before this ticket, the home page preview route and the blog post preview
route each built their own `URLSearchParams` and their own home/blog/blog
post addresses inline, repeating the same four lines. `buildRevisionPreviewLinks`
is now the one function that does this: given the revision and the raw
search params, it returns `previewPath`, `homeHref`, `blogHref`,
`blogPostHref`, a `pageHref` builder, and the verified `accessToken`. All
three preview routes — home, blog post, and the new page route — call it, so
a link followed from any one of them carries the exact same capability,
bookmark, access token and MCP preview id the visitor already has.

`pageHref` builds `<previewPath>/<slug>?<the same query>` for a page other
than the home page. `SiteRenderer`'s existing `defaultPageHref` composition
already calls this builder for a `page:` link, and already skips it for the
home page in favour of `homeHref` — this ticket needed no change to that
composition, `SiteHeader`, or the page-component renderers; it only needed
something other than the production default (`pagePath`) to pass into the
seam ADR-0022 built. This is the one link-rewriting mechanism the preview
uses; no second one was added.

The home page preview address is unchanged, byte for byte:
`buildRevisionPreviewLinks`'s `homeHref` construction is the same four lines
the home route wrote inline before, just named and shared.
`revision-preview-page.test.ts` proves this so approvals, MCP
`preview.prepare` results (`humanReviewUrl`) and stored links that point at
today's home preview URL keep working unchanged.

### 3. A shared provenance panel

The home preview route and the blog post preview route each also repeated
their own "Exact saved preview" aside, including the MCP review block. That
panel is now `PreviewProvenance` in `components/preview-provenance.tsx`,
which all three routes render. A page preview and the home preview now show
the same provenance and the same MCP review summary when the revision came
from an agent draft; a reviewer sees the same information about the revision
no matter which of its pages they are looking at. This also means the blog
post preview now shows the MCP review block when one is present, which it
did not before — a byproduct of removing the duplication, not a change this
ticket's acceptance criteria asked for on its own.

### 4. Preview metadata

`[slug]/page.tsx`'s `generateMetadata` calls `pageRouteMetadata`, the same
function the public page route and the home preview route call, so a page
preview's `<title>`, description and Open Graph tags come from
`resolvePageSeo` exactly as the live page's would. Every preview route sets
`robots: { index: false, follow: false }` itself; this ticket changes
nothing about that.

## Consequences

- Every page of a revision has an exact preview URL bound to that revision:
  `/__foundry/preview/<workspaceId>/<revision>/<slug>`.
- A `page:` link followed inside any preview route — home, page, or (as a
  side effect of the shared link builder) blog post — now resolves to
  another page's preview address, not its live public path. Following it
  keeps the capability, bookmark, access token and MCP preview id.
- An anchor, the Blog target, a `mailto:` link, and a defensively-read
  unrecognized value are unaffected: `resolveSiteHref` never sends any of
  these through `pageHref`, so they carry no preview capability and none of
  them can leave a link inside the preview that reaches outside it.
- A crafted or unknown slug — including a real page's slug in a different
  workspace or revision — gets the preview's not-found state. It can never
  reach a different revision's content or the live site.
- `apps/reference-site/src/public-page.test.ts` and
  `apps/reference-site/src/revision-preview-page.test.ts` cover: a link to
  another page stays in the same revision's preview, an external link and a
  `mailto:` link are unchanged, and a slug naming a page from a different
  definition is never found.
- #157's "Back to the dashboard" link and #170's review screen can link
  straight to a page preview using the same `/__foundry/preview/<workspaceId>/
  <revision>/<slug>` shape this ADR fixes in place.

## Alternatives considered

**Give the preview route a query parameter, `?page=<slug>`, instead of a path
segment.** Rejected. The production site already serves a page at
`/<slug>`, a path segment; a query parameter would give the preview a
different addressing rule than the site it is previewing, for no reason
tied to the preview's own constraints, and it would not match the pattern
the existing blog post preview route (`/blog/<slug>`) already set.

**Look up the page by id instead of slug.** Rejected. A page's public
address is keyed by slug (ADR-0016's `pagePath`), and the production page
route (ADR-0018) already resolves `/[slug]`. Keying the preview route by slug
instead of id keeps the preview's addressing identical to the production
route it previews, and `findPublicPage` — the function that must stay the
single source of truth for "what page does this slug mean" — already takes
a slug.

**Duplicate the link- and provenance-building code a third time in the new
route, rather than extracting `buildRevisionPreviewLinks` and
`PreviewProvenance`.** Rejected. A third copy would have been the second
occasion this ticket touched preview link construction, and any future
change to the query string or the provenance panel would need three
edits instead of one. Extracting both now, while adding the third caller,
keeps the preview's addressing and its provenance panel each written once.

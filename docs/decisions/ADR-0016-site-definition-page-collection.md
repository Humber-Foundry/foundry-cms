# ADR-0016: A page collection replaces the single home page

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Site Definition 1.6.0 holds one `home` object. A site can have one page and no
more. An owner cannot list pages, open a second page, or link a menu item to
anything but an anchor on the one page.

The owner review of the acceptance installation asked for multi-page sites:
list all pages, open any page in the same editor, and create new pages.

Every stored definition must keep working. Installations pin a foundation
release and store whole definitions in their D1 revision rows and in
`foundry/published-site.json`. Both are read through
`projectSiteDefinitionSchema`, so an upgrade must need no manual step and must
not change what a site renders.

Around forty files read `definition.home`. Changing all of them in one ticket
would be one very large change with a high chance of error.

## Decision

**Site Definition moves to 1.7.0. `home` becomes `pages`, an array of pages.**

### 1. What a page holds

A page has `id`, `slug`, `title`, `seo`, optional `media`, and `sections`.

`id` is the stable identity. It never changes once the page exists. Links,
field paths and analytics facts point at the id, so renaming a slug breaks
nothing.

`slug` decides where the page is served: `/<slug>`. The home page has the root
slug, an empty string, so it is served at `/`. One rule covers every page
instead of one rule for the home page and another for the rest.

`title` is what the Pages list shows, and the SEO title fallback for a page
below the home page.

### 2. Slug rules

A slug is either the root slug or lowercase words joined by single hyphens, up
to 120 characters. It is the same rule a blog post slug already uses, with the
empty string added.

These slugs are refused: `__foundry`, `api`, `blog`, `dash`, `newsletter`. Each
one is the first path segment of a route the installation already serves, so a
page with that slug could never be reached.

The JSON Schema enforces the slug pattern, the length, the reserved list, and
that exactly one page carries the root slug. It cannot compare one property
across array items, so `isBaseSiteDefinition` rejects a duplicate page id and a
duplicate page slug, exactly as it already rejects a duplicate blog post id.
`isSiteDefinition` runs that check too, through the page-component registry.

### 3. The 1.6.0 projection

`projectSiteDefinitionSchema` turns the one `home` object into one page. The
page keeps the id, the media, the SEO block and the sections it had, byte for
byte. It gains the root slug and a title.

The title is the site name. A blank home SEO title already falls back to the
site name, so the upgraded site renders exactly what it rendered before.

The page step runs after every earlier field step, in the order those fields
arrived. The earlier steps read whichever shape the stored definition is in.

### 4. One home-page accessor

`homePage(definition)` returns the page with the root slug. Every caller that
still works on one page, and that needs the page itself, reads it through this
function. Code that only has to compare one slug reads `homePageSlug`. `homePageIndex` gives
the same page's position for code that writes into a mutable draft, and
`replacePage` returns a definition with one page swapped.

`findPageById` and `findPageBySlug` are the general readers.

`resolveHomeSeo` is replaced by `resolvePageSeo(definition, page)`. The
fallbacks are unchanged on the home page: the SEO title falls back to the site
name there, and to the page title followed by the site name on any other page,
which is what a blog post already does.

## Consequences

The accessor is the seam that lets each area move to the full page collection
on its own. Tickets #153 to #162 each replace `homePage(definition)` with a
selected page in one area, and nothing else has to change at the same time.

Schema 1.7.0 needs the same version bump, projection step and regenerated
validator that every field change since 1.4.0 has needed. The version is part
of the blog post render model, so every blog post artifact fingerprint changes
and every open approval is invalidated, as ADR-0004 requires for a schema
change.

An installation upgrades with no manual step. Its stored definition is read
through the projection, so both a `foundry/published-site.json` written under
an older schema and a D1 revision row written at 1.6.0 upgrade on read. The
published content hash changes, so `assert-exact-production-content.mjs`
records the 1.6.0 hash as a compatible value for a deployment made before the
upgrade.

Media occurrence ids are still the closed pair `occurrence_home_hero` and
`occurrence_home_detail`, and the analytics content id is still the home page
id. Ticket #162 opens both to any page.

## Alternatives considered

**Keep `home` and add `pages` beside it.** Two places would hold the same page.
They would drift, and every reader would have to decide which one is true.

**Give the home page the slug `home`.** The public site would then serve the
home page at `/home` or need a special case for `/`. The empty root slug needs
no special case.

**Order-based home page: the home page is `pages[0]`.** A reorder in the Pages
list would silently change which page is served at `/`. The root slug states
the intent, and the schema can require exactly one page to carry it.

**A branded page id type, like `SiteId` and `BlogPostId`.** The id was a plain
string before this change, and branding it would touch every caller in tickets
#153 to #162 at once. It stays a plain string until one of those tickets needs
the stronger type.

**Change every `definition.home` reader in this ticket.** One change across
about forty files, with no way to review or revert one area at a time. The
accessor keeps each later ticket small.

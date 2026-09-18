# ADR-0019: A link can target a page, by its id, and this widens `SiteHref` without a schema step

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

[Issue #155](https://github.com/Humber-Foundry/foundry-cms/issues/155) asks
for a navigation link that targets a page in the site, not only an anchor on
the home page or a `mailto:` address. ADR-0016 gave a site more than one page;
ADR-0018 gave every page below the home page its own route. Until this
ticket, a link had no way to name either.

`SiteHref` and its schema twin `$defs/href` are one shared definition. Three
things read it: `site.navigation`, a hero section's `primaryAction` and
`secondaryAction`, and a call-to-action section's `action`.

### Does this need a schema version step?

ADR-0016 and every schema change since 1.4.0 bumped `schemaVersion` because
the stored shape changed: a field was added, renamed, or moved, so an older
stored document needed a projection step before it matched the current
shape. ADR-0014 (campaign images) shows the other case: a schema is
unchanged when nothing stored has to be rewritten to stay valid.

This change adds two new accepted string patterns to `$defs/href` —
`page:<pageId>`, `page:<pageId>#<anchor>` — and one new accepted constant,
`blog`. The two existing patterns, `#anchor` and `mailto:`, are untouched. A
definition stored before this ticket already validates against the widened
schema, because its `href` values still match one of the anyOf branches, byte
for byte. No stored document needs rewriting, so **this is a compatible
widening: no `schemaVersion` step, no projection step.** `npm run
generate:site-validator` still regenerates the validator, because the JSON
Schema text changed, and the MCP tool-schema snapshots are regenerated too,
because `content.patch`'s field-path enum gains one path per navigation item.

## Decision

**A link target is one of four things: an anchor on the home page (the
existing shorthand), a page by id, a section on a page by id, or the Blog.**
`SiteHref` and `$defs/href` widen to carry all four. `parseSiteHref`,
`resolveSiteHref` and `findPageHrefReferences` in the new
`packages/site-definition/src/site-href.ts` are the one place that reads,
resolves, and looks up this value; everything described below is what they
do.

### 1. The stored forms

- `#anchor` — unchanged. Every definition stored before this ticket wrote
  this to mean one thing: a section on the home page. It keeps meaning that,
  so a stored link stays valid and renders exactly as it did before.
- `mailto:<address>` — unchanged.
- `page:<pageId>` — a whole page, by its stable id. A slug rename (#159)
  moves nothing this link points at.
- `page:<pageId>#<anchor>` — one section on one page, home or not.
- `blog` — the Blog. The Blog is a single, always-present destination, not a
  page in `pages`, so it names no id.

### 2. Resolving a link to an address

`resolveSiteHref(definition, href, { currentPage, pageHref, blogHref })`
turns a stored value into the address a browser follows.

- `currentPage` is the page being rendered, or `null` on a route with no
  page, such as the Blog.
- `pageHref` builds one page's public path. `pagePath` in `seo.ts` is the
  production builder. Ticket #156 (preview per page) passes its own builder
  here, so the exact same resolution runs inside a revision preview; this is
  why the function takes a builder instead of hard-coding `pagePath`.

An anchor resolves against whichever page it names — the home page for
`#anchor`, the given page for `page:<id>#<anchor>` — with one rule: **when
that page is the page being rendered, the address is the bare anchor; from
any other page, it is that page's path plus the anchor.** A visitor already
on the page jumps in place; a visitor elsewhere is sent to the right page and
lands on the right section. This is why, on the reference installation's own
home page, its nav links now render `#section_contact` instead of
`/#section_contact` as they did before this ticket: the fix in
`site-shell.tsx` was exactly this same-page case, which `navigationHref`
never had, because until ADR-0018 no page other than home existed to render
a link from.

### 3. Validation refuses a dangling page reference

JSON Schema cannot compare a `page:<pageId>` value against `pages` — the same
limit that already makes `isBaseSiteDefinition` check duplicate page ids and
slugs by hand. `isBaseSiteDefinition` now does the same walk for every
navigation item, hero action, and call-to-action action: a `page:` href that
names no page in the definition is refused. The per-field `validate` on the
navigation href field repeats this check so the owner sees the message
before they save, not only after.

### 4. The editor's page picker

The Navigation group gains one field per navigation item, `<id>.href`,
alongside the existing `<id>.label`. `EditableSiteField` carries
`siteHrefTargets` — every page's id, title, and anchorable sections — only on
a field that stores a `SiteHref`. The dashboard's `SiteHrefField`
(`components/site-href-field.tsx`) reads it to offer four choices: a page, a
section on a page, the Blog, or an email address, each with its own control
instead of a typed path. Choosing "a section on a page" lists every section
on the chosen page by a plain name (`anchorSectionLabel` in
`editable-fields.ts`), built from the section's own title or eyebrow where it
has one.

The stored value stays a plain string edited through the existing
`format: "plainText"` path — the picker is a presentation choice, not a new
edit protocol, so every existing write, validate, and apply rule for a
plain-text field still applies unchanged.

### 5. What #159 needs before it can delete a page

`findPageHrefReferences(definition, pageId)` returns every navigation item,
and every hero or call-to-action button, whose link targets the given page.
Ticket #159 calls this before it lets an owner delete a page, so it can
refuse the delete and name what still points at it instead of leaving a
broken link.

## Consequences

- A navigation link can send a visitor to another page, a section on it, the
  Blog, or an email address, chosen from a picker.
- Deleting a page that a link still targets is not this ticket's job (#159),
  but the one helper #159 needs to check for that is written and tested now.
- A hero button or a call-to-action button can, at the schema level, also
  hold a `page:` or `blog` value, because they share `$defs/href` with
  navigation. **This ticket does not resolve that value in their renderer**
  (`apps/reference-site/foundry/page-component-renderers.tsx`, which is
  outside this ticket's key files and still renders `section.primaryAction
  .href` etc. literally) **and offers no picker for them.** Nothing in this
  ticket, the reference installation, or its tests writes one of the new
  values there, so today's hero and call-to-action links are unaffected,
  byte for byte. A future ticket must add resolution to that renderer, and
  pass page/anchor context into it, before any editor offers this picker for
  a hero or call-to-action link.
- The issue's acceptance criteria call the second editable group "footer,"
  and ask that "a navigation or footer item" reach the four targets. The Site
  Definition schema and [Spec #34](https://github.com/Humber-Foundry/foundry-cms/issues/34)
  ("story 26: edit navigation labels, **footer copy**...") agree that
  `site.footer` is one block of plain copy, not a list of links — there is no
  footer link list anywhere in this codebase to add a picker to. This ADR
  treats "footer" in the issue text as carried over from a template rather
  than a real second target, and implements the picker for the one link list
  that exists: navigation. If the owner does want footer links, that is a new
  field on `SiteDefinition` — a materially different, product-level change
  outside what #1, #34, #146, or an existing ADR describes — and needs its
  own ticket.
- `resolveSiteHref`'s `pageHref` argument is unused by any caller but the
  production one today. It exists now so #156 can supply a preview builder
  without changing this function's shape.
- **A `page:` link clicked inside today's revision preview leaves the
  preview.** The preview route
  (`app/__foundry/preview/[workspaceId]/[revision]/page.tsx`) renders only the
  home page — there is no preview route for any other page yet, because that
  route is #156's job ("preview per page"). Its `SiteHeader` has no other
  address to send a `page:<id>` link to, so it falls back to that page's
  plain public path, `pagePath(target)`, the same address the link resolves
  to on the live site. Following the link exits the preview: the visitor
  lands on whatever is actually published at that path, with the preview's
  access token and revision context dropped. An anchor on the home page
  (`#anchor` or `page:<home id>#anchor`) and `blog` are unaffected — both
  already resolve inside the preview, because the preview always renders the
  home page and `blogHref` is passed in by the preview route itself. The
  issue's acceptance line, "Links render correctly on the public site and
  inside a revision preview," is only true with that one carve-out until
  #156 ships a page to send a `page:` preview link to. #159 and #156 should
  read this before either is called done.

## Alternatives considered

**A schema version step to 1.8.0, with a projection.** Rejected: nothing
stored needs to change shape, and every 1.7.0 value stays valid under the
wider `anyOf`. A version step here would invalidate every open approval
(ADR-0004) and change the published content hash for no reason tied to what
changed.

**A new `$defs` definition for navigation only, leaving hero and
call-to-action on the old, narrow `href`.** This would avoid the "hero/CTA
share a widened type but no renderer for it" consequence above. Rejected
because the issue names `SiteHref` and `$defs/href` directly as what to
change, and because navigation, a hero action, and a call-to-action action
are the same kind of thing — a labelled link — so giving them different
target vocabularies would be a harder rule to explain than the one
documented consequence above.

**Keep `#anchor` ambiguous: resolve it against `currentPage` instead of
always the home page.** Rejected. Every definition stored before this ticket
wrote `#anchor` when a site could only ever have one page, so it always meant
that page — the home page. Reading it against `currentPage` instead would
silently change what an existing link points to on the first page that is
not home, which is exactly the kind of change ADR-0016 and ADR-0018 require
an upgrade to avoid.

**Add `pageHref` as a new prop threaded through `SiteRenderer` in this
ticket, even though nothing calls it yet.** Rejected as unnecessary now:
`resolveSiteHref` already accepts a builder, which is the seam #156 needs;
adding an unused prop to `SiteRenderer` ahead of the caller that would use it
is speculative, and #156 can add it when it exists to consume it.

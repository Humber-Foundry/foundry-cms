# ADR-0033: A page is created, renamed, duplicated and deleted by one set of application operations, and its name and web address are ordinary editable fields

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

Until now a site built on this product has exactly one page. Everything
needed to hold more than one has landed: the page collection
([ADR-0016](ADR-0016-site-definition-page-collection.md)), page-scoped field
paths ([ADR-0017](ADR-0017-page-scoped-editable-field-paths.md)), public page
routes ([ADR-0018](ADR-0018-public-page-routes.md)), links that point at a page
([ADR-0022](ADR-0022-navigation-links-to-pages.md)), a review summary that
covers every page
([ADR-0023](ADR-0023-approval-fingerprint-and-review-summary-cover-every-page.md)),
page selection in the editor ([ADR-0024](ADR-0024-editor-page-selection.md)),
per-page photos and analytics
([ADR-0026](ADR-0026-analytics-and-media-occurrences-per-page.md)), a preview
address for each page ([ADR-0029](ADR-0029-page-scoped-revision-preview.md)),
and a section slot per page
([ADR-0032](ADR-0032-page-composition-slot-per-page.md)).

[Issue #159](https://github.com/Humber-Foundry/foundry-cms/issues/159) is the
one that lets a site owner make the second page. Two things had to be settled
before writing it. Where the rules live, because
[#161](https://github.com/Humber-Foundry/foundry-cms/issues/161) adds MCP page
tools that must refuse for exactly the same reasons as the dashboard. And what
a page id is, because ADR-0032 records that nothing in the schema stops a page
taking the id `home`, and a page that did would claim the home page's own
section slot.

## Decision

**Creating, renaming, duplicating and deleting a page are four operations in
`packages/application`, built on the same revision, idempotency and
authorization path as every other content operation. A page's name and its web
address are editable fields, so a rename is an ordinary draft edit.**

### 1. A page id is minted from the request, never from the words

`mintedPageId` in `packages/site-definition/src/page-lifecycle.ts` builds an id
as `page_` followed by twenty hexadecimal characters of a digest. The
application hashes the one thing that identifies the request that mints the
page: its idempotency key, inside its workspace.

Three things follow. Sending the same create twice mints the same id, so a
retry after an unknown result can never leave two pages behind. The id is never
built from the page name or the web address, both of which change while a page
id never does. And a fresh request always carries a fresh key, so a deleted
page's id is never minted again inside a draft.

The `page_` prefix makes the id `home` impossible, which is what ADR-0032
asked for. The operations also refuse any id they did not mint and any id
already in the draft.

### 2. The page name and the web address are editable fields

`listEditableSiteFields` now yields `<pageId>.title` and `<pageId>.slug` for
every page, including the home page, the same way a page's SEO fields already
carry the page id. Three things follow from one change.

The review summary reads them as fields. `createContentChangeSummary` used to
compare `page.title` and `page.slug` directly; that comparison is gone, and the
same two lines — `Page name` and `Web address` — now come from the field loop
like every other change.

`renamePage` is those two edits run through `applySiteDefinitionEdits`. There
is no second set of rules: an owner who retypes the address in the editor and
an owner who uses Rename on the Pages list read the same refusal, because the
refusal is written once, in the field's own check.

The refusals themselves live in `pageSlugRefusal`: the address must be
lowercase words joined by single hyphens, at most 120 characters, not one of
the routes the installation already serves, and not already used by another
page. Each one is a sentence a site owner can act on rather than a schema
mismatch.

### 3. The home page keeps the root address, and this ticket cannot move it

ADR-0017 records that making another page the home page moves both pages'
fields between prefixed and unprefixed paths, which renames published
rich-text files and invalidates stored draft paths. That is a large change and
it is not part of this ticket.

`pageSlugRefusal` therefore makes it impossible rather than merely undone: the
home page may only hold the root address, and no other page may hold it. The
rule sits on the field, so it holds for the rename operation, for the MCP page
tools, and for an ordinary editor save alike. Moving the home page role needs
its own ticket and its own decision record.

### 4. A duplicate shares its pictures and nothing else

`duplicatePageInDefinition` gives the copy a new page id and a fresh id for
every section it holds, built from the new page id. No two pages share a
section id, and therefore no two pages share a field path. Nested items —
service rows, proof metrics, button records — are renumbered under their new
section by `remapPageSectionNestedIds`.

A link inside a copied section that pointed at a section of the page being
copied is rewritten to point at the copy's own section. Without that the button
on the new page would quietly send a visitor to the old page. Every other link
— an email address, the Blog, a different page — is copied exactly as it was.

Photos are copied by reference: the occurrence id is rebuilt for the new page,
as ADR-0026 requires, and the stored picture behind it is the same one. Nothing
is uploaded again, and deleting either page leaves the other's photo alone.

### 5. A delete is a draft change, and two things refuse it

The home page cannot be deleted, because every site serves something at its
root and the schema requires exactly one page with the root address.

A page that a navigation item or a hero or call-to-action button still links to
cannot be deleted either. ADR-0022 wrote `findPageHrefReferences` for this;
`removePageFromDefinition` calls it and refuses with a sentence that names each
blocking link, and the Pages list turns those names into links that open the
screen where each one is edited. Deleting anyway would make the whole
definition invalid, because `isBaseSiteDefinition` refuses a `page:` link that
names no page.

Everything else about a delete is ordinary. It becomes a new revision, it
appears in the review summary as `<page> — page removed`, it is previewed and
approved and published like any other change, and an earlier published revision
still holds the page.

### 6. Three starting points, built only from registered sections

A new page starts blank, or from `Introduction` (an opening banner and a call
to action) or `What you offer` (an opening banner, a list of services and a
call to action). Each one is scaffolded through
`registry.createDefault`, so a starting point can only ever place a section the
editor can edit and the renderer can draw. Adding a fourth is a data change in
`pageStartingLayouts`, not new code.

### 7. The revision is the audit record

A page operation writes an immutable revision carrying who made it, when, and
the idempotency key that identifies the request, and it accepts the same
`joinedAudit` an MCP mutation supplies. That is exactly what `save` — the
content operation these sit beside — already writes, so page operations need no
new table and no migration.

## Consequences

Ticket #161 can add MCP page tools by calling `createPage`, `renamePage`,
`duplicatePage` and `deletePage` with a typed command and reading the typed
result. It gets every refusal, the idempotency key, the base-revision check and
the audit record without repeating any of them, and `ContentPageOperationError`
carries a stable `code` for a tool to branch on.

Adding two fields per page changes the set of editable field paths, which is
the set `content.patch` accepts. A site with more pages now has more paths;
nothing existing moved, because both new paths carry the page id on every page.

A create, a delete or a rename changes the design projection ADR-0023 hashes,
so each one invalidates an open approval and the owner is asked to look again.
That is the intended cost of a structural change.

Changing the web address of a page that is already on the live site breaks the
old address. The Rename dialog says so before publish, and the review summary
lists `Web address` among that page's changes. Redirects from the old address
are **not** in this ticket and nothing is filed for them: whether this product
should keep a redirect table at all is a product question, not a gap left
behind by this change.

The reference site stays a one-page published site. The browser journey makes
its page inside a draft and deletes it again, so nothing in the published
reference content changes.

## Alternatives considered

**Derive the page id from the slug.** It reads well in a field path and in a
published file name. It was rejected because a page id must never change and a
slug is meant to change: the first rename would either strand every published
file and stored draft path, or leave an id that contradicts the page's address.

**Mint the page id with `crypto.randomUUID()`.** Simple, and it is what a blog
post id already does. It was rejected because a retry of the same create would
mint a second id and leave two pages, and the whole point of the idempotency
key is that a retry changes nothing.

**Keep the name and the web address out of the field list and rename a page
through its own definition function.** It was rejected because the review
summary would then need to keep its own comparison for those two values, the
editor could not show them, and the same rule would be written twice — once for
the rename operation and once for anything else that wrote a page.

**Let a duplicate keep the source's section ids.** ADR-0017 allows it: the page
id in front of the section id already keeps two pages' field paths apart. It
was rejected because a shared section id is confusing wherever a section is
named without its page — in an anchor, in a recovery record, in a review line —
and there is no benefit to set against that.

**Move the home page role when a page is given the root address.** It was
rejected for this ticket because it re-paths both pages' fields, renames
published files and invalidates stored draft paths (ADR-0017). Refusing it
outright is honest and reversible; doing it quietly is neither.

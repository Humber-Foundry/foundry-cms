# ADR-0017: A field path carries its page id, and the home page keeps its old paths

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

ADR-0016 replaced the one `home` object with a `pages` collection. The
editable-field layer still read one page, so only the home page had editable
fields.

A field path is the name of one editable field. Three stored things are named
after it:

1. The published rich-text file. The field path `section_contact.body` is
   published as `content/rich-text/section_contact/body.md`.
2. A stored draft. A D1 revision row holds the edits an owner saved, and each
   edit holds the path it was made under.
3. The MCP content tools. `content.patch` publishes the list of field paths an
   agent may set, as an enum in its input schema.

A section id is unique inside its page and nowhere else. Two pages may
therefore hold sections with the same id, which a duplicated page produces at
once. Without a page in the path, the two pages' fields would collide, and the
duplicate-path guard would refuse the whole definition.

An installation must upgrade with no manual step and see no change it did not
ask for. If the home page's paths changed, the first publish after the upgrade
would delete every rich-text file and write it again under a new name, and
every stored draft path would stop resolving.

## Decision

**A field path is built from the page id. The home page adds no prefix.**

`pageFieldPath(page, pathInPage)` is the one place that builds the prefix:

- The home page returns the path unchanged: `section_contact.body`.
- Every other page returns its page id, a dot, then the path:
  `page_about.section_contact.body`.

A page's SEO paths already start with its page id on every page, including the
home page, so they need no second rule.

The prefix is the page id and never the slug. A page id never changes, so a
slug rename moves no published file and invalidates no stored draft.

A page's fields also name their page. Every editable field of a page carries
`pageId`, so a caller shows one page's fields without reading its paths apart.

## Consequences

An installation that upgrades and publishes writes exactly the rich-text files
it wrote before, because the home page is the only page it has. Its stored
drafts stay valid for the same reason, and the `content.patch` enum of field
paths is unchanged.

The home page's exception is permanent. It is one branch in one function, and
`pageFieldPath` is the only caller-visible rule.

Making another page the home page moves that page's fields to unprefixed paths,
and moves the old home page's fields under its page id. Ticket #159 owns the
slug change that could do this, and already has to call out a slug change on a
published page before publish.

**Settled by [ADR-0033](ADR-0033-page-lifecycle-operations.md):** #159 keeps
this out of scope and makes it impossible rather than merely undone. The home
page may hold only the root address, and no other page may hold it. Moving the
home page role needs its own ticket and its own decision record.

`listEditableSiteFields` now returns every page's fields. The field list of a
single-page site is unchanged, in the same order, because the home page is
read first. The dashboard content editor shows the whole list, so it shows
every page's fields until ticket #157 filters by `pageId`.

## Alternatives considered

**Prefix every page, the home page too.** One rule, no exception. It renames
every published rich-text file on the first publish after an upgrade and breaks
every stored draft path, which ADR-0016 forbids.

**Prefix with the slug instead of the page id.** The home page would need no
prefix on its own, because its slug is the empty string. A slug rename would
then move every published file of that page and break its stored drafts, which
is the failure a stable page id exists to prevent.

**Keep the bare section id and require section ids to be unique across the
whole site.** No path would change and no prefix would be needed. Duplicating
a page would then have to rewrite every section id in the copy, so the copy
could not share the ids the owner sees, and the schema would need a new
site-wide uniqueness rule that a stored definition may already break.

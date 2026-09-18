# ADR-0020: The approval fingerprint and the review summary cover every page

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amends:** [ADR-0004](ADR-0004-draft-preview-publish-pipeline.md)

## Context

ADR-0004 makes one promise about approval: an approval is bound to the exact
content the person saw. ADR-0016 then replaced the single `home` object with a
`pages` collection, and ADR-0017 gave every page's fields their own paths.

The approval fingerprint was written before pages existed. Its design
projection read the home page alone: it carried `pageId` and the home page's
sections and nothing else. The rest of the fingerprint reads the whole
definition, so a change on a second page still changed the content hash. The
design projection was the one part that could not tell two pages apart.

The review summary a person reads before approving had the same gap in a
different form. It listed raw field paths, such as `page_about.section_hero.title`.
A site owner cannot read a page id, and a removed page left no line at all,
because its fields simply stopped being listed.

## Decision

**The design projection covers every page, and the review summary names every
changed, created and removed page by its title.**

### The design projection

`designProjection` maps `definition.pages` in order. Each entry carries the
page id, the slug, the title and that page's sections. A change on any page, a
new page, a removed page, a renamed page and a moved page all change the design
hash, and so change the approval fingerprint.

### The one-time fingerprint step

The projection could have kept the home page's old shape and added other pages
beside it, so a site with only a home page would keep its old fingerprint byte
for byte. We rejected that. It would leave two shapes for one safety property,
and the shape a site gets would depend on how many pages it has. A defect in
the rarely used branch would be a defect in the guard that binds an approval to
what a person saw.

So the projection has one shape, and a site with only a home page gets a new
design hash once. Every approval that is open at the upgrade becomes stale, the
publisher is refused with `approval_stale`, and the person approves again after
looking at a fresh preview. This is the same one-time cost the 1.7.0 schema step
already paid, and it fails closed: nothing is published that nobody approved.

A later change to this projection repeats that cost, so it needs its own
decision record.

### The review summary

`createContentChangeSummary({ base, draft })` in
`packages/application/src/content-change-summary.ts` is the one place that
describes a draft to a person. Its result is `ContentChangeSummary`:

- `pages` — one entry per page the reviewer must look at, with the page id, the
  page `title`, the visitor's `path`, a `state` of `created`, `changed` or
  `removed`, and `changedFields` written as the field names the editor shows.
  A created or a removed page lists no fields, because the whole page is the
  change.
- `changedDocuments` — one short line per page and one for the settings that
  belong to the whole site, such as `About us — Hero: Hero title`,
  `About us — new page at /about` and `About us — page removed`.
- `designChanges` — the same lines for design choices, such as a section layout.
- `publicEffect` — what a visitor sees after publication, ending with the
  sentence that says reading the review neither approves nor publishes.

A page is named by its title and its web address, never by its page id. A page
name and a web address are not editable fields yet, so the summary compares
them directly and reports them as `Page name` and `Web address`.

## Consequences

An approval can no longer survive a change to a page the approver did not open.
A created or a removed page is visible in the fingerprint and in the words the
reviewer reads.

Every approval open at the upgrade must be made again. The refusal is the
normal `approval_stale` refusal, so no new screen or message is needed.

The review summary has one typed shape, so the human review screen and the MCP
preview tools describe a draft the same way. It is not part of any MCP output
schema today; adding it there is a schema change with its own snapshot step.

The summary reads two definitions and holds no state, so it stays cheap to call
from a route and easy to test.

## Alternatives considered

- **Keep the home page's projection shape and append other pages** — rejected
  above: two shapes for one safety property.
- **Leave the design projection alone because the content hash already covers
  every page** — rejected. The design hash is the part of the fingerprint that
  names what the approver looked at, and a guard that is true only by accident
  in another field is not a guard.
- **Report field paths and let the screen translate them** — rejected. Two
  surfaces would need the same translation, and a removed page has no field
  path to translate.

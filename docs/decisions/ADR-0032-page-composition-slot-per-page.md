# ADR-0032: Every page has its own section slot, and the editor writes only to the page it has open

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

ADR-0016 gave a site a collection of pages. ADR-0017 gave every editable field
its page id. ADR-0024 made `editor-page-selection.ts` the one module that
answers which page the owner opened, and left the visual canvas on the home
page. On any other page the editor said that adding, moving and removing
sections was not ready there yet.

Behind that message, five areas still read `homePage(definition)`:

- the Puck projection that draws the canvas and reads it back,
- the undo history and the merge of a revision saved elsewhere,
- the draft recovery that restores unsaved work after a crash,
- the schema recovery that carries work across a schema change,
- the Design destination's list of section styles.

Each one also wrote back to the home page. Simply passing the selected page in
was not enough, because two things named the home page and nothing else:

1. **One slot identifier.** A page's sections live in a slot called
   `slot_home_sections`. The browser stores an unsaved structural change under
   that identifier, and an error about the slot is reported under it. With one
   identifier for every page, a change made on one page would be restored onto
   another after a reload or a crash.
2. **One composition per save.** A save carried at most one `composition`. A
   restored draft or a revision saved elsewhere can leave an unsaved structural
   change on a page the owner is not looking at, and a save carrying the open
   page alone would silently drop it.

An edit on one page changing another page is the worst outcome this CMS can
produce: the owner would not see it happen, and the wrong page would publish.

## Decision

**Every page has its own section slot, named after the page, and every
composition names the page it belongs to.**

### 1. The slot id names the page

`pageCompositionSlotId(page)` returns `slot_home_sections` for the home page
and `slot_<pageId>_sections` for every other page. This is the same rule
`pageFieldPath` uses for field paths and `pageMediaOccurrenceId` uses for media
occurrences, and it is kept for the same reason: the home page's identifiers
are already in stored drafts and published files, so renaming them would make
every stored home-page recovery record unreadable.

A page id never changes, so a slug rename leaves the identifier alone. Two
pages can never share a slot id.

`findPageByCompositionSlotId(definition, slotId)` reads the identifier back.
That is all a stored record needs: it names its own page, so it is restored to
the page it was made on after a reload, a page switch, or a crash. A record
written when the CMS held one page carries `slot_home_sections` and still
resolves to the home page.

### 2. Every composition function takes the page

`applyPageComposition`, `toPageComposition`, `toPageCompositionIdentity`,
`referencedPageComponentIds`, `definitionToPuckData`, `puckDataToDefinition`
and `pageCompositionChanged` all take the page they act on. None of them reads
`homePage` any more, so none of them can be called without saying which page is
meant. `applyPageComposition` refuses a composition whose slot id is not the
page's own, so a composition built for one page cannot be written onto another
even by a caller that has the wrong page.

A new section is scaffolded with `PageSectionContext` — the draft and the page
together — so the anchor link it builds points at a section of the page it
lands on, not at a section of the home page.

### 3. A save carries one structural change per page

`SaveContentRevisionCommand.composition` became `compositions`, a list holding
at most one entry per page. Each entry names its page through its slot id, and
the save writes each onto its own page. Two entries for the same page are
refused, because the result would depend on the order they arrived in.

This is what keeps a restored change on a page the owner is not looking at.
The editor builds the list from every page whose sections differ from the
stored draft, not from the page on screen.

### 4. The undo history and the merge cover every page

The history compares the structure of every page, and the merge of a revision
saved elsewhere keeps each page's local order within that page alone. A
comparison of the home page alone would miss both an incoming change to
another page and the owner's own unsaved change to one.

The undo and redo stacks hold whole drafts, as they did before. Opening
another page is a fresh visit to the editor, so each page is undone and redone
from its own starting point.

### 5. The unfinished-canvas message is gone

Every page now gets the same editing as the home page: its words on the page,
its photos, its section styles, and adding, moving, duplicating and removing
its sections. ADR-0024 section 6 is superseded.

## Consequences

`pageCompositionContract` still publishes the home page's `slot.id` and
`slot.path`, because the contract is published as one shape and those are the
identifiers already in stored drafts and published files. Callers that act on
one page use `pageCompositionSlotId(page)` instead.

The Design destination names no page of its own — it edits the whole site — so
the editor passes it the page it has open, and its section-style list follows
the same page as the canvas. Design opens with no page in the address, so that
page is the home page, which is what it showed before.

`homePage(definition)` remains in the public site routes, the media API, the
MCP read surface, the SEO share-image rule and the site technical detail panel.
Each of those genuinely means the home page, or is a surface a later ticket
moves: MCP page tools are ticket #161.

Ticket #159 adds creating, renaming, duplicating and deleting pages. A new page
gets its slot id from its page id with no further work. A deleted page's stored
recovery record resolves to no page, and the recovery refuses it rather than
restoring it onto another page.

## Alternatives considered

**Keep one slot id and store the page id beside it in the recovery record.**
No new identifier rule. Every record written before the change would carry no
page id, so the recovery would have to guess, and the guess would be the home
page — which is exactly the failure this decision prevents for a record made on
another page.

**Prefix the home page's slot id too, as `slot_<homeId>_sections`.** One rule
with no exception. Every stored home-page recovery record would stop matching,
so an owner mid-edit at the moment of release would lose unsaved work.

**Keep one composition per save and send the open page's.** The smallest
change. A structural change restored onto a page the owner is not looking at
would be dropped at the next save, with nothing on screen to say so.

**Let each area take the page and leave `applyPageComposition` on the home
page.** Less churn in the domain package. The check that a composition matches
its page would then exist nowhere, so a caller passing the wrong page would
write one page's sections onto another and the tests would not catch it.

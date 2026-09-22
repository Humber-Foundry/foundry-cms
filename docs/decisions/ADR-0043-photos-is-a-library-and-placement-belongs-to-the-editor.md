# ADR-0043: Photos is a library, and a photo is placed where it is seen

- **Status:** Accepted
- **Date:** 2026-09-21
- **Follows:** [ADR-0026](ADR-0026-analytics-and-media-occurrences-per-page.md),
  [ADR-0032](ADR-0032-page-composition-slot-per-page.md),
  [ADR-0037](ADR-0037-mcp-photo-tools.md)

## Context

The Photos screen (`/dash/media`) had two parts. The top part was the photo
library: upload a photo, look at the grid, delete one. The bottom part was a
section named "Where photos appear". It said "The page has two photo places.
Select a photo above, then place it", and drew two cards, "Top of the page"
and "Further down the page", each with a button "Use the selected photo here"
and a crop editor.

The owner reviewed the dashboard on 2026-09-21 and said he did not know what
that section was for. Issue
[#225](https://github.com/Humber-Foundry/foundry-cms/issues/225) records the
review; issue [#232](https://github.com/Humber-Foundry/foundry-cms/issues/232)
is this change.

Two further faults sat in the same section.

**It only ever showed the home page.** The two place cards came from
`renderedMediaOccurrenceIds`, a fixed list of the home page's two occurrence
ids, and the screen read `homePage(draftDefinition).media`. ADR-0026 had
already widened an occurrence id to `occurrence_<page>_<slot>`, so a photo
placed on any other page was invisible here.

**It was a second way to do one thing.** A photo can already be changed on the
page itself: the page editor draws the photo and puts "Change photo" on it
(`canvas-image-field.tsx`), and an agent places one through MCP
`foundry.media.place` (ADR-0037). The Photos screen was a third place, with a
different shape and its own words.

## Decision

**Photos is a photo library and nothing else.** It holds: upload a photo, see
every photo, select one to look at it, and delete one. It holds no way to put
a photo on a page.

**Every photo says where it is used, in the owner's words.** Under each photo
there is one line per use — `Used on: About — Top of the page` — and a photo
used nowhere says `Not used yet`. `sitePhotoUsage` in
`apps/reference-site/src/site-used-photos.ts` builds those lines by walking
every page of the published definition and of the draft: each page's media
occurrences, every photo a section holds however deeply, and every published
blog post. The page title and the place name stay together, so the line names
both. A section the installation registered is named by its own label; a
foundation section has no such label, so its photos are named by their page
alone, because a section type word such as `callToAction` is not the owner's
language.

**Deleting a photo the site uses is refused, and the refusal names every place
that uses it.** The library refuses it before the request is sent, and the
server keeps its own refusal. The screen's lines come from the page render, so
a photo freed in the page editor is still called used until Photos is loaded
again; the answer is a refusal too many, never a photo deleted out from under
a page.

**A photo is placed where it is seen.** Two surfaces place a photo, and only
two: the page editor, at the photo itself, and MCP `foundry.media.place`.
Neither changes here.

**A place name is read from the slot at the end of the occurrence id.**
`placeFor` in `apps/reference-site/components/media-places.ts` matches
`occurrence_<page>_<hero|detail>`, so any page's places have names, not only
the home page's two. An id it does not recognise still shows, as itself,
because occurrence ids arrive from the server.

## Consequences

- The Photos screen no longer places or crops a photo. Cropping had no other
  surface, so a stored crop is still honoured everywhere it is drawn, and no
  screen sets one. A crop editor, if one is wanted, belongs beside the photo in
  the page editor.
- The media route still calls `requireRenderedMediaOccurrenceId`, which reads
  `renderedMediaOccurrenceIds`, so both stay. ADR-0026's note that
  `media-manager.tsx` reads that list is now historical.
- The dashboard's crop state helpers (`cropForOccurrence`,
  `cropForCatalogRefresh`, `cropForSelectedRevision`,
  `cropBaseRevisionForEdit`) and the placement helpers
  (`mergeMediaOccurrenceState`, `mediaOccurrenceAttemptAfterFailure`,
  `mediaOccurrenceMutationsEnabled`) had no reader left, so they are deleted
  with the screen that used them.
- The media route's `replace` and `crop` operations are unchanged, and MCP
  `foundry.media.place` is unchanged, so an agent and the page editor keep
  working exactly as before.
- A photo tile in the picker says only that the site uses the photo. The
  picker holds the draft's photo places without the page each one is on, and a
  place name with no page would name a page it cannot see.

## Alternatives considered

**Keep the section and widen it to every page.** It would have become a list
of every page's two slots — longer, and still a second way to do what the page
editor already does on the page itself. The owner's own instruction was to take
it out.

**Leave the usage line as the old badge, "On the page".** It does not say
which page, and with more than one page that is the question the owner asks.

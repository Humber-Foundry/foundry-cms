# ADR-0021: The address names the page being edited, and one module answers which page it is

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

ADR-0016 gave a site a collection of pages. ADR-0017 gave every editable field
its page id. The dashboard still opened one page: Pages went straight into the
editor on the home page, and the owner had no way to see or open any other
page.

The editor is not one screen. The field list, the visual canvas, the undo
history, the draft recovery and the used-photo scan each read the definition on
their own. Tickets #158 to #162 move those areas onto the selected page one at
a time. If each area worked out the selected page for itself, they would drift,
and a later ticket would have to find every copy of the rule.

A page must also be reachable by address. An owner shares a link to a page, a
reload must come back to the same page, and returning from the preview must not
drop back to the home page.

## Decision

**A page is addressed as `?page=<id>`, and `editor-page-selection.ts` is the one
module that resolves it.**

### 1. Pages opens on a list

`/dash/pages` shows every page of the current draft: its title, the address it
is served at, and whether it is on the live site. The home page is marked.
Opening a row goes to `/dash/pages?page=<id>`, which opens that page in the
same editor.

### 2. The page id, never the slug

The address carries the page id, because a page id never changes. A slug rename
would otherwise break every link an owner had saved. This matches ADR-0017,
where a field path carries the page id for the same reason.

### 3. One module answers "which page?"

`resolveEditorPage(definition, requestedPageId)` returns the page being edited.
An address naming no page returns the home page, so every destination that
still edits one page keeps working with no change. `listEditorPages`,
`editorPageHref` and `fieldsForEditorPage` sit beside it, so the list, the
switcher and the field filter all read the same rule.

Ticket #158 passes the page from `resolveEditorPage` into the Puck projection,
the undo history and the draft recovery. It changes those areas; it does not
change how the page is chosen.

### 4. A missing page comes back to the list

An address naming a page the draft does not hold returns to the list and says
so. Opening a different page without a word would let an owner edit one page
believing they were editing another.

### 5. Filtering is for the screen, never for the draft

`fieldsForEditorPage` decides what the owner sees. A field that names no page —
the site name, the navigation labels, the footer — shows on every page. A field
naming another page is left out. The draft still holds every page's fields and
still saves them all, so opening a second page never drops the first page's
edits.

### 6. The canvas stays on the home page until #158

The visual canvas still builds itself from the home page. Until #158 moves it,
the editor shows the canvas on the home page alone. On any other page the owner
edits that page's words in the field list, and the screen says that adding,
moving and removing sections is not ready there yet. A canvas that drew the
home page under another page's name would tell the owner something untrue.

## Consequences

Pages no longer opens straight into the editor, so the three browser journeys
that went to `/dash/pages` now open a page from the list first.

The address rewrites that follow a save and a recovery clean-up build their URL
from the selected page, so `?page=` survives a save and a reload.

The preview opens in a new tab, so the editor tab keeps its address while the
owner reads the preview and comes back to it. The separate "Back to the
dashboard" link inside the preview tab still lands on the Pages list, because
the preview is of the whole draft and names no one page. Carrying a page
through that link needs the preview routes to know which page was open, which
is ticket #156's work on a preview per page.

"Last edited" is shown once for the whole draft, not per page. A revision is
one immutable version of the whole definition, so the store holds no per-page
edit time. Showing a draft-wide time on each row would suggest a fact the CMS
does not have.

In-canvas navigation resolves a link by the path it points at. Today a
navigation item may hold only an anchor or a mail address, so no stored link
resolves to a page yet; ticket #155 adds page targets, and this rule then opens
them with no further change.

## Alternatives considered

**Address a page by slug.** The address would read better. A slug may be
renamed, and ADR-0016 kept the id stable for exactly that reason, so every
saved link would break on a rename.

**Keep Pages opening the home page, and put the list elsewhere.** The owner's
complaint was that Pages opens one page and hides the rest. A list somewhere
else would leave that complaint standing.

**Let each area read `?page=` for itself.** No new module. The rule would then
exist in the field list, the canvas, the history and the recovery, and tickets
#158 to #162 would have to keep four copies in step.

**Show the home page's canvas under another page's name until #158.** The
screen would appear complete. The owner would move a section believing it was
on the page they opened, and it would be on the home page instead.

**Filter the saved fields, not just the shown ones.** Simpler to reason about
on one screen. An edit made on one page would be dropped the moment the owner
opened another, because the save would carry only the open page's fields.

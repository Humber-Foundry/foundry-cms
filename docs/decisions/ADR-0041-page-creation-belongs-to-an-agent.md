# ADR-0041: Adding a page is an agent's job, and the dashboard only lists, renames, copies and deletes pages

- **Status:** Accepted
- **Date:** 2026-09-22
- **Amends:** [ADR-0033](ADR-0033-page-lifecycle-operations.md)

## Context

ADR-0033 gave a page four operations — create, rename, duplicate, delete —
and the dashboard offered all four. The Pages screen carried a "New page"
button that opened a dialog with a page name, a web address and a choice of
starting layout.

The owner reviewed that screen on 2026-09-21 (issue #225). Two things came
out of it. The list itself did not read as a list of pages: a row showed a
lone "/" and the words "On your site", with a flat row of buttons under it.
And the owner decided how a page should be added from now on: a coding agent
adds it through MCP, not a person through the dashboard.

Issue #229 asks for both: rebuild the row, and take the "New page" control
out.

## Decision

**A page is added by a connected agent calling `foundry.page.create`. The
dashboard lists pages and renames, copies and deletes them, and offers no
way to add one.**

### 1. The application still creates pages; only the dashboard stops asking

`createPage` stays exactly as ADR-0033 defined it, in
`packages/application`, in `packages/site-definition`, and on the
`/api/foundry-cms/revisions` route as the `create_page` operation. MCP
`foundry.page.create` (ADR-0034) is unchanged, and so are its scopes, its
receipts and its replay rules.

What changed is only the dashboard: `page-lifecycle-controls.tsx` no longer
draws a "New page" button and no longer has a create branch in its dialog.
The route keeps its `create_page` branch, because MCP and the application
both still use that path.

A page an agent makes appears in the Pages list on the next load, because
the list is read from the draft definition every time the screen is drawn
and never from a separate store.
`apps/reference-site/src/page-lifecycle-view.test.ts` drives the real
`foundry.page.create` tool against a real draft and then reads the list.

### 2. The screen says who adds pages

A control that is not there needs an explanation, or the owner reads the
screen as broken. The Pages screen carries one sentence under the heading:
new pages are added by an agent you connect, with a link to
`/dash/settings/connect-agent`.

### 3. The home page's menu holds no Delete

A delete of the home page can never succeed, so the menu leaves the item
out. The old screen drew a disabled Delete with a help tip beside it
explaining why. A control the owner cannot press is the fault the shared
`DashboardActionMenu` (issue #226) exists to remove, and its own guidance
says never to pass a disabled action.

The application still refuses a home-page delete with `page_is_home`, so
nothing depends on the menu for safety.

### 4. A refused save speaks through the box it names

The old dialog answered any 422 whose errors all mapped to visible boxes
with one fixed sentence telling the owner to check the boxes marked below.
The dialog has no checkboxes, so that sentence was wrong every time it
appeared. Issue #229 asked for the sentence to be taken out of the
repository, so it is not written out here either.

Now a refusal that names a box the dialog draws is shown beside that box
alone, and the dialog writes no sentence over the top of it. A refusal that
names anything else — a page that has gone, a page that is still linked —
has no box to sit beside, so its own sentence, which names what was wrong,
is shown instead.

## Alternatives considered

- **Keep "New page" and add the agent sentence beside it.** Rejected by the
  owner's decision in issue #225: pages are added by an agent.
- **Remove `create_page` from the application and from MCP as well.**
  Rejected, and ruled out of scope by issue #229. An agent needs the
  operation; only the dashboard stops offering it.
- **Keep Delete on the home page's menu but disabled, with the help tip.**
  Rejected. See section 3.
- **Replace the wrong sentence with a different summary sentence, such as
  "Something below needs your attention."** Rejected. A field message that is
  already on screen says the same thing better, and a second sentence over
  the top of it makes the owner read twice to learn one fact.
- **Keep the "Home page" marker beside the home page's title.** Rejected.
  Issue #229 names exactly three things a row holds: the title, the labelled
  address and the state. "Address: /" already says which page is served at
  the top of the site, and a fourth piece of text on the row would add a
  third text size to it.

## Consequences

- The only way to make a page from the dashboard is Duplicate, which copies
  a page that is already there. The browser journey in
  `scripts/verify-page-lifecycle-browser.mjs` no longer presses "New page":
  it posts the `create_page` operation to the revisions route, the same
  application command `foundry.page.create` runs, because a dev server holds
  no MCP connection. It then reloads the list to prove the page is there.
- `pageStartingLayouts` is no longer drawn anywhere in the dashboard. It
  stays in `packages/site-definition` because `foundry.page.create` takes a
  starting layout.
- The Pages screen is the first screen moved onto the shared dashboard
  components from issue #226. Its own `.pages-list-row*` rules were taken
  out of `apps/reference-site/app/dash/dashboard.css`, and any script that
  selected `.pages-list-row` now selects `.dash-row-link`.
- The three state words changed: "On your site", "Changed since you
  published" and "Not on your site yet" became "Published", "Draft changes"
  and "Not published", so the state reads as a column rather than a sentence
  on every row.

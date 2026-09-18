# ADR-0020: The dashboard help control is a keyboard- and touch-reachable toggletip, not a hover tooltip

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The dashboard showed technical terms to the site owner with no explanation:
a bare revision number, "Site Definition `<version>`", a raw connection or
membership status string, a fingerprint. Before this decision no shared help
or tooltip component existed under `apps/reference-site`; each screen that
tried to explain a term used whatever it had at hand — usually a native
`title` attribute, which only a mouse hover reveals. A `title` attribute is
unreachable by keyboard and by touch, and most screen readers do not read it
at all.

This decision resolves
[issue #149](https://github.com/Humber-Foundry/foundry-cms/issues/149).

## Decision

**Add one shared component, `HelpTip` (`apps/reference-site/components/help-tip.tsx`),
and use it only where a technical term cannot be rewritten in plain words.**

The owner's own instruction for this ticket was: rewrite the term first: if
"Copy site ID" is not clear, the fix is usually a clearer label, not a
tooltip. `HelpTip` exists for the remainder — a revision number, a
fingerprint, a receipt code — where the exact value or word has to stay on
screen because support, an agent, or the owner themselves needs to quote it
back.

`HelpTip` is a **toggletip**: a small button next to the term that opens a
short explanation when activated, and stays closed otherwise. It is not a
tooltip in the CSS-hover sense, and it does not use the ARIA `tooltip` role,
because that role's contract (content only for hover or focus, never
touch-only) cannot satisfy "keyboard, screen reader and touch" at once. A
toggletip is a deliberate, explicit open — closer to a small disclosure than
a hover card — which is why it opens on click or Enter/Space and stays open
until the owner closes it or moves on.

### Interaction contract

- **Open:** a click, a tap, or Enter/Space while the button has keyboard
  focus.
- **Close:** Escape, a click or tap outside the control, activating the
  button again, or moving keyboard focus away (Tab past it).
- **Screen reader:** the button's accessible name states the question
  (`aria-label`, e.g. "What's a revision number?"); `aria-expanded` reports
  open/closed; once open, the panel is referenced by `aria-describedby` and
  carries `role="status"`, so its content is announced as it appears.

### Where plain words replace the term instead

- The Overview page's draft banner no longer states a bare revision number
  in prose — "You have unpublished changes" is enough for ordinary editing.
- User roles and access statuses are capitalized display words
  (`Owner`/`Editor`, `Active`/`Suspended`/`Revoked`) instead of the raw
  lowercase values the code uses internally.
- Analytics source status uses a plain-word map ("Working normally",
  "Running behind", ...) instead of the raw `AnalyticsSourceStatus` value.
- The browser tab title on the MCP draft-review redirect page reads "Draft
  review" instead of "MCP draft review" — MCP is not a word the page
  otherwise explains to an owner.

### Where `HelpTip` stays

- The draft status chip in the content editor: the plain-word chip ("Saved",
  "Unsaved changes", ...) stays the primary copy; the exact revision number
  moves from an inert `title` attribute into a `HelpTip`.
- "Published history": one `HelpTip` on the section heading explains what
  Revision, Commit, Content, Build and Approval identify, rather than one
  tooltip per raw identifier in the list.
- A campaign's rendered-email detail: the raw fingerprint is relabelled
  "Content ID" with a `HelpTip` explaining what it proves.
- A form submission's receipt code, with a `HelpTip` explaining what a
  receipt identifies.
- Settings → "Site details": `definitionVersion` and `schemaVersion` moved
  inside the page's existing disclosure (`<details>`), so a raw version
  number is never visible on an ordinary visit to Settings.

## Consequences

- New dashboard copy that needs to explain a term reaches for `HelpTip`
  instead of a native `title` attribute or a CSS `:hover` popover.
- `scripts/verify-dashboard-axe-browser.mjs` now checks every dashboard
  destination for axe-core violations at `critical` or `serious` impact,
  and is wired into `npm run test:browser`. Fixing it surfaced two
  unrelated pre-existing defects this ticket also fixed because they
  blocked "passes on every destination": the rich-text editor's
  contenteditable surface had no ARIA role that permits `aria-invalid` and
  `aria-describedby` (now `role="textbox"` with `aria-multiline`), and the
  Design destination's scrollable preview window had no keyboard access
  (now `tabIndex={0}` with `role="region"`).
- `#150` (Settings: Users, roles and statuses) and `#169` (Connect an AI
  agent screen) build their own help text on this same component instead of
  inventing another tooltip pattern.

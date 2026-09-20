# ADR-0027: Settings reads Users first, and a role change is a D1-only application command

- **Status:** Accepted
- **Date:** 2026-09-19

## Context

Settings showed its sections in the order they were built, not the order an
Owner uses them: Connections, then People, then Connected agents, then the
email-alert and message-storage facts, then Site details. The owner's own
words for this ticket: "the settings and stuff, it's just confusing... I
don't really know what is a member. Just look at how other CMSs handle this.
I think member is the wrong word. User maybe."

Two separate problems follow from that:

1. **The word.** "Member" is the domain's internal word for a human's
   access record (`HumanMembership` in `packages/application/src/human-access.ts`).
   It is not a word a site owner uses about a person on their team, and it
   does not say what the person can do.
2. **The order and the noise.** The page read as one flat list of sections
   with no priority, and technical facts (email-alert delivery health,
   message-storage capacity, retry buttons for a stuck access change) sat in
   the main flow instead of behind a disclosure, competing for attention
   with the tasks an Owner actually does.

A third question came out of the same ticket: an Owner asked for a way to
change an existing user's role (Editor to Owner or back) without revoking and
re-inviting them. ADR-0005 (human authentication and authorization boundary)
already names role change as a first-class D1 operation in its "Changes,
removal and last-Owner safety" section: *"Role changes are transactional D1
operations and do not depend on an Access API call."* ADR-0005's audit list
also already expects it: *"membership activation, suspension, removal **and
role change**."* This decision implements that already-scoped operation; it
does not re-open ADR-0005.

This decision resolves
[issue #150](https://github.com/Humber-Foundry/foundry-cms/issues/150).

## Decision

### The screen says "user," not "member"

Every word a person reads on Settings' access screen now says "user":
the section heading ("Users"), the invite button ("Invite user"), the table
column header ("User"), and the empty/error copy. Roles stay "Owner" and
"Editor" (ADR-0005's names for them). Code identifiers keep "member" and
"membership" — `HumanMembership`, `membershipId`, `member-access-controls.tsx`,
the `/api/foundry-cms/members` route — because renaming a stable identifier
across the domain layer, the API contract and every call site is a large,
unrelated migration with no owner-facing benefit. `CONTEXT.md`'s "Owner-facing
words" section records this split so future dashboard copy stays consistent.

### Page order follows owner tasks, not build order

Settings now reads, top to bottom: **Users**, **Connected agents**,
**Connections**, **Site details**. This is the order of how often and how
directly an Owner acts on each: who can sign in is the most common
Owner-only task; which agents are connected is the next most direct
authorization decision; whether email and publishing are connected is a
status check, not a task; Site details is reference material "you do not
need for ordinary editing" (its own copy already says so).

Everything nobody needs on an ordinary visit — the email-alert delivery
facts, how full message storage is, and the two operator recovery buttons
("Retry access change", "Retry Cloudflare sync") — moves into one collapsed
**"Technical detail"** disclosure at the end of the page, using the same
`<details>`/`<summary>` pattern Site details' own "Version numbers and
published records" disclosure already uses. Nothing in that content is
deleted or made harder to reach; the disclosure just does not compete with
the page's actual tasks by default.

The retry buttons still act on the exact same in-flight mutation (the same
idempotency key and request body) that Users' invite form and table trigger,
so the request state cannot move with them — moving only the buttons while
the state stayed behind would break "retry the same request." Instead
`useHumanAccessMutation` (in `member-access-controls.tsx`) is a hook that
owns that one piece of state, and `HumanAccessMutationScope` calls it once
and hands the result to both `MemberAccessPanel` (the Users table) and
`AccessSyncRetryControls` (the Technical detail buttons) through a render
prop, so the two halves of the same UI stay in different parts of the page
without duplicating the request logic or losing the pending attempt.

### Role change is an application-layer command, D1-only

`HumanAccessApplication.commands.changeRole` is new, alongside `changeStatus`.
It is built to the same shape as `invite` and `changeStatus`:

- **Authorization** — `requireCapability({ capability: "access.manage" })`,
  the same Owner-only check `changeStatus` and `invite` already use.
- **Audit** — the D1 store writes a `membership.role_<role>` row to
  `human_access_audit_events`, matching the existing `membership.<status>`
  naming `changeMembershipStatus` uses.
- **Idempotency** — setting a membership to the role it already holds is a
  harmless no-op: the `UPDATE` still matches the row and returns `changed:
  true`, and the last-Owner trigger's `WHEN` clause only fires when the new
  role or status actually differs, so replaying an unchanged role change
  never raises `last_owner`.
- **No Cloudflare sync** — unlike `invite` and `changeStatus`, `changeRole`
  never calls `synchronizeEligibility()`. The Access allow list is keyed by
  email and current membership status, not by role (see ADR-0005,
  "Access synchronization and client-owned credential"), so a role change
  can never change who is allowed to sign in. Calling the Access API here
  would be a write with no reachable effect. `packages/application/src/human-access.test.ts`
  proves this directly: `replaceExactEmailEligibility` is never called for a
  role change.

**Last-Owner and self-lockout safety reuse the existing DB trigger.** The
`human_memberships_preserve_last_owner` trigger (migration
`0001_human_access.sql`) already fires `BEFORE UPDATE OF role, status`, so it
already protects a role change exactly the way it protects a status change —
no migration change was needed. Because the only membership that can invoke
`changeRole` is an active Owner (the capability check enforces that), and the
trigger blocks demoting the sole active Owner regardless of who issues the
`UPDATE`, "the last active Owner cannot be demoted" and "an Owner cannot lock
themselves out" collapse into the same enforced case: if exactly one Owner is
active, only that Owner can call `changeRole` at all, so any role change that
would remove the last Owner is necessarily that Owner acting on themselves,
and the trigger rejects it. `human-access.test.ts` and
`d1-human-access-store.test.ts` each cover it: promoting an Editor, demoting
one of two active Owners, the sole Owner failing to demote themselves, and a
same-role replay succeeding.

A role change is refused (`membership_transition_not_allowed`) for a revoked
membership — a closed record has no role left to change — and refused
(`membership_not_found`) for a membership id the site does not have.

### A help tip for every role and every status

Each of Owner, Editor, Active, Suspended and Revoked gets one `HelpTip`
(ADR-0020) stating what a person in that role or status can and cannot do,
in `RoleAndStatusHelp` in `member-access-controls.tsx`. The wording is drawn
from the existing capability table (`roleCapabilities` in
`packages/application/src/human-access.ts`) and the existing status-change
confirmation copy (`human-access-mutation-client.ts`), not invented for this
screen.

### `window.confirm` is gone from this page

The status-change confirmation (`membershipStatusConfirmation`, used for
Suspend and Revoke) and the new role-change confirmation
(`roleChangeConfirmation`) both now open through `MemberActionConfirmDialog`,
a native `<dialog>` built the same way the revoke dialog in
`mcp-connection-controls.tsx` already is: `showModal()`/`close()` driven by
React state, `onCancel` wired to the dialog's own `cancel` event so Escape
and clicking the backdrop both close it, and a labelled heading so a screen
reader announces what is being confirmed. `window.confirm` cannot be driven
by the project's browser tests at all, is not stylable, and was the one
place this screen still used it.

### Left for #169

Issue #169 (Connect an AI agent screen) adds one link inside the Connected
agents section, ahead of `McpConnectionControls`. This decision moves that
section's position on the page but does not touch its inner markup, so
either PR merges cleanly regardless of order.

## Consequences

- `HumanAccessStore` gains `changeMembershipRole`, implemented once in
  `in-memory-human-access-store.ts` (tests, and the local dev identity) and
  once in `d1-human-access-store.ts` (production and D1-backed tests). Every
  other `HumanAccessStore` consumer is unaffected because the interface only
  grew a method neither of them previously needed to implement.
- The `/api/foundry-cms/members` route gains a `change_role` command,
  authorized, audited and retried exactly like `change_status`.
- `member-access-controls.tsx` is now three exports
  (`useHumanAccessMutation`, `MemberAccessPanel`, `AccessSyncRetryControls`)
  plus the `HumanAccessMutationScope` wiring component, instead of one
  component that rendered everything in place. Anything that needs the
  Users table or the retry buttons imports the piece it needs.
- `docs/decisions/DECISION-LOG.md` gets a new row; no earlier ADR's decision
  changes.

## Alternatives considered

- **Render the retry buttons where they were, and only reorder the visible
  sections** — rejected because it leaves the exact recovery actions the
  owner asked to de-emphasize sitting in the main flow of the Users section.
- **A React Context instead of a render-prop hook wrapper** — rejected as
  more machinery than two sibling consumers of one small piece of state
  need; a render prop keeps the sharing visible at the one call site
  (`page.tsx`) instead of an implicit provider/consumer pair.
- **Give role change its own Cloudflare sync outbox entry "for consistency"
  with invite and revoke** — rejected because ADR-0005 is explicit that
  Access eligibility is keyed by email, not role; queuing a sync operation
  with no eligibility-set effect would be dead work that could still fail
  and report a false `access_sync_pending` state to the Owner.
- **Rename `HumanMembership` and the `/members` route to "user"** — rejected
  as an unrelated, larger migration; this ticket's scope is what a person
  reads on screen, not the domain's or the API's identifiers.

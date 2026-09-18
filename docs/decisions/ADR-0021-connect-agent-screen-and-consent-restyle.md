# ADR-0021: One connect-agent screen, one scope-phrase source of truth, and a readable consent failure page

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The dashboard had no screen to connect an AI agent. An Owner who wanted to
give Claude or ChatGPT access to their site had no address to copy, no
instructions, and no plain list of what a connected agent could or could not
do. The OAuth consent screen at `/api/foundry-cms/mcp/oauth/authorize`
(`apps/reference-site/src/mcp-http-runtime.ts`) already let an Owner approve a
client and its permissions, but it was unstyled HTML, and a consent
submission that failed validation returned a raw JSON error to a browser a
real client had just opened — the Owner's own hand-over notes on
[issue #169](https://github.com/Humber-Foundry/foundry-cms/issues/169) named
this as a rough edge to fix.

Two separate scope-to-phrase maps also existed: `mcpScopeLabels` in
`packages/application/src/mcp-read.ts` (used only by the consent screen) and
`mcpScopeDisplay`/`mcpScopePhrases` in
`apps/reference-site/src/mcp-connection-display.ts` (used by the dashboard's
Connected agents list, from issue #151). Their wording differed — "Read this
site" against "Read the site", "Publish approved work" against "Publish" — so
the same permission read as two different phrases depending on which screen
an Owner was looking at.

## Decision

### One screen, on its own route under Settings

`apps/reference-site/app/dash/settings/connect-agent/page.tsx` is the new
"Connect an AI agent" screen. It shows:

- this site's real MCP address, built from `FOUNDRY_CANONICAL_ORIGIN`
  (`loadMcpAgentConnectionInfo` in `mcp-dashboard-runtime.ts`), never
  hard-coded, with a copy button;
- a plain notice when that address is not reachable from outside the
  installation's own machine — local development or a private preview —
  because Claude and ChatGPT run in their own cloud and cannot reach it;
- a plain list of what an Owner can allow an agent to do, one sentence per
  scope (`apps/reference-site/src/mcp-agent-capabilities.ts`), grounded in the
  real tool catalog (`docs/mcp/catalog.md`,
  `apps/reference-site/src/mcp-tool-registry.ts`) as it stands today — it does
  not promise page creation, blog creation or photo upload, which are
  separate, unshipped tickets;
- a plain list of what an agent can never do: publish or schedule without an
  exact approval, send to the subscriber list, or see a subscriber's email
  address;
- the published steps for Claude (claude.ai connector and
  `claude mcp add --transport http`) and ChatGPT (Developer mode connector),
  read from each client's own documentation on 18 September 2026 and cited
  (`apps/reference-site/src/mcp-client-instructions.ts`); and
- the same connections list Settings already shows, so a new connection is
  visible here too.

The edit to `app/dash/settings/page.tsx` is one link under Connected agents,
so issue #150's later layout rework has one line to move.

### One scope-phrase source of truth

`mcp-http-runtime.ts` now renders consent permission labels through
`mcpScopeDisplay` from `apps/reference-site/src/mcp-connection-display.ts` —
the same function the dashboard's connections list and the new connect
screen use — instead of the package's own `mcpScopeLabels`. `mcpScopeLabels`
stays exported from `packages/application/src/mcp-read.ts` for compatibility;
nothing in this repository still imports it. `docs/mcp/connection-guide.md`
is reworded to match.

### A failed consent submission shows a page, not JSON

A person's browser posts the consent form. `mcp-http-runtime.ts` now answers
a validation failure on that POST — a bad or altered parameter, a scope that
was not requested, a scope drop a step-up cannot make, a missing sign-in —
with a small readable HTML page (`authorizationProblemPage`), styled with the
same values as the consent screen. This does not loosen any check: every
branch that used to return `jsonResponse({error...}, status)` returns the same
status with a plain-English message instead. The GET path, which a machine
client's own metadata discovery may probe with parameters this server does
not recognize, is unchanged and keeps returning JSON.

### The consent screen is styled inline, not linked to the dashboard's stylesheet

The OAuth consent screen is served by the Worker outside the Next.js app, so
it cannot import `apps/reference-site/app/dash/dashboard.css`. It carries a
small inline `<style>` block that copies the same values — ink, accent,
surface, line, radius, control height — so a change to the dashboard's tokens
has to be copied here too. This is a known duplication; a shared token file
consumable by both the Worker and Next.js build was out of scope for this
ticket.

## Consequences

- An Owner can connect a client with nothing pasted, from one screen, with
  honest client-reachability and client-support wording.
- The consent screen, the connect screen and the Connected agents list show
  the same phrase for the same permission.
- A failed consent submission is now diagnosable by the person looking at it,
  without weakening what is accepted.
- `mcpScopeLabels` in `packages/application` is dead code inside this
  repository. A future cleanup may remove it once no external consumer
  depends on it.
- The consent screen's inline styles must be kept in step with
  `dashboard.css` by hand; nothing currently fails a build if they drift.

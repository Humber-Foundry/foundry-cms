# ADR-0025: A person's decision about a preview is its own record

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amends:** [ADR-0004](ADR-0004-draft-preview-publish-pipeline.md)

## Context

ADR-0004 says an MCP actor may prepare a workspace but cannot create an
approval for itself. The permission matrix says an Owner or an Editor approves
a rendered revision. The MCP contract says `foundry.preview.prepare` returns a
`humanReviewUrl` and an approval status of `pending_human_review`.

Nothing completed that path. `/dash/review/<previewId>` redirected straight to
the canonical preview, which has no Approve control. The only approval in the
product was `approveAndPublish()` behind the editor's Publish disclosure, which
approves and publishes in one act and only ever runs on the person's own draft.
So an agent could prepare a preview and then wait forever: no person could
approve it, and the agent had no way to learn an `approvalId`, which is the one
input `foundry.publication.request` cannot do without.

Two further gaps followed from that. A person had no way to answer "not like
this", and an agent had no way to read such an answer. And the approval table
could not hold either answer: `content_approvals` is append-only, records only
approvals, and has no place for a reason.

## Decision

**A person's decision about one prepared preview is a separate immutable
record, and the agent reads it as the state of that preview.**

### The decision record

The new `mcp_preview_reviews` table holds one row per preview. Its primary key
is the preview id, so one preview carries one decision. Update and delete
triggers make the row immutable, matching `mcp_preview_artifacts` and
`content_approvals`. An approved row points at the approval it created. A
change request holds the reason the person typed. A later draft produces a new
revision and a new preview, and therefore asks the question again.

The approval itself stays exactly where ADR-0004 put it: in
`content_approvals`, created by the same `commands.approve`, recording the
person's membership id in `approvedBy`, and invalidated by any later revision.
The review record does not carry approval authority; it names the approval.

### Approving is a person's act on the exact preview

The review screen renders the change summary, who prepared the draft and what
visitors will see, and carries Approve and Ask for changes. Three rules keep
the act honest:

- Opening the screen records nothing. The screen is a read.
- A decision is a `POST` that carries the person's Cloudflare Access session
  and their mutation token. A `GET` on the route answers `405`. No link,
  prefetch or image tag can record a decision.
- The route reads no bearer token, so an MCP credential reaches no part of it,
  and no MCP tool calls `commands.approve`.

Approve stays off until the person asks for the canonical preview of that exact
revision in the same session. Pressing "Open the preview" opens it in a new tab
and reads the same address from the server; Approve turns on only when the
server still serves that revision. The gate is client state that a server read
backs, which is the pattern the blog scheduling control already uses, and it is
what `previewConfirmed: true` reports. It proves the person asked for the
preview, not that they read it, so it is not the protection the product relies
on. That protection is the server's own and is independent: recording any
decision reloads the preview and refuses unless the stored revision is still
current and still hashes to the artifact the agent prepared.

Approving does not publish. It produces the `approvalId` and nothing else.

### The agent reads the decision as the preview's state

`foundry.publication.status` already answers "what happened to my operation".
It now accepts a preview id as well as a publication id and a schedule id, and
answers `pending_human_review`, `approved` or `changes_requested`. An approved
answer carries `approvalId`; a change request carries `reviewNote`, the reason
the person typed.

Preview ids therefore gain a `preview_` prefix, like `publish_` and
`schedule_`. That tool decides what a caller is authorized against from the
shape of the identifier rather than from whichever scope the caller happens to
hold, so an identifier has to say what it names.

Authority for that read is the draft scopes the exact revision needs — the same
scopes preparing the preview needed — plus ownership: a connection reads only a
preview it prepared. One agent can never read what a person said to another.

`reviewNote` is text a person wrote. Every surface treats it as data: the
dashboard renders it as text, the route strips control characters and caps its
length, and the catalog tells clients not to obey it.

## Alternatives considered

- **Reuse `approveAndPublish()`** — rejected. It approves and publishes in one
  act, which is exactly the boundary ADR-0004 draws. Approval must be able to
  exist without a publication, because the agent performs the publication.
- **Let the approve route reuse the editor's `/api/foundry-cms/publications`
  approve command** — rejected. That command first requires the person to have
  workspace access, and the workspace belongs to the agent. The person's
  authority here is site membership plus `content.write`, not workspace
  ownership.
- **Record the decision by writing to `content_approvals`** — rejected. That
  table is append-only approvals with no reason column, and a change request is
  not an approval.
- **Report the decision through `foundry.preview.prepare`'s replayed output** —
  rejected. Polling for an answer would mean repeating a mutation. A status
  read is a read.
- **A new `foundry.preview.status` tool** — rejected as a second way to ask one
  question. Every other durable operation already reports its state through
  `foundry.publication.status`.
- **A separate approval capability, so only an Owner may approve** — rejected.
  The permission matrix gives Owner and Editor the same authority over site and
  blog content, and this ticket is not the place to change it.

## Consequences

- An agent's path can complete: draft, prepare a preview, wait for a person,
  read the approval id, publish that exact revision.
- A person can say "not like this" in their own words, and the agent can read
  it.
- A draft that changes after approval fails at publication with a named error,
  because the approval's fingerprint no longer matches. Nothing new was needed
  for that; ADR-0004's invalidation rules already cover it, and a test now
  proves it through the MCP path.
- Previews created before this change keep their bare identifiers and cannot be
  read through `foundry.publication.status`. They remain reviewable from the
  dashboard, which addresses a preview by id and not by shape.
- A preview read needs only `site.read` plus the exact revision's draft scopes,
  which is what preparing the preview needed. It does not need a publication
  scope. Tool discovery is unchanged, so `foundry.publication.status` is still
  listed only for connections holding a publication scope; a draft-only
  connection that calls it directly for its own preview is answered.

# ADR-0038: The dashboard shows an app's schedule request, and a person's decline is its own immutable record

- **Status:** Accepted
- **Date:** 2026-09-20
- **Amends:** [ADR-0036](ADR-0036-mcp-blog-post-tools.md)

## Context

ADR-0036 gave `foundry.blog.schedule_request` a place to write to:
`commands.proposeSchedule` saves a `blog_post_schedule_proposals` row and
answers `pending_human_approval`. Nothing read that row back. Overview's
"Needs attention" list did not mention it, the Blog list did not mark the
post, and there was no way to say no to a request without ignoring it
forever.

A person had two ways to make the request stop being pending: schedule the
post (already possible, through the existing schedule controls), or nothing
at all. There was no way to decline a request outright. Issue #219 asks for
both: Overview and the Blog list must show the request, and a person must be
able to decline it as well as approve it.

## Decision

**A pending schedule request is computed from the same rows the schedule
controls already read, and a person's decline is a new immutable record next
to it — never an MCP-writable one.**

### 1. "Pending" is computed, not stored

A post's `pendingScheduleProposal` (a new field on
`BlogPostOperationalSummary`, next to `activeSchedule` and
`latestExecution`) is its newest `blog_post_schedule_proposals` row, unless
an active schedule already exists for the post or a decline record already
answers it. No new state machine was added: scheduling the post through the
existing `ScheduleForm` already clears it, because `activeSchedule` becomes
non-null. Nothing added here changes what a schedule is or how one is made.

Overview and the Blog page both read this one field, through the same
`loadBlogPostOperationalSummaries` helper, so "is this post's request still
pending" is answered in exactly one place.

### 2. Declining is a new, human-only command

`commands.declineScheduleProposal` writes one row to the new
`blog_post_schedule_proposal_declines` table, keyed by the proposal id, with
update and delete triggers that make it immutable — the same shape ADR-0025
gave `mcp_preview_reviews`. It carries no MCP variant: only
`requireHumanContentAuthority` (Owner or Editor) may call it. An agent may
not answer its own request, matching the MCP threat model ADR-0036 already
follows for archive and restore.

Declining does not touch the post, the workspace or any content revision.
It only stops the request from appearing as pending. Declining twice is a
no-op that returns the same record, so a retried request after a lost
response is safe, matching every other command in this file.

### 3. The dashboard never names the connection, only the app

Overview's list and the Blog list's per-post banner both read the app's name
the same way draft review already does (ADR-0025): the registered client's
own address, by joining `mcp_connections` on the stripped `mcp-` actor
prefix in `createdBy`. A proposal a person made directly (the `propose_schedule`
API operation also accepts a human caller, for symmetry with every other
blog command, though nothing in this product calls it that way) is left out
of both lists entirely — issue #219 is about an app's request, not a
person's own.

### 4. The Blog list links straight to the post

Each post's `<li>` in the Blog list now carries `id="blog-post-<id>"`.
Overview's item links to `/dash/blog?workspace=<id>#blog-post-<id>`, so
"open the request" and "answer it with the schedule controls" is one click,
matching the issue's "The item links to the post's schedule controls" line.

## Alternatives considered

- **Let a person's decline just mean "click Schedule with a different time."**
  Rejected. That is not declining; it still creates a schedule. A person who
  wants to say no to a specific time, without picking a new one, had no way
  to do that.
- **Pre-fill the schedule form with the proposal's requested time.** Rejected
  for this ticket. The proposal's `localDateTime` was resolved in the
  requester's own time zone; the schedule form always resolves against the
  browser's zone. Copying the raw digits across zones without conversion
  could silently schedule a different instant than the one shown. The
  banner states the requested time in plain words instead, and the person
  types it into the existing form themselves.
- **Track "declined" as a column on `blog_post_schedule_proposals`.**
  Rejected. That table's own rows are otherwise never updated after insert,
  matching `mcp_preview_artifacts`. A separate table keeps that invariant
  and matches the `mcp_preview_reviews` / `blog_post_schedule_cancellations`
  precedent of "the request stays as it was asked; the answer is its own
  row."
- **A second list on Overview, e.g. "Schedule requests."** Rejected by the
  ticket itself: add to the existing "Needs attention" mechanism rather than
  building a second one.

## Consequences

- `BlogPostOperationalSummary` gained one field. Every caller that builds one
  by hand (tests) needed `pendingScheduleProposal`, so both in-memory-store
  test fixtures in this repository were updated; no production caller builds
  one by hand.
- A new migration, `0034_blog_post_schedule_proposal_declines.sql`, adds the
  decline table and an index on `(site_id, post_id, created_at)` for the
  request lookup Overview and the Blog list both run.
- The MCP surface, its scopes and its tool count are unchanged. Declining is
  reachable only from `/api/foundry-cms/blog-operations`, the same
  human-mutation route every other blog dashboard command already uses.

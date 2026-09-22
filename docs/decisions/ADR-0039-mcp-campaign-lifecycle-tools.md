# ADR-0039: An agent reads where a newsletter stands and can ask for a send time, and only a person ever sends one

- **Status:** Accepted
- **Date:** 2026-09-20
- **Follows:** [ADR-0036](ADR-0036-mcp-blog-post-tools.md),
  [ADR-0038](ADR-0038-blog-schedule-request-visibility-and-decline.md)

## Context

An agent could already write a campaign, read one, ask for a test to the
Owner's own verified addresses, and read whether that test was current
(`foundry.campaign.create`, `edit`, `get`, `request_test`,
`test_readiness`). It could not see the list of campaigns, could not see what
had happened to one, and had no way to say "this one should go out on
Thursday morning".

Issue [#172](https://github.com/Humber-Foundry/foundry-cms/issues/172) asks
for the rest of that lifecycle: `foundry.campaign.list`,
`foundry.campaign.status` and `foundry.campaign.schedule_request`. Slice one
of that issue shipped the photo tools and is recorded in
[ADR-0037](ADR-0037-mcp-photo-tools.md). This record is slice two.

Two product rules bound the whole design, and neither is negotiable.

**An agent never sends a newsletter.** A real send needs a delivered test of
that exact email, the Owner's confirmation that they read the one that
arrived, the Owner's approval of that exact revision, and then the Owner's own
send or schedule. Those steps are human steps by
[#164](https://github.com/Humber-Foundry/foundry-cms/issues/164) and
[#177](https://github.com/Humber-Foundry/foundry-cms/issues/177), and an
Editor cannot even confirm a test — the server grants that to an Owner only.

**No tool returns a subscriber's address or any identity.** Counts only. That
rule already held for campaign drafting and for analytics, and it has to keep
holding for a status read, which is the first campaign tool that looks at what
a send actually did.

## Decision

**An agent reads a campaign's standing as states, times and counts, and asks
for a send time the same way it asks for a blog schedule: it records a
proposal, and a person turns it into a send or declines it.**

### 1. `foundry.campaign.list` and `foundry.campaign.status` read, and grant nothing

Both need `campaign.draft`, the permission that already means "work on
newsletter drafts". Both call the campaign operations that already exist:
`list` calls `queries.listCampaigns`, and `status` reads the campaign through
`queries.getCampaign` and the send state through the same store row the
Newsletter screen reads. Nothing about a campaign's rules is written a second
time in the MCP layer.

`status` reads the stored send rows through the campaign bulk state store
rather than through the bulk delivery application. That application refuses to
build without an email adapter, an artifact publisher, an audience resolver
and a fingerprint key, and its `authorizeRead` admits a human membership,
which an MCP connection never has — the same reason §3 gives for keeping the
request its own small application. The permission that admits this read is the
connection's `campaign.draft`, checked at the tool boundary like every other
campaign tool.

`status` answers through `campaignBulkStateReport`, the one function that
narrows a stored send down to what a screen may know. That function already
existed inside the bulk delivery query; this change lifts it out so the
dashboard and the tool read the same narrowing, rather than two. The tool then
narrows once more: it reports the Owner's approval as a state and a time, never
its fingerprint or the test execution it rests on, and it reports a send as a
state, an attempt number and `recipientCount` — a count of people, never a
person.

### 2. `foundry.campaign.schedule_request` copies the blog request exactly

It needs `publication.schedule`, because that is the permission that means
"ask for something to go out at a time", and it is the permission
`foundry.blog.schedule_request` already needs. No new scope was added, for the
reasons ADR-0036 §8 gives: a new scope means another migration, another consent
line and another thing for an owner to understand, for no added safety.

The permission is pinned to the command in `mcpCampaignOperationScopes`, and is
never read out of the caller's own list. The connection must hold that pinned
permission and every permission the request evaluated, and the evaluated list
may not be empty. The application checks it, and the D1 insert checks it again
through the same `contentAuthoritySql` fragment the blog commands use. Neither
check stands alone.

The connection acts as itself. The request's `createdBy` is the connection's
own actor id with the `mcp-` prefix, never the membership of the person who
granted it, so a request an app made and a request a person made are told
apart afterwards.

The tool answers `state: "pending_human_approval"` and a request id. It
creates no schedule, authorizes nothing and sends nothing, so a client cannot
read the answer as a promise that anything will go out.

### 3. A request is its own small application, not a second campaign engine

`campaign-schedule-proposals.ts` holds the request: its type, its store, and
two commands — `proposeSchedule` and `decline`. It is deliberately small. It
needs the campaign it names and whether a send is already set for that
campaign, and nothing else: no audience, no sender identity, no provider, no
renderer. That is what lets the MCP path build it from a database binding
alone, instead of standing up the whole bulk-delivery application — which
needs an email adapter, an artifact publisher and an audience resolver — just
to write down a proposal.

It shares the campaign schedule's own time rule rather than inventing a
second one: `requireResolvedFutureTime` and the local-time arithmetic behind
it are now exported from `campaign-bulk-delivery.ts`, so a requested time and
a scheduled time are refused for the same reasons.

### 4. "Pending" is computed, and declining is human-only

A campaign's pending request is its newest request row, unless a person has
declined it or a send is already set for that campaign. That is the rule
ADR-0038 §1 fixed for a blog request, applied here in one place — the
application's own `pending` query — so the dashboard and the tool cannot
disagree about what is still waiting.

A campaign whose send is already set has nothing left to ask for, so
`proposeSchedule` refuses one outright with `campaign_send_already_scheduled`
rather than recording a request that would answer `pending_human_approval`
while every screen showed nothing pending. A person who answers a request by
scheduling the send themselves clears it the same way: `activeSchedule`
becomes non-null and the request stops being pending, with nothing declined.

`commands.decline` writes one row to `campaign_schedule_proposal_declines`,
keyed by the request id, with update and delete triggers that make it
immutable. It has no MCP variant: only an active Owner or Editor may call it,
in the application and again in the D1 statement. An agent may not answer its
own request. Declining twice is a no-op that returns the same request, so a
retry after a lost response is safe.

Declining touches nothing else — no campaign, no approval, no send. It only
stops the request asking.

### 5. The Owner sees the request in the two places they already look

Overview's "Needs attention" list gains an item —
`<app> asked to send "<subject>" at <time>` — linking to that campaign on the
Newsletter screen, exactly as ADR-0038 gave a blog request an item there. The
Newsletter screen shows the request on the campaign itself, with a Decline
button next to it and a sentence pointing at the sending steps for the other
answer. Approving is not a new control: it is the existing send and schedule
flow, which still needs the confirmed test and the Owner's approval.

Since #237 the Newsletter screen is the campaign list, and the sending steps
are on the campaign's own screen. The request stays on the campaign's row,
which names the app and the time it asked for, and Decline is the one action
in that row's menu. The row itself opens the email, where sending lives.

Both surfaces name the app, never the connection, reading the registered
client's own address the way draft review does. Both show the time in the zone
the request itself carries, following ADR-0038 §4. A request a person made
directly is left out of both, as it is for the blog.

### 6. Every refusal carries a named reason

`mcp_schedule_authority_required`, `human_authority_required`,
`campaign_not_found`, `campaign_send_already_scheduled`,
`schedule_request_not_found`, `schedule_request_idempotency_key_reused`,
`schedule_request_idempotency_key_invalid`,
`schedule_request_campaign_stale`, `schedule_instant_invalid`,
`iana_time_zone_invalid`, `time_zone_database_version_unavailable`, and the
campaign schedule's own `bulk_schedule_time_invalid` and
`bulk_schedule_time_mismatch` for a time that is malformed, past, or does not
match the zone it claims. A replayed refusal
repeats the first reason, because the reason is derived from the command's own
code rather than from anything the caller sent.

## Consequences

The MCP surface has thirty-five tools. The catalog, the permission matrix, the
conformance manifest and the registry tests all count them.

Building this found a defect that stopped the campaign tools working at all.
`mcp_connection_scopes` still allowed only the five permissions that existed
when migration 0024 was written, so an Owner's consent to `campaign.draft`,
`campaign.test` or `analytics.read` was refused by a CHECK constraint, and the connection store's
canonical scope order did not name those three either. Migration
`0036_mcp_connection_scopes_complete.sql` rebuilds the table's CHECK from
`mcpSupportedScopes`, and the store's order clause now names every supported
permission. Without that fix `foundry.campaign.list` and
`foundry.campaign.status` could never be granted, so it ships here rather than
as a separate ticket.

A new migration, `0035_campaign_schedule_proposals.sql`, adds
`campaign_schedule_proposals` and `campaign_schedule_proposal_declines`, both
immutable by trigger, with an index on `(site_id, campaign_id, created_at)`
for the lookup Overview and the Newsletter screen both run.

The consent screen's `publication.schedule` sentence now also says the agent
can ask you to send a newsletter at a time it suggests, and the
`campaign.draft` sentence says it can read where a campaign has got to. Both
still say it cannot send. The "it can never" list is unchanged and still true:
no permission allows sending to more than the Owner's own test addresses, and
no tool ever sees a subscriber's address.

The campaigns API gained one human-only action,
`decline_schedule_request`, on the same route every other newsletter
dashboard command already uses. It is allowed while email delivery is not
connected and while the sender details are unset, because saying no to a
request sends nothing and a person may need it exactly when delivery has
stopped working.

## Alternatives considered

**Give the agent `foundry.campaign.schedule`, gated on an existing Owner
approval, mirroring `foundry.publication.schedule`.** Rejected. A blog
publication's approval is an approval of a draft a person reviewed in the
dashboard. A campaign's approval is an Owner's statement that they read a test
email that arrived in their own inbox. Letting an agent spend that statement
would make the send an agent's action in the audit trail, and the whole point
of #164 and #177 is that the send is the Owner's.

**Pin the request to `campaign.draft` instead of `publication.schedule`.**
Rejected. `campaign.draft` means "prepare a newsletter draft for review".
Asking for a time to send is not preparing a draft, and an owner who granted
only drafting should not find the app asking for send times. The permission
that already means "ask for a time" is `publication.schedule`.

**Put `proposeSchedule` on the bulk delivery application, next to
`activateSchedule`.** Rejected. That application refuses to build without an
email adapter, an artifact publisher, an audience resolver and a fingerprint
key. The MCP path would have had to stand all of that up to write down a
proposal, duplicating the dashboard's own wiring for a command that reads none
of it. A small application with a small store keeps the request's cost
proportional to what it does.

**Report a campaign's send detail and its approval fingerprint in
`status`.** Rejected. `detail` is provider text this product does not control,
and a fingerprint is the thing an approval is checked against. Neither helps an
agent decide anything, and both widen what a compromised client can read.
States, times and one count answer the question an agent actually has: can this
go out yet, and has it.

**Let an agent decline or cancel its own request.** Rejected, for the same
reason ADR-0038 §2 gives: an agent may not answer its own request. A person
either sends the campaign or declines the request; an agent that changed its
mind can ask again with a new key.

# ADR-0006: Bulk campaign execution boundary

- **Status:** Accepted
- **Date:** 2026-07-30
- **Amends:** [ADR-0002](ADR-0002-default-newsletter-delivery-adapter.md) for
  bulk delivery only. Test delivery, ownership boundary, event ingestion and
  export remain exactly as ADR-0002 states them.

## Context

[ADR-0002](ADR-0002-default-newsletter-delivery-adapter.md) chose Brevo and
fixed the test-delivery contract precisely, but described bulk delivery in terms
of a **Brevo campaign** and a **provider draft fingerprint**: "Before scheduling
a bulk campaign, the adapter verifies that the approved Foundry artifact matches
the Brevo draft fingerprint," and Brevo is "operationally authoritative for …
actual queueing, sending, cancellation, and completion after a Brevo campaign is
created."

Brevo's email-campaign resource addresses **its own contact lists**. Using it
would make every eligible subscriber a synchronized Brevo contact and would make
a provider-side list the effective audience, which contradicts three commitments
Foundry has already made:

- `CONTEXT.md` — an **audience definition** "contains no frozen addresses" and an
  **audience snapshot** is "resolved for one execution … identified and counted
  in the CMS."
- ADR-0002's own ownership boundary — Foundry is authoritative for the "audience
  definition" and for "logical send operations, idempotency keys, provider
  mappings."
- ADR-0002's portability requirement — the default "must not make provider state
  or provider-only consent records a prerequisite for changing providers later."

[The lifecycle model](../domain/blog-newsletter-publishing-lifecycle.md) already
allows for this: "The adapter **may** create or update a provider draft while
preparing a bulk send, but it does not make that draft authoritative."

Issue #52 had to resolve this before it could execute a bulk send at all.

## Decision

### Bulk delivery uses the transactional batch endpoint, not a Brevo campaign

One logical send operation is one `POST /v3/smtp/email` request carrying
`messageVersions`, with **exactly one version per recipient** and no outer `to`.
Brevo rejects an outer `to` alongside `messageVersions`, and a shared `to` would
place every subscriber's address in the delivered header of every message. This
is the same inline-content, explicit-recipient shape ADR-0002 already requires
of a test delivery, applied to the resolved audience snapshot.

Consequences accepted:

- No Brevo contact list, provider draft or provider-side audience exists, so no
  subscriber identity leaves Foundry except as a recipient of their own message.
- **`PROVIDER_DRIFT` has no draft to compare.** The equivalent gate is a
  configuration-drift gate: before writing, the adapter recomputes the sender
  and provider-configuration fingerprints from live configuration and refuses a
  request whose artifact disagrees (`provider_campaign_fingerprint_mismatch`).
  Content drift is already impossible, because the artifact's content
  fingerprints are bound to the authorization.
- **One send operation is capped at Brevo's documented 1000-version maximum.**
  An audience above it is refused before any Git commit or provider write
  (`bulk_audience_capacity_exceeded`). Batching one logical send across several
  provider requests would create more than one thing to reconcile, so it is
  deliberately not attempted in v1.
- **Provider-side cancellation has nothing to cancel.** A schedule can only be
  cancelled while it is still `active`, and a provider request is only made after
  a schedule is `claimed`, so `cancellation_uncertain` cannot arise. Attempting
  to cancel a claimed schedule is refused with
  `bulk_schedule_not_cancellable`, which is this model's
  `TOO_LATE_TO_CANCEL`.

### One execution lease, held by whoever can present its token

A live lease can only be claimed by a caller that presents its token. Reading
the operation row is never enough, because a second executor could read the
same live token and reach the provider alongside the holder — the one outcome a
lease exists to prevent. The scheduler presents the lease its claim gave it; an
Owner's retry mints a fresh one and therefore has to wait for an expired lease.

An attempt that ends before any provider request hands its lease back, so a
refused preparation does not make the Owner wait out an expiry for nothing.

### Only an attempted message is evidence a recipient was reached

A send becomes `sent` on authenticated webhook coverage of every recipient, but
only events that prove the provider actually attempted the message count.
A bounce, complaint or unsubscribe still proves the message was sent. `blocked`,
`invalid` and `provider_error` prove the opposite, so a campaign the provider
refused for every recipient is never reported as sent.

### Recording an event applies its suppression

`ingestVerifiedEvent` applies the negative subscriber state a delivery event
implies, and only on the first record of that event, so a webhook retry cannot
append the same suppression twice. Callers cannot forget to suppress, and
`applyProviderSuppression` is a required dependency rather than an optional one
that would silently drop every unsubscribe if omitted.

An authenticated webhook and a polled report describe the same fact under
different identities, because polling cannot present a pre-send proof. Each
channel therefore records its own evidence and its own suppression. The
subscriber's negative state is the same either way, and a negative state is
never reversed.

### An empty tagged report is the absence proof, after a lag allowance

The lifecycle's retry rule permits sending again only when "the adapter proves no
queue/send exists." Brevo records a `request` event on acceptance, so a readable
tag-filtered report containing no event at all for an operation is that proof —
but only once reporting lag has had time to clear. The adapter therefore
receives the instant the provider attempt was opened and reports absence only
after a documented lag allowance has passed; before that the outcome stays
uncertain and no second send happens.

Without this, an uncertain send would be permanently uncertain: the adapter could
only ever answer "verified" or "ambiguous", so a request that genuinely never
reached Brevo could never be retried.

The report is read page by page to its end. Exact recipient-set agreement is only
meaningful over a complete report, and one recipient produces several events, so
a truncated read is reported as incomplete rather than allowed to conclude.

### A failed send is retried by its Owner, never automatically

The lifecycle says a failed send must "retain operation, audience snapshot, Git
commit and retry/reconcile actions" and shows the retry as an Owner action. So
`retry_bulk_send` re-runs one existing operation on the Owner's explicit
instruction, reusing its identity, snapshot and committed artifact and
reconciling before it will send again. Routine scheduler reconciliation
deliberately does not pick up a definitely failed send: a definite provider
rejection needs a human to look at it, exactly as a missed schedule does.

### A completed send keeps being polled inside a reporting window

A send that reached `sent` is never sent again, but its report is still read for a
bounded window so an unsubscribe, complaint or bounce whose webhook was lost
still reaches the suppression ledger. This is the backstop ADR-0002 asks for:
"Polling is also a reconciliation backstop." Nothing about a completed send's
state changes; only compliance facts are ingested.

### Reconciliation verifies reach, not content

Reconciliation reads the tag-filtered event report, and requires exact sender
agreement, exact recipient-set agreement, and one distinct provider message
identifier per recipient — which is what one message version per recipient must
produce. It does **not** re-fetch each recipient's stored message and compare
bytes.

Per-recipient content re-fetch would cost two provider requests per recipient,
so a large send would exhaust the runtime's subrequest budget part-way through
and strand itself — and it would prove nothing new: the authorization
fingerprint binds the content, and the test delivery for that same fingerprint
already proved the rendered bytes at the provider. Reconciliation's question is
the one the lifecycle retry rule asks: "retry only when the adapter proves no
queue/send exists."

A send still becomes `sent` only on authenticated webhook evidence covering
every recipient in the snapshot, exactly as before. Polling remains what
ADR-0002 calls it: something that "only enriches or contradicts the durable
webhook evidence."

### The correlation key is derived, and persisted before the first write

A bulk operation's provider correlation key is a pure function of the operation
identity (`brevo-bulk-<operationId>`), so the sending adapter, the webhook and
report polling agree without consulting stored state. It is written durably in
the same statement that opens the provider attempt, before the provider request
is made, so a delivery event that arrives while that request is still in flight
already correlates to its operation instead of failing as unmatched.

### An audience snapshot is immutable from the first attempt, not from resolution

The snapshot and the Git-committed artifact become immutable when a provider
attempt opens. Until then, a negative subscriber state observed after the
previous resolution removes that recipient and the operation re-resolves,
commits a replacement artifact and proceeds.

Freezing at resolution instead would let a single unsubscribe between resolution
and dispatch strand the campaign permanently: the snapshot could not be
replaced, a second send operation is forbidden by the one-operation-per-campaign
constraint, and the authorization is bound to that campaign. The lifecycle's
acceptance test 19 asks for the opposite outcome — "the address is excluded and
the negative state is preserved."

The superseded artifact commit is never rewritten; a replacement is a new commit,
so Git history stays append-only.

### Bulk authority stays bound to the Owner who confirmed the test

An authorization records that **one** named Owner reviewed the delivered test.
Activating, cancelling or sending against it requires that same Owner. Another
Owner may authorize the campaign themselves, which is one confirmed test review
away, and an Owner who is removed or demoted has their authorization invalidated
by a durable guard.

This is narrower than the permission matrix's role-level "Activate/cancel
campaign schedule | Owner | Yes". The narrower rule is chosen because it cannot
produce an unsafe send, only a recoverable re-authorization, and because the
value of a bulk-send authorization is precisely that a specific human saw the
message that will go out.

### Every refusal names its own next action

The three ways test evidence can fail to support an authorization are separate
reason codes, because their next actions differ: `bulk_test_required` (run a
test), `bulk_test_not_reviewed` (confirm the delivered test), `bulk_test_stale`
(retest the current revision). A non-Owner attempt reports
`bulk_owner_required` rather than only that it was refused. Durable guard
rejections are translated to the same stable reason codes rather than surfacing
as unexplained failures.

## Consequences

- Bulk delivery needs no Brevo contact synchronization, so a provider change
  moves only the adapter.
- v1 sends one campaign to at most 1000 recipients. A larger audience is a
  visible refusal, not a partial send.
- Reconciliation costs one paged report read rather than two requests per
  recipient. The page budget bounds it, so a completed send whose engagement
  events outgrow that budget stops being polled for the rest of its reporting
  window; its authenticated webhooks remain the primary path, and the outcome
  fails safe by never resending and never claiming reach it has not seen.
- ADR-0002's Brevo-campaign language no longer describes the implementation for
  bulk delivery. Reopen this decision if Foundry later needs provider-side
  scheduling, provider-side cancellation, or audiences beyond one request.

## Alternatives considered

- **Brevo email campaigns with synchronized contact lists** — rejected because it
  makes a provider-side list the effective audience and makes provider state a
  prerequisite for changing providers, both of which ADR-0002 forbids.
- **Batching one logical send across several provider requests** — rejected for
  v1 because a partially accepted batch creates more than one uncertain outcome
  per send operation, which is exactly what the stable-send-identity rule exists
  to prevent.
- **Keeping per-recipient content re-verification** — rejected because it cannot
  complete within the runtime's subrequest budget for a realistic audience and
  proves nothing the authorization fingerprint and the test delivery have not
  already proven.
- **Freezing the audience snapshot at resolution** — rejected because one
  unsubscribe during dispatch would permanently strand the campaign.
- **Letting any Owner act on another Owner's authorization** — rejected because
  the authorization's whole value is that a named human reviewed the exact
  message being sent.

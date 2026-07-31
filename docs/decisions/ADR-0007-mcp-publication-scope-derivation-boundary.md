# ADR-0007: MCP publication scope derivation and enforcement boundary

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

A scoped MCP agent may request immediate publication or blog scheduling for a
revision a human already approved. `publication.publish` and
`publication.schedule` are not sufficient on their own: the production contract
in [authorization, approval and audit](../mcp/authorization-and-approval.md)
also requires the exact draft scopes the server derives from revision 0 and the
approved revision, and states that caller-supplied scope lists are not the
authority source.

That leaves an open question this decision resolves: which layer derives the
required scope set, and which layer enforces it.

Two layers could plausibly do both:

- The MCP application layer holds the authenticated connection principal, the
  revision repository and the domain rule that classifies an editable-field
  change as content or design.
- The D1 adapters own the atomic statement that commits a publication claim,
  schedule or cancellation receipt, which is the last point before any external
  Git or Cloudflare write.

An earlier implementation of
[issue #56](https://github.com/Humber-Foundry/foundry-cms/issues/56) attempted
both: each D1 adapter re-read revision 0 and the approved revision, re-ran the
editable-field diff, and replaced the scope set the application layer had
supplied. Two defects followed directly from putting that derivation in an
adapter, and both were reproduced against the real store before this decision
was recorded.

The scope required when a revision changes no editable field is a fallback, and
the domain rule picks that fallback from the calling principal's own granted
scopes — `design.draft` for a design-scoped connection, otherwise
`content.draft`. An adapter does not receive the principal, so it cannot
reproduce the rule. Both adapters hardcoded `content.draft` and therefore
rejected a legitimate design-scoped publication with
`publication_authority_not_current`. An adapter could only recover the rule by
reading the caller's granted scopes back out of D1, which would make the check
restate the caller's authority instead of constraining it.

The publication-store copy also hardcoded `publication.publish`, while the
publication kind is a property of the operation: a scheduled publication claim
arrives with a reservation proof and the `foundry.publication.schedule`
operation. That copy would have blocked every scheduled publication claim.

Removing the adapter derivation exposed a separate, pre-existing gap. The
publication claim statement checked only the scope list it was handed, so the
publication scope implied by the operation was not enforced independently of
that list. A connection holding `content.draft` and no publication scope at all
was admitted and its publication row claimed.

## Decision

Derive the required scope set in exactly one place, and enforce it atomically in
exactly one place.

### The MCP application layer derives

`packages/application/src/mcp-publications.ts` resolves the exact revision,
compares it against revision 0, classifies the changed editable fields through
the shared domain rule, and combines the resulting draft scopes with the
publication scope for the requested operation. It holds the connection
principal, so it is the only layer that can apply the fallback rule. It then
verifies the principal holds every derived scope and revalidates the live D1
grant before the command proceeds.

No adapter re-derives that set, and no adapter parses a `SiteDefinition` to
classify a change. Adapters receive the derived set and persist it verbatim, so
a schedule's stored authority still carries the complete set for execution-time
revalidation.

### The store enforces atomically

The D1 statement that commits a claim, schedule or cancellation receipt remains
the enforcement point, in the same transaction as the linked MCP audit row and
before any external write. In that statement:

- the connection must be active and bound to the operation's site;
- the operation kind must match the presence of a reservation proof;
- the scope implied by that operation kind — `publication.publish` for an
  immediate request, `publication.schedule` for a scheduled one — must be
  granted, checked against the operation rather than the supplied list; and
- every scope in the supplied list must also be granted.

The last two are deliberately redundant. The operation-derived check means a
narrowed or empty list cannot admit a connection that was never granted
publication authority, so the store never depends on the caller's list for the
authority that defines the command. The list check adds the draft scopes only
the application layer can compute.

### Audit evidence stays with the layer that owns the result

An adapter does not reproduce the MCP tool result envelope to compute an audit
`result_hash`. The operation identity is only known once the claim is built, so
a precomputed hash is impossible; instead the linked audit carries a
caller-supplied deriver that the store invokes with the outcome it is about to
commit.

That hash covers the outcome as admitted, not the state the command finally
reaches. `mcp_audit_events` rows are append-only, and the linked row commits
inside the claim transaction — before the Git commit and release verification
that produce the terminal state — so it cannot record a state that does not
exist yet. The application layer records the same invocation afterwards and
that insert no-ops on the existing row, which keeps the row committed with the
claim authoritative. A replay of the same key is a distinct invocation and
records its own row carrying the state it observed.

An audit row therefore proves which operation was admitted, under which scopes,
against which approval. It is not a receipt of the terminal publication state;
the publication's own status and history carry that.

## Consequences

Scope derivation has one implementation and one set of tests, and cannot drift
between two adapters. A design-scoped connection can publish a design-only
revision, and a scheduled publication claim is admitted under the schedule
scope.

The store no longer detects a caller that supplies a scope set narrower than
the change warrants, beyond the operation's own publication scope. That
narrowing is not reachable from a tool argument — the publication tools expose
no scope input — so the residual risk is an application-layer defect, which is
covered by tests at the layer that derives.

Anyone adding a publication or scheduling path must derive scopes in the MCP
application layer and extend the store's atomic statement to enforce them. A
future adapter-level re-derivation would reintroduce both defects above; the
tests named for the design-scoped and omitted-publication-scope cases fail if
it does.

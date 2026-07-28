# Publication reconciliation and restore

Issue #39 extends the exact-revision publication transaction documented in
[Exact revision approval and publication](exact-revision-publication.md).

## Durable history

The dashboard reads a bounded, newest-first publication history from D1. Each
entry contains the immutable approval fingerprint, the publication operation,
and its ordered append-only status events. A commit SHA or successful build is
shown as evidence, never relabelled as proof that the release is live.
`verified-live` remains the only live state and still requires two exact,
uncached release-marker reads.

History reads are side-effect free. Reconciliation and deployment retries
remain protected human POST mutations so loading the dashboard cannot repeat a
Git, Cloudflare, or D1 write.

## Restore boundary

Only an active Owner or Editor can restore a history entry, and only a
`verified-live` publication with a recorded commit is eligible. Restore reads
`packages/site-definition/src/published-site.json` from that immutable Git
commit. Before creating a draft, Foundry verifies all of the following against
the retained approval:

- the exact serialized-byte hash;
- the canonical Site Definition content hash;
- canonical serialization with one trailing newline; and
- the schema version.

The restored definition initializes a new D1 workspace whose production base
is the currently serving release, not the historical commit. It is unpublished
revision `0`, attributed to the restoring actor. It receives no approval and
does not contact GitHub or Cloudflare. Publishing it therefore requires the
ordinary canonical preview, human approval, production-base checks, one new
commit, build reconciliation, and exact release verification. Git history is
never reset, force-pushed, or otherwise rewritten.

The target workspace ID is derived from the authenticated actor and the
protected mutation's idempotency key. D1 workspace initialization is
insert-if-absent, so a lost response after commit and a retry converge on the
same workspace and revision instead of copying the historical release twice.

## Fault boundaries

The deterministic application and adapter suites exercise uncertainty on both
sides of the material boundaries:

- D1 claim/transition compare-and-swap and response-loss-safe restored
  workspace initialization;
- Git commit creation and non-force reference update reconciliation;
- Cloudflare build-request dispatch and ambiguous response recovery; and
- exact release-marker verification, delayed visibility, and repeated
  refresh.

Every retry keeps the original logical publication, candidate commit, build
dispatch identity, or restored workspace identity. A later observation may
advance its evidence, but cannot create a second logical operation or erase a
recorded commit.

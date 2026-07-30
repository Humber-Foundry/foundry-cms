# ADR-0002: Default newsletter-delivery adapter

- **Status:** Accepted
- **Date:** 2026-07-26
- **Amended:** 2026-07-26 by the
  [guided provisioning design](../architecture/guided-client-provisioning.md)
  for issue #20

## Context

Foundry CMS needs an external newsletter provider to execute delivery while the
CMS remains the client-owned authoring, approval, scheduling-intent, consent,
suppression, and reporting surface.

The default must support CMS-rendered campaigns, safe test delivery, scheduling,
subscriber synchronization, compliance-critical events, aggregate analytics,
and practical export. It must not make provider state or provider-only consent
records a prerequisite for changing providers later.

This decision uses the evidence and acceptance test in
[`03-newsletter-delivery-providers.md`](../research/03-newsletter-delivery-providers.md)
and resolves [issue #5](https://github.com/Galen-Humber-Foundry/foundry-cms/issues/5).

## Decision

Use **Brevo** as the default v1 implementation of the
`NewsletterDeliveryAdapter`.

The choice is accepted at the architecture level. Production readiness remains
gated by the live provider acceptance test described below.

### Connection and client ownership

- A client-owned Brevo account, sending domain, sender identities, lists, and
  API credentials are required for every production installation.
- A client creates the API key and stores it only in client-owned Worker
  secrets. Humber Foundry may administer setup but does not own the account or
  credential authority.
- Client-created API keys are an acceptable v1 connection model. Public OAuth is
  not a v1 requirement.
- The CMS exposes credential health and supports a documented rotation and
  revocation procedure. Provider secrets never enter CMS content, logs, exports,
  or source control.

### Ownership boundary

Foundry CMS is authoritative for:

- Stable subscriber identity and normalized profile data.
- Consent evidence, including legal basis, scope, disclosure version,
  collection surface, time, and available source evidence.
- Append-only suppression history and evidenced resubscription.
- Campaign source, rendered HTML and text, audience definition, approval,
  content fingerprint, scheduling intent, and revision history.
- Logical send operations, idempotency keys, provider mappings, normalized
  state, aggregate reporting snapshots, and provider-neutral exports.

Brevo is operationally authoritative for:

- Its unsubscribe-link results, complaints, bounce classifications, and
  provider-side suppression.
- Actual queueing, sending, cancellation, and completion after a Brevo campaign
  is created.
- Brevo campaign/message identifiers and raw report values.

A negative state always wins. An unsubscribe, complaint, hard bounce, erasure,
or administrative suppression received through either surface blocks future
sends locally. Routine reconciliation or subscriber upsert must never reactivate
a suppressed subscriber. Resubscription is a separate command that requires new
evidence.

### Campaign and test delivery

- Foundry sends fully rendered HTML and plain text where supported and stores
  the exact approved artifacts and fingerprints.
- Brevo templates may provide an optional delivery wrapper but never become the
  canonical campaign editor.
- Before scheduling a bulk campaign, the adapter verifies that the approved
  Foundry artifact matches the Brevo draft fingerprint. Drift blocks the send.
- Test delivery uses Brevo's transactional-email endpoint with inline Foundry
  HTML, the verified sender address and display name, the exact subject and
  explicit recipients in one provider request. The delivery binding includes
  the selected sender's exact ID, address and display name. It does not read
  and then send a mutable provider draft.
- Foundry persists an installation-keyed proof of the exact test binding before
  the provider request. It accepts the direct result only when Brevo returns
  HTTP 201 and a message ID; an uncertain response remains ambiguous.
- Ambiguous transactional writes reconcile through Brevo's
  authenticated
  [transactional webhook](https://developers.brevo.com/docs/transactional-webhooks),
  [tag-filtered event report](https://developers.brevo.com/reference/get-email-event-report),
  [message lookup](https://developers.brevo.com/reference/get-transac-emails-list)
  and
  [sent-content lookup](https://developers.brevo.com/reference/get-transac-email-content).
  The webhook must carry Brevo's configured bearer authorization, the exact
  execution tag, pre-send proof, provider message ID and recipient. Foundry
  stores only an installation-keyed recipient fingerprint. Polling cannot
  authenticate Foundry origin by itself; it only enriches or contradicts the
  durable webhook evidence. Acceptance requires exact sender, recipient-set,
  subject and actual HTML agreement with that proof. Missing or partial
  evidence remains ambiguous. A replacement request is permitted only after
  tagged events prove
  terminal non-delivery for every exact recipient and no delivery-derived
  event such as delivery, open, click, complaint, proxy open, or unsubscribe.
- The Brevo callback is exposed only at
  `/api/integrations/brevo/webhooks/transactional`. It remains outside the
  human Cloudflare Access application so Brevo can reach it, but exact bearer
  verification happens before payload parsing or database access. The bearer
  is not accepted by any human CMS route.
- Scheduling, cancellation, and rescheduling use stored UTC intent, provider
  identifiers, and idempotency records. An accepted API response alone does not
  prove that a campaign was sent.

### Event ingestion and analytics

- Unsubscribe, complaint, and hard-bounce events must be ingested promptly
  through verified webhooks and applied to local suppression before routine
  reconciliation.
- Webhook processing verifies authenticity, acknowledges quickly, deduplicates,
  and tolerates retry and out-of-order delivery. Brevo's integer `id` identifies
  the webhook configuration, not an individual event, so Foundry does not use
  it as event identity. The retry identity is a canonical fingerprint of the
  site, provider, execution ID, pre-send proof, provider message ID,
  installation-keyed recipient fingerprint, event type, and provider event
  timestamp. Locally observed receipt time is evidence metadata and is never
  part of retry identity.
- Delivery, open, and click data may be ingested through webhooks or provider
  report polling. Polling is also a reconciliation backstop for campaign and
  subscriber state.
- Foundry stores provider metric definitions and retrieval times with aggregate
  snapshots. It does not promise exact cross-provider comparability for open or
  click metrics.
- Webhook disablement, report lag, quota exhaustion, credential failure, and
  sender/domain verification failure are visible health conditions in the CMS.

### Portability and replacement

- At least daily, Foundry retains a provider-neutral snapshot containing all
  subscriber states, consent and suppression records, campaign artifacts,
  schedules, provider mappings, aggregate reports, cursors, counts, hashes, and
  known omissions.
- Export verification compares state counts and campaign fingerprints with the
  provider API. A provider-side export is supplemental and is not the canonical
  consent record.
- Migration follows the exit runbook in the provider research. Negative states
  remain suppressed, stable Foundry identifiers do not change, future schedules
  are accounted for, and duplicate delivery from old and new providers is
  prevented.

The provider choice must be reopened if Brevo:

- Fails a mandatory acceptance test.
- Removes or materially degrades CMS-supplied HTML, API test-send, scheduling,
  cancellation, compliance-critical events, reporting, or export.
- Prevents client ownership or practical credential rotation.
- Cannot reconcile subscriber states or preserve suppressions during migration.
- Develops a sustained security, reliability, support, or pricing problem that
  makes the intended client tier impractical.

### Production-readiness gate

Before the first production send, run the site-specific portions of the
twelve-step provider acceptance test from the research in the new client-owned
account at the intended tier. Record evidence for credential rotation,
subscriber lifecycle and suppression, campaign fingerprints, test delivery,
timezone scheduling, event coverage, analytics reconciliation, quota
behaviour, export fidelity and account handoff.

This decision amends the original per-client interpretation of the
second-adapter migration step. Each installation must produce and verify a
provider-neutral export/import artifact against its own data model. A Foundry
release may claim second-adapter portability only when its signed conformance
evidence demonstrates a live source-to-destination migration using the exact
pinned adapter versions in controlled accounts at representative intended
tiers. Provisioning verifies that evidence's signature, release digest,
adapter versions, age and mandatory outcomes. The evidence expires on either
adapter's material API/capability change and must then be regenerated before
any client can pass the gate. An individual client is not required to purchase
or provision an otherwise unused second provider account.

Production use is blocked if Brevo cannot perform the mandatory subscriber,
campaign, test-send, scheduling, event/reconciliation, export, and migration
steps. A failed mandatory test reopens this ADR rather than creating a hidden
manual workaround.

## Consequences

- Brevo offers the strongest documented fit among the researched providers for
  inline CMS HTML, API test delivery, scheduling, marketing webhooks, aggregate
  reporting, subscriber export, and an affordable entry tier.
- Each installation requires a client administrator to create and rotate an API
  key because Brevo's current OAuth model is not public across unrelated client
  organizations.
- Live second-adapter migration remains a release gate, while each client site
  proves its own provider-neutral export/import boundary without requiring an
  unused second provider account.
- Foundry must implement and operate its own durable consent and suppression
  ledger; provider contacts alone are insufficient evidence.
- Daily snapshots and reconciliation add operational work but make provider
  replacement testable before an emergency.
- Engagement event ingestion may differ by adapter while compliance-critical
  suppression behaviour remains consistent.
- The accepted provider is not automatically production-ready. Live account
  evidence is an explicit release gate.

## Alternatives considered

- **Mailchimp** — strongest one-shot account export and mature third-party OAuth,
  but scheduling requires a paid tier and retained non-subscribed or
  unsubscribed contacts affect paid contact counts. It remains the leading
  fallback where public OAuth or whole-account export outweighs cost.
- **Buttondown** — compact API-first campaign and event model with dedicated
  test sending, but no documented public OAuth or Mailchimp-style whole-account
  export. It remains a plausible specialist adapter.
- **MailerLite** — strong subscriber lifecycle and signed webhooks, but its
  current public API lacks a dedicated campaign test-send and gates API sending
  and inline HTML by plan.
- **Kit** — capable subscriber and broadcast APIs, but lacks a documented
  dedicated API test-send and complete campaign delivery-event surface, while
  current API eligibility by tier remains unclear.
- **Require public OAuth for v1** — rejected because isolated, client-owned
  deployments can safely use client-created, rotatable API keys and the
  requirement would exclude the best documented capability fit.
- **Make Brevo authoritative for consent** — rejected because provider records
  do not preserve all evidence or history needed for portable Canadian
  anti-spam compliance.

# Brevo test-delivery readiness

Foundry implements and verifies the newsletter test-delivery path without a
production client credential. A client-owned Brevo account becomes
test-delivery-ready through the owner-assisted ceremony below. An evaluation
account can exercise the same path while remaining explicitly
`evaluation_only`.

## Configuration

Install these values in the client-owned Worker configuration:

- `FOUNDRY_BREVO_API_KEY` — a client-created Worker secret with the narrow
  Brevo authority required by the newsletter adapter.
- `FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT` — a 64-character one-way account
  binding produced by provisioning. The raw Brevo account identifier stays out
  of source and application evidence.
- `FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON` — protected provisioning evidence
  containing the ownership classification, a stable evidence ID, the exact
  account-scope fingerprint, and its verification timestamp. If it is absent,
  the runtime classifies the account as `evaluation` and cannot report ready.
- `FOUNDRY_BREVO_SENDER_IDS_JSON` — a protected mapping from Foundry logical
  sender identity to verified Brevo numeric sender ID.
- `FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON` — a protected mapping from configured
  Owner recipient identity to verified delivery address.

The runtime derives the provider-configuration fingerprint from the account
scope, sender mapping, and pinned adapter version. Recipient addresses pass
directly to Brevo for the explicit test request and are absent from operation
rows, evidence, API results, logs, and source control.

## Owner-assisted ceremony

1. Install the provisioning evidence produced by the account-ownership
   workflow. Application callers cannot assert account ownership.
2. Install the API key through the client-owned secret surface and install the
   three protected, non-secret configuration values.
3. Run the adapter health check. It verifies API access and every configured
   sender through Brevo account and sender reads.
4. Create or select the exact campaign revision in Foundry and request a test
   for configured recipient identities. The application API accepts identity
   keys, not email addresses.
5. Confirm the delivered message in the Owner's mailbox. An authenticated
   Owner records confirmation with `confirm_test_receipt` and the stable
   execution ID; the immutable confirmation and its accepted command receipt
   are persisted in D1. Reusing its request key with another execution is
   rejected and confirmation audits contain no recipient address.
6. Evaluate test-delivery readiness with the successful current test evidence.
   `ready`
   requires healthy credentials and sender identity, `client_owned`
   classification, an exact provider-configuration fingerprint match, and the
   Owner's receipt confirmation. This result is test-delivery evidence, not a
   production-readiness declaration.

Every logical test creates a fresh Brevo draft tagged with its stable execution
identity. Foundry reconciles Brevo's `testSent` state and the exact draft
content before accepting evidence. A timeout or lost response enters
reconciliation before another provider write. An expired in-flight writer
remains reconciliation-only so a slow first call cannot race a replacement
call. Automatic retry is possible only after the adapter has returned an
ambiguous result and a later reconciliation definitively proves the prior
draft or test is absent. A crashed call enters a one-minute reconciliation
quarantine after the provider request's 30-second deadline; Foundry blocks a
second execution for that revision while recovery remains unresolved.
Editing a campaign revision cancels every open test for the replaced revision
inside the same durable edit transaction. A request that was still preparing
its provider call rechecks the revision before the write; an already in-flight
provider result cannot restore acceptance or evidence after cancellation.

The shared application boundary accepts no more than five configured
recipient identities and permits five new logical tests per site and campaign
revision in a rolling hour. Retries with the same request identity recover the
existing operation and do not consume another logical-test slot. Separately,
each provider write reserves its recipient count against a durable limit of 50
test-recipient emails per Brevo account scope and UTC day. A Brevo 429 remains
an ambiguous delivery outcome for reconciliation while retaining the visible
`provider_rate_limited` status.

The adapter reports Brevo's campaign API plain-text artifact capability as
`unsupported`. Brevo receives the exact authored subject, preview text and
rendered HTML; Foundry retains and binds the deterministic plain-text artifact
for portability without claiming that Brevo transmitted a separately supplied
plain-text body.

The full ADR-0002 provider acceptance suite remains a pre-production handoff
gate for the first client account. It covers subscriber and suppression
lifecycle, webhooks, reports, quotas, exports, credential rotation, scheduling,
and account recovery in addition to this test-delivery ceremony.

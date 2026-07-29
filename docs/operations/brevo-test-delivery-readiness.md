# Brevo test-delivery readiness

Foundry implements and verifies the newsletter test-delivery path without a
production client credential. A client-owned Brevo account becomes
production-ready through the owner-assisted ceremony below. An evaluation
account can exercise the same path while remaining explicitly
`evaluation_only`.

## Configuration

Install these values in the client-owned Worker configuration:

- `FOUNDRY_BREVO_API_KEY` — a client-created Worker secret with the narrow
  Brevo authority required by the newsletter adapter.
- `FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT` — a 64-character one-way account
  binding produced by provisioning. The raw Brevo account identifier stays out
  of source and application evidence.
- `FOUNDRY_BREVO_SENDER_IDS_JSON` — a protected mapping from Foundry logical
  sender identity to verified Brevo numeric sender ID.
- `FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON` — a protected mapping from configured
  Owner recipient identity to verified delivery address.

The runtime derives the provider-configuration fingerprint from the account
scope, sender mapping, and pinned adapter version. Recipient addresses pass
directly to Brevo for the explicit test request and are absent from operation
rows, evidence, API results, logs, and source control.

## Owner-assisted ceremony

1. Confirm the account ownership classification: `evaluation` for Foundry's
   temporary test account or `client_owned` for production.
2. Install the API key through the client-owned secret surface and install the
   three protected, non-secret configuration values.
3. Run the adapter health check. It verifies API access and every configured
   sender through Brevo account and sender reads.
4. Create or select the exact campaign revision in Foundry and request a test
   for configured recipient identities. The application API accepts identity
   keys, not email addresses.
5. Confirm the delivered message in the Owner's mailbox. Record confirmation
   against the returned stable test execution.
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
draft or test is absent.

The adapter reports Brevo's campaign API plain-text artifact capability as
`unsupported`. Brevo receives the exact authored subject, preview text and
rendered HTML; Foundry retains and binds the deterministic plain-text artifact
for portability without claiming that Brevo transmitted a separately supplied
plain-text body.

The full ADR-0002 provider acceptance suite remains a pre-production handoff
gate for the first client account. It covers subscriber and suppression
lifecycle, webhooks, reports, quotas, exports, credential rotation, scheduling,
and account recovery in addition to this test-delivery ceremony.

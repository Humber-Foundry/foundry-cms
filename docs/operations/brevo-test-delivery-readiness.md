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
- `FOUNDRY_CAMPAIGN_TEST_PROOF_KEY` — a stable, installation-specific Worker
  secret used only to bind the durable pre-send intent to the exact execution,
  provider campaign, configuration, and recipient set. Rotate it separately
  from the Brevo credential and only after open test operations are resolved.
- `FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN` — a random, installation-specific Worker
  secret of at least 32 characters. Configure the same value as the bearer
  token on Brevo's transactional webhook. Rotate the Brevo webhook and Worker
  secret together.
- `FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT` — a 64-character one-way account
  binding produced by provisioning. The raw Brevo account identifier stays out
  of source and application evidence. Provisioning computes SHA-256 over
  `foundry.brevo-account-scope.v1:` followed by the lowercase, trimmed account
  email returned by Brevo's account API.
- `FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON` — protected provisioning evidence
  containing the ownership classification, a stable evidence ID, the exact
  account-scope fingerprint, and its verification timestamp. If it is absent,
  the runtime classifies the account as `evaluation` and cannot report ready.
- `FOUNDRY_BREVO_SENDERS_JSON` — a protected mapping from each Foundry logical
  sender identity to its verified Brevo numeric ID and exact expected email
  address and required display name.
- `FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON` — a protected mapping from configured
  active Owner membership ID to verified delivery address. Runtime resolution
  rejects inactive, non-Owner, or unknown membership IDs.

## Before delivery is connected

An installation that holds none of the delivery secrets above still works as an
authoring surface. The Newsletter page renders, and a campaign can be written,
saved and read. Delivery is the only part that is off.

The delivery secrets are `FOUNDRY_NEWSLETTER_DELIVERY_SECRET`,
`FOUNDRY_SUBSCRIBER_IDENTITY_SECRET`, `FOUNDRY_BREVO_API_KEY`,
`FOUNDRY_CAMPAIGN_TEST_PROOF_KEY`, `FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN`,
`FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT`, `FOUNDRY_BREVO_SENDERS_JSON` and
`FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON`.

While any of them is absent or malformed:

- Every provider adapter stays the fail-closed one. A test request and a bulk
  send are refused.
- The campaigns API at `/api/foundry-cms/campaigns` refuses `request_test`,
  `confirm_test_receipt`, `authorize_bulk`, `activate_bulk_schedule`,
  `cancel_bulk_schedule`, `send_bulk_now` and `retry_bulk_send` with
  `delivery_not_configured` and HTTP 503.
- The send-artifact publisher reports a failure rather than a commit.
- Recording a provider suppression is refused, because the fingerprint would
  not match the same subscriber once the real subscriber identity secret is
  installed.

These settings stay required whether or not delivery is connected, because the
compliance footer they build is stored on every campaign revision and is read
by whoever receives the email: `FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID`,
`FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION`, `FOUNDRY_CAMPAIGN_LEGAL_NAME`,
`FOUNDRY_CAMPAIGN_POSTAL_ADDRESS`, `FOUNDRY_CAMPAIGN_CONTACT_URL` and
`FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL`. Foundry never stands in for them, so a
campaign saved before delivery is connected still carries the installation's
own footer.

A missing `FOUNDRY_DB` is different. It is a database fault, not a missing
delivery setting, so it still stops the request.

The MCP campaign surface in `apps/reference-site/src/mcp-campaign-runtime.ts`
is unchanged. It still refuses to start without the Brevo webhook token and
account-scope fingerprint, so it also fails closed.

## Delivery readiness report

`GET /api/foundry-cms/campaigns?readiness=delivery` answers whether email
delivery is connected. The same result is available to server code through
`readCampaignDeliveryReadiness` in `apps/reference-site/src/campaign-runtime.ts`.

```json
{
  "delivery": {
    "state": "not_configured",
    "missingSettings": ["FOUNDRY_BREVO_API_KEY"],
    "providerHealth": null,
    "setupGuide": "docs/operations/brevo-test-delivery-readiness.md"
  }
}
```

- `state` is `connected`, `not_configured`, or `local_development`.
  `connected` means every delivery secret is installed.
- `missingSettings` holds setting **names** only, in the order of the list
  above. The report never returns a setting value, a provider token or a
  personal email address.
- `providerHealth` is `null` unless every setting is installed. It then holds
  the provider's own `state`, `credential` and `senderIdentity`. A provider
  that cannot be reached is reported as `unavailable` rather than failing the
  request.

`connected` means every named setting is installed. It does not mean a test has
been delivered. Per-campaign test readiness stays with
`testDelivery.queries.readiness`, described in step 7 of the ceremony below.

The runtime derives the provider-configuration fingerprint from the account
scope, exact sender ID/address/name mapping, pinned adapter version, and a
one-way fingerprint of the installation proof key. Rotating the Brevo API
credential alone preserves
the send-intent binding. Rotating the installation proof key intentionally
changes the provider-configuration fingerprint, invalidates prior accepted
test evidence, and requires a new exact test and Owner confirmation. Recipient
addresses pass
directly to Brevo for the explicit test request and are absent from operation
rows, evidence, API results, logs, and source control.
The recipient-set binding fingerprint is keyed with the installation proof key,
so an API-visible fingerprint cannot be used to test guessed Owner addresses.
Each delivery binding also includes the fingerprint of the selected sender's
exact expected ID, address and display name. Provider health independently
reads the credential's Brevo account, derives
the same one-way account scope, and fails closed if it differs from the
provisioned scope or if a sender changes under its numeric ID.

## Owner-assisted ceremony

1. Install the provisioning evidence produced by the account-ownership
   workflow. Application callers cannot assert account ownership.
2. Install the API key, campaign-test proof key and webhook bearer token
   through the client-owned secret surface, then install the four protected
   configuration values.
3. Use Brevo's
   [webhook API](https://developers.brevo.com/reference/create-webhook) to
   register a transactional webhook at
   `/api/integrations/brevo/webhooks/transactional`. This integration
   namespace must remain outside the Cloudflare Access application that
   protects `/api/foundry-cms`; its exact bearer check is the callback's only
   application authentication boundary. Configure Brevo's `auth` object with
   `type: "bearer"` and the exact webhook token. Subscribe to `request`,
   `delivered`, `softBounce`, `hardBounce`, `blocked`, `invalid`, `deferred`,
   `error`, `opened`, `uniqueOpened`, `click`, `spam` and `unsubscribed`.
   Brevo documents the bearer-token mechanism in
   [Secure webhook calls](https://developers.brevo.com/docs/secured-webhooks)
   and the event payloads in
   [Transactional webhooks](https://developers.brevo.com/docs/transactional-webhooks).
   Installation verification must observe an application-level `401` from an
   unauthenticated callback probe while `/api/foundry-cms/revisions` still
   produces a Cloudflare Access challenge.
4. Run the adapter health check. It verifies API access and every configured
   sender through Brevo account and sender reads.
5. Create or select the exact campaign revision in Foundry and request a test
   for configured recipient identities. The application API accepts identity
   keys, not email addresses.
6. Confirm the delivered message in the Owner's mailbox. An authenticated
   Owner records confirmation with `confirm_test_receipt` and the stable
   execution ID; the immutable confirmation and its accepted command receipt
   are persisted atomically in one D1 batch. Reusing its request key with
   another execution is rejected and confirmation audits contain no recipient
   address. The confirming Owner must be one of the membership IDs that
   received that exact test.
7. Evaluate test-delivery readiness with the successful current test evidence.
   `ready`
   requires healthy credentials and sender identity, `client_owned`
   classification, an exact provider-configuration fingerprint match, and the
   Owner's receipt confirmation. This result is test-delivery evidence, not a
   production-readiness declaration.

Every logical test prepares a stable provider correlation ID and an
installation-keyed HMAC Foundry send proof without creating a mutable Brevo
draft. Foundry persists
that proof, acquires a durable send lease, and makes one transactional-email
request containing the exact rendered HTML, subject, verified sender address
and display name, and explicit recipient addresses. The request also carries
the execution ID as a Brevo tag, uses it as the provider idempotency key, and
carries it under Brevo's exact `Idempotency-Key` custom-header field. The
execution/proof values use a separate custom header. A Brevo 201 response
must contain a message ID before Foundry stores accepted evidence. Other
successful-looking HTTP statuses remain ambiguous.

A timeout, lost response, malformed success response, rate limit or server
error remains ambiguous. Foundry does not issue another provider write for that
logical operation. The authenticated webhook persists the provider message ID,
event type and installation-keyed recipient fingerprint only when the event
carries the exact execution tag and pre-send proof. It never stores a recipient
address. Brevo's integer `id` identifies the configured webhook, so Foundry
does not use it to identify an event. Retry identity is a canonical stable
fingerprint of the site, provider, execution ID, pre-send proof, provider
message ID, installation-keyed recipient fingerprint, event type, and provider
event timestamp. Local receipt time is evidence metadata and never part of
retry identity.
Reconciliation uses this durable webhook evidence to authenticate
Foundry's send origin, then queries Brevo's event report, message record and
each per-recipient sent-content record to verify the sender, exact recipient
set, subject and actual sent HTML. Polling can enrich or contradict the
authenticated evidence, but polling alone cannot turn an ambiguous write into
accepted evidence. Provider drift is rejected. Missing, partial or unavailable
evidence remains ambiguous.

To restart an unresolved test safely, replay the same request so Foundry
reconciles it first. A restart is available only when tagged evidence proves
terminal non-delivery for every exact recipient and shows no delivery-derived
event such as delivery, open, click, complaint, proxy open, or unsubscribe.
Foundry then records the original operation as failed; the operator can issue a
new logical request with a new request ID. An empty result, a recipient subset,
or conflicting delivery evidence leaves the original operation unresolved and
continues to block another provider write.

The send lease serializes the provider request against campaign edits and
membership deauthorization. While the lease is active, a campaign edit and
suspension or revocation of a recipient Owner are rejected. A mutation that
wins before lease acquisition is caught by the final revision and active-Owner
checks. The lease is atomically renewed after final binding checks and
immediately before the bounded provider request. After the provider response is
durably classified, edits may proceed;
they make prior accepted evidence stale, and they cancel open ambiguous work
for the replaced revision.

The active release renderer must match the renderer recorded on the immutable
campaign revision before a test can start or prior evidence can be treated as
current. A deployment renderer change therefore requires a newly rendered
revision and test.

The shared application boundary accepts no more than five configured
recipient identities and permits five new logical tests per site and campaign
revision in a rolling hour. Retries with the same request identity recover the
existing operation and do not consume another logical-test slot. Separately,
each provider write reserves its recipient count against a durable limit of 50
test-recipient emails per Brevo account scope and UTC day. A Brevo 429 remains
an ambiguous delivery outcome for reconciliation while retaining the visible
`provider_rate_limited` status.

The adapter reports Brevo's transactional API plain-text artifact capability as
`unsupported`. Brevo receives the exact authored subject and rendered HTML;
Foundry retains and binds the preview text and deterministic
plain-text artifact
for portability without claiming that Brevo transmitted a separately supplied
plain-text body.

The full ADR-0002 provider acceptance suite remains a pre-production handoff
gate for the first client account. It covers subscriber and suppression
lifecycle, webhooks, reports, quotas, exports, credential rotation, scheduling,
and account recovery in addition to this test-delivery ceremony.

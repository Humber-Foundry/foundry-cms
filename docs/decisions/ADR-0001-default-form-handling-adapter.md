# ADR-0001: Default Cloudflare form-handling adapter

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

Foundry CMS needs a client-owned form service that accepts public submissions,
survives notification failures, remains usable on Cloudflare's default free-tier
installation, and does not bind the form domain model to one notification
provider.

The intake path must make acceptance truthful: a visitor must not receive a
success response until the submission and its notification intent are durable.
The default must also define abuse handling, retention, recovery, health, audit,
and operator-visible failure behaviour.

This decision uses the evidence in
[`cloudflare-native-form-handling.md`](../research/cloudflare-native-form-handling.md)
and resolves [issue #4](https://github.com/Galen-Humber-Foundry/foundry-cms/issues/4).

## Decision

Use a **D1 transactional outbox with shared scheduled delivery** as the default
form-handling adapter.

### Intake and persistence

- A Worker accepts schema-versioned, text-only submissions over HTTPS.
- It applies strict schema validation, origin and body-size checks, honeypot and
  timing signals, coarse rate limiting, and server-side Turnstile verification
  of the expected hostname and action.
- Turnstile failure or unavailability fails closed with a retryable public error.
- A client submission ID makes retries idempotent.
- One D1 transaction stores the immutable submission, classification, audit
  event, delivery intent, and outbox event. Success is returned only after that
  transaction commits.
- D1 is authoritative. Logs, notification email, and scheduled-worker state are
  never the submission record.

### Classification

- Clearly automated submissions are blocked.
- Borderline submissions are retained in a spam-review area for 30 days, do not
  notify staff, and can be reclassified by an operator.
- Secure file uploads are outside the default contract and require a separate
  opt-in module with private storage, quarantine, scanning, lifecycle, and
  controlled retrieval.

### Notification and recovery

- A shared scheduled worker claims due delivery rows and sends them within a few
  minutes through a replaceable `DeliveryAdapter`.
- The free-tier default uses Cloudflare Email Service only for fixed,
  installation-configured, verified staff destinations.
- A notification contains form identity, time, receipt reference, explicitly
  configured non-sensitive preview fields, and a secure CMS link. It does not
  copy the full submission by default.
- Visitor confirmation email, arbitrary-recipient delivery, and mailing-list
  delivery are separate optional transports. They must not change the form
  submission or delivery domain model.
- Delivery IDs are idempotency keys. Retryable failures use capped backoff for
  24 hours. Exhausted or permanent failures remain visible in the CMS and can be
  replayed manually without altering the submission.

The delivery boundary accepts trusted destination and template references and
returns normalized `sent`, `retry`, or `permanent_failure` outcomes with stable
codes. Provider credentials remain in client-owned Worker secrets.

### Retention, backup, and audit

- Ordinary submission payloads default to 180-day retention with per-form
  overrides.
- Expiry erases the payload and personal fields. Minimal non-payload audit facts
  remain for one year.
- Daily encrypted backups are stored in client-owned Cloudflare storage and
  expire after 30 days. Privacy disclosures and deletion runbooks acknowledge
  that recovery window.
- The audit trail records acceptance, classification, authenticated view,
  export, reclassification, deletion, delivery attempt, and replay using actor,
  action, time, outcome, and opaque object references; it never copies the form
  payload.

### Health and limits

- A quiet daily synthetic submission verifies validation, Turnstile
  configuration, D1 persistence, and delivery processing without notifying
  production recipients. Its result is exposed in the CMS and a
  machine-readable health check.
- Operators receive visible free-tier usage warnings at 70% and critical
  warnings at 90%.
- Intake continues while durable capacity exists. Quota exhaustion returns an
  explicit retryable unavailable response and never claims acceptance.
- The operator surface exposes delivery state, oldest pending age, attempts,
  stable error codes, spam review, audit history, health-check status, and
  manual replay.

## Consequences

- The default remains small, client-owned, provider-replaceable, and compatible
  with fixed-recipient notification on Cloudflare's free tier.
- Accepted submissions survive email outages and can be repaired from durable
  state without relying on log retention.
- Notification is intentionally not immediate; normal latency is the shared
  scheduler interval.
- Scheduled claiming and delivery still require concurrency protection and
  idempotency because a send can succeed before its result is recorded.
- Arbitrary-recipient email, upload handling, and multi-step escalation are
  explicit extensions rather than hidden costs in every installation.
- Newsletter ownership and bulk delivery remain a separate architecture
  decision. This ADR does not make an external newsletter provider authoritative
  for Foundry's subscriber or consent model.

## Alternatives considered

- **D1 outbox plus Cloudflare Queues** — rejected as the default because
  near-immediate notification does not justify another consistency boundary,
  reconciler, DLQ, and tighter free-tier operation ceiling. It remains a future
  delivery-mode option behind the same domain model.
- **D1 outbox plus one Workflow per submission** — rejected because durable
  multi-step orchestration is unnecessary for a single default staff
  notification and adds platform and pricing surface.
- **Send email inside intake** — rejected because notification failure would
  compromise truthful acceptance and durable recovery.
- **Accept file uploads by default** — rejected because storage alone does not
  provide quarantine, malware scanning, safe retrieval, or lifecycle policy.


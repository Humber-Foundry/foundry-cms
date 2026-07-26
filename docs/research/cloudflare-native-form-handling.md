# Cloudflare-native form handling research

Status: research input for a downstream architecture decision

Issue: [#2](https://github.com/Galen-Humber-Foundry/foundry-cms/issues/2)

Pricing and platform limits checked: 2026-07-25

## Scope and conclusion boundary

Foundry CMS needs a default form-handling architecture that can validate public
submissions, retain them durably, notify an operator, resist abuse, recover from
partial failures, and make costs understandable on Cloudflare.

This document compares candidate architectures. It deliberately does **not**
select one. The downstream decision should choose based on expected volume,
notification recipients, operational tolerance, and whether attachments belong
in the default product.

## Findings that shape every candidate

- A Worker or Pages Function is the natural intake boundary. Pages Functions are
  billed and limited as Workers.
- Turnstile is a signal, not validation. The intake Worker must call Siteverify,
  then verify `success`, `hostname`, and `action`. Tokens expire after five
  minutes and are single-use.
- D1 should be the system of record. A response must not claim acceptance until
  the submission and its delivery intent have committed.
- Notification is a side effect. A notification failure must not erase or reject
  an otherwise durable submission.
- D1 and Queues or Workflows do not share a transaction. A transactional D1
  outbox plus a reconciler is required if starting either service is part of the
  chosen architecture.
- Cloudflare Queues is at-least-once. Consumers and delivery adapters must be
  idempotent.
- Cloudflare's free email path is complete for fixed, verified staff
  destinations. Sending to arbitrary recipients, including submitter receipt
  addresses, requires Workers Paid or an external provider.
- Arbitrary file uploads are a separate trust problem. The form endpoint should
  not accept attachments unless the product also supplies object quarantine,
  validation or scanning, lifecycle cleanup, and controlled retrieval.

## Common intake contract

All candidates can share the same public request pipeline.

1. Accept `POST` only over HTTPS and restrict CORS to configured site origins.
2. Apply a small application body limit before parsing. A default text-only form
   should be measured in kilobytes, not Cloudflare's 100 MB account-plan request
   ceiling.
3. Resolve the published form schema by site, form ID, and immutable schema
   version. Reject unknown fields, wrong types, excessive lengths, invalid
   enumerations, and invalid attachment references.
4. Apply inexpensive abuse checks before expensive work: method and content type,
   origin, body size, honeypot, minimum-fill timing, and a coarse rate limit.
5. Validate Turnstile server-side with an expected hostname and form-specific
   action. Use Siteverify's idempotency key for safe verification retries.
6. Normalize approved fields. Do not treat HTML supplied by the visitor as safe
   notification content.
7. Require a client-generated submission ID or issue one before the durable
   write. Enforce uniqueness by site and form so retries return the original
   receipt instead of creating duplicates.
8. In one D1 batch transaction, insert the immutable submission, its current
   classification, and one or more delivery intents. D1 batches are
   transactional and roll back the sequence on failure.
9. Return an opaque receipt only after the transaction commits. Return a
   retryable error when durable storage is unavailable or its free-plan quota is
   exhausted.

Turnstile should be combined with layered controls:

- a CMS-wide and per-form limit;
- a permissive Worker rate-limit binding for load shedding, with the
  understanding that its counters are per Cloudflare location and eventually
  consistent;
- honeypot and elapsed-time signals;
- field and link-count heuristics;
- optional `accepted`, `suspected_spam`, and `blocked` classifications rather
  than deleting borderline submissions; and
- an operator feedback path that can tune rules without changing stored
  submissions.

IP addresses are weak identities and can represent many legitimate users. If an
abuse key is needed, prefer a short-lived, rotating keyed hash and a short
retention period over storing raw IP addresses with the submission.

## Candidate A: D1 transactional outbox with Cron delivery

```text
Browser -> intake Worker -> Turnstile
                       -> D1 submission + outbox transaction
Cron Worker -> claim due outbox rows -> email/delivery adapter
            -> update delivery state in D1
```

The intake transaction writes both the submission and a pending delivery row. A
scheduled Worker periodically claims due rows, sends them through the configured
delivery adapter, and records success, a permanent failure, or a retry time.

### Properties

- Fewest platform resources: Worker, D1, Turnstile, Email Service, and one Cron
  Trigger.
- Fully Cloudflare-native on the free tier when notification destinations are
  fixed and verified.
- D1 is both the durable record and retry queue, so there is no D1-to-queue
  consistency gap.
- Notification latency is bounded by the Cron interval rather than immediate.
- Claiming must prevent concurrent Cron runs from sending the same row. Delivery
  still needs an idempotency key because a process can send successfully and
  fail before recording success.
- Polling queries must be indexed on delivery status and next-attempt time to
  avoid D1 row-read growth.
- The Workers Free plan allows five Cron Triggers per account, so multiple sites
  should share a scheduler rather than allocate one trigger per form or tenant.

### Recovery

The outbox is the replay source. A reconciler selects pending or stale claimed
rows, applies capped exponential backoff, and moves permanently failed work to an
operator-visible state. No accepted submission depends on log retention for
recovery.

## Candidate B: D1 transactional outbox with Queues delivery

```text
Browser -> intake Worker -> Turnstile
                       -> D1 submission + outbox transaction
publisher/reconciler -> Queue -> consumer Worker -> email/delivery adapter
                                         -> D1 delivery state
                                      failures -> DLQ
```

The intake path is the same as Candidate A. A publisher sends compact outbox
messages containing identifiers, not full form payloads. A Queue consumer loads
the authoritative record from D1, delivers it, and updates D1. A periodic
reconciler republishes rows that committed to D1 but were not confirmed as
published.

### Properties

- Near-immediate notifications, buffering, consumer batching, delayed retries,
  and a dead-letter queue.
- Queue delivery is at-least-once. Use the delivery ID as the provider
  idempotency key and enforce a unique D1 delivery record.
- D1 remains necessary beyond retention in Queues. On Workers Free, Queue message
  retention is 24 hours; a durable submission cannot rely on that window.
- A small message normally costs at least three Queue operations: write, read,
  and successful delete. Retries and DLQ writes add operations.
- Free Queue capacity is therefore at most about 3,333 successfully processed
  small messages per day before retries, DLQ traffic, or multi-channel
  notifications. This is a platform ceiling, not a safe operating target.
- Queue state and D1 state must be reconciled because publishing cannot be atomic
  with the D1 intake transaction.

### Recovery

The consumer explicitly acknowledges each successful message. Transient
failures retry with backoff; poison messages move to a DLQ rather than
disappearing. An operator can inspect the D1 delivery record, correct the cause,
and replay by delivery ID. The reconciler covers the commit-before-publish gap.

## Candidate C: D1 outbox with a Workflow per submission

```text
Browser -> intake Worker -> Turnstile
                       -> D1 submission + outbox transaction
starter/reconciler -> Workflow instance
                   -> email/delivery step(s) -> D1 delivery state
```

A durable Workflow instance owns delivery attempts and any multi-step
orchestration, such as notify staff, wait, escalate, or emit a webhook. D1 still
holds the submission and delivery intent; a reconciler starts any Workflow that
was not created after the D1 commit.

### Properties

- Durable step retries, sleeps, state, and per-instance inspection are built in.
- It represents multi-step notification and escalation more directly than a
  hand-built retry state machine.
- It is more platform surface than a single notification requires.
- Free Workflows usage is limited to 3,000 steps per day, 1 GB-month of state,
  and three-day instance-state retention. Worker request and CPU limits also
  apply.
- Paid Workflows include 500,000 steps and 1 GB-month per month; additional
  usage is priced separately. Cloudflare states that step and storage billing
  begins no earlier than 2026-08-10, so this candidate's cost model is still a
  moving operational dependency at the time of research.
- Starting a Workflow is not atomic with the D1 commit, so the outbox and
  reconciler remain necessary.

### Recovery

Workflow retries cover transient step failures. D1 remains the long-lived
operator record after Workflow state ages out. A deterministic Workflow
instance ID based on the delivery ID prevents duplicate orchestration.

## Notification delivery boundary

Cloudflare Email Service can send for free to destination addresses verified on
the account. That is sufficient for a default "notify this site's operators"
path if CMS configuration, not visitor input, selects the recipient.

Workers Paid is required for arbitrary recipients. It includes 3,000 outbound
emails per month, then charges per 1,000. A submitter confirmation feature,
dynamic routing to unverified addresses, SMS, CRM/ticket creation, or richer
deliverability analytics must therefore use paid Cloudflare Email Service or an
external adapter.

The adapter belongs behind the outbox consumer, Cron handler, or Workflow step,
never in the intake transaction:

```ts
interface DeliveryAdapter {
  send(input: {
    deliveryId: string;
    submissionId: string;
    destinationRef: string;
    templateId: string;
    locale?: string;
  }): Promise<{
    outcome: "sent" | "retry" | "permanent_failure";
    providerMessageId?: string;
    retryAfterSeconds?: number;
    errorCode?: string;
  }>;
}
```

Required adapter behavior:

- resolve destination references from trusted server-side configuration;
- pass `deliveryId` as the provider idempotency key where supported;
- classify timeouts, throttling, and 5xx responses as retryable;
- classify invalid destinations and rejected templates as permanent;
- return stable codes, not raw provider responses or secrets;
- normalize provider webhooks into delivery-state updates;
- keep credentials in Worker secrets; and
- render untrusted visitor content as escaped text or link to an authenticated CMS
  view instead of placing full sensitive payloads in email.

An object-scanning adapter is a second, independent boundary if uploads are
enabled. Cloudflare's R2 storage and event notifications do not themselves
establish that an arbitrary object is safe to open.

## Attachment boundary

The supportable default is text-only unless a downstream decision explicitly
accepts the operational scope of uploads.

An optional upload architecture can use:

1. an intake Worker that validates Turnstile and creates a short-lived upload
   grant for a unique, unguessable R2 object key;
2. a direct presigned `PUT` to a private R2 bucket;
3. a finalization request that verifies the object with `HEAD`, records size,
   declared type, checksum, and ownership in D1, and marks it `quarantined`;
4. an R2 event notification or explicit D1 outbox item that invokes a scanner;
5. promotion to `available` only after policy checks pass; and
6. lifecycle deletion of abandoned, rejected, and expired objects.

Presigned URLs are bearer tokens and can be reused until expiry. They should be
short-lived and limited to one generated key and a signed content type. The
server must still verify actual size and content after upload; a declared MIME
type is not proof. Object reads should use short-lived authorized URLs or stream
through an authenticated Worker. The bucket should not be public.

Application limits should be much smaller than R2's platform maximum. A product
policy should define allowed types, per-file and per-submission bytes, count,
retention, scan timeout, failed-scan behavior, and who may download. Staff email
notifications should link to the quarantined CMS record and never attach the
visitor's file.

R2's free tier includes 10 GB-month, 1 million Class A operations, and 10 million
Class B operations monthly. Standard-storage overages are charged for storage
and operations with no egress fee. A cost model must include abandoned uploads,
scanner reads, operator downloads, and retention—not only accepted submissions.

## Minimal durable data model

The exact schema is a later implementation concern, but each candidate needs
equivalent durable facts:

- `submissions`: opaque ID, tenant/site/form IDs, schema version, received time,
  normalized payload, classification, retention deadline, and deletion state;
- `deliveries`: delivery ID, submission ID, adapter and destination reference,
  template version, status, attempt count, next attempt, provider message ID,
  last stable error code, and timestamps;
- `outbox`: event ID, aggregate ID, event type, created time, claim or publish
  state, and replay count;
- `attachments` when enabled: object key, submission ID, size, declared and
  detected types, checksum, quarantine state, scan result, and expiry; and
- `audit_events`: actor class, action, opaque object IDs, timestamp, and outcome,
  without copying the submission payload.

Indexes improve query cost but add D1 row writes when indexed columns change.
Cost estimates must count index maintenance and delivery-state transitions, not
only one submission insert.

## Privacy and retention

- Collect only fields defined by the published form schema and show the purpose
  and retention notice beside the form.
- Configure field- or form-class retention in the CMS. A scheduled purge should
  remove expired payloads and attachments while retaining only the minimum audit
  fact required by policy.
- Never log form bodies, email addresses, Turnstile tokens, authorization data,
  presigned URLs, or attachment bytes.
- Keep notification emails sparse. Email copies data into another system with a
  different retention and access model.
- D1 jurisdiction is selected when the database is created and cannot be added
  later. The `eu` jurisdiction constrains where the database runs and persists;
  it does not constrain where a globally deployed Worker processes a request.
- D1 Time Travel retains restorable history for seven days on Workers Free and
  30 days on Workers Paid. A privacy policy and deletion runbook must account for
  that recovery window.
- Time Travel is recovery, not a long-term archive. If policy requires longer
  recoverability, an encrypted export and its deletion lifecycle are a separate
  decision.

## Observability and failure recovery

Durable operational state should be queryable from D1. Logs explain an attempt;
they are not the queue or audit record.

Record counters and timings for:

- accepted, duplicate, validation-rejected, suspected-spam, and blocked requests;
- Turnstile result and latency using non-sensitive reason codes;
- D1 write failures and quota failures;
- pending, claimed, retrying, permanently failed, and sent deliveries;
- oldest pending delivery age and attempts per delivery;
- Queue publishes, retries, lag, and DLQ depth when applicable;
- Workflow starts, retries, failures, and stale outbox rows when applicable; and
- attachment grants, finalized bytes, abandoned objects, scan results, and
  quarantine age when applicable.

Workers Logs includes 200,000 events per day with three-day retention on Free.
Paid includes 20 million events per month with seven-day retention, then charges
per million. Use structured logs, sampling for successes, full error-event
capture where practical, and opaque correlation IDs. Turnstile Free analytics
has a seven-day lookback.

An operator view or runbook should cover:

| Failure | Public behavior | Durable recovery |
| --- | --- | --- |
| Turnstile timeout | Fail closed or accept into quarantine, per decision | Count and review; never silently bypass |
| D1 transaction fails | Return retryable error; do not claim acceptance | Client retries with same submission ID |
| Notification fails | Submission remains accepted | Backoff, inspect, and replay delivery ID |
| Queue publish fails | Submission remains accepted | Reconciler republishes D1 outbox row |
| Duplicate Queue delivery | No duplicate intended effect | Unique delivery ID and adapter idempotency |
| Queue retry limit reached | No submission loss | DLQ plus D1 permanent-failure state |
| Free-plan quota exhausted | Explicit service-unavailable response | Alert, wait for reset or upgrade |
| Attachment never finalizes | No submission attachment | R2 lifecycle removes orphan |
| Scanner unavailable | Keep object quarantined | Retry or operator disposition |
| Bad migration or deletion | Pause writes during recovery | D1 Time Travel, then replay pending delivery state |

At least one synthetic submission should run on a schedule and stop before
notifying production recipients, or target a dedicated verified test
destination. Custom paging outside a verified email destination is itself
another delivery adapter.

## Operating-cost constraints

These are account-level allowances and can be shared by unrelated projects.
Cloudflare pricing can change; the decision record should recheck the linked
pages.

| Primitive | Workers Free | Workers Paid / standard |
| --- | --- | --- |
| Workers and Pages Functions | 100,000 requests/day; 10 ms CPU/invocation | $5/month minimum; 10M requests and 30M CPU-ms/month included, then request and CPU overages |
| D1 | 5M rows read/day; 100k rows written/day; 5 GB/account; 500 MB/database; 7-day Time Travel | 25B reads, 50M writes, and 5 GB/month included; then $0.001/M reads, $1/M writes, $0.75/GB-month; 30-day Time Travel |
| Turnstile | Free; 20 widgets/account; unlimited challenges; 10 hostnames/widget; 7-day analytics | Enterprise terms for expanded management |
| Queues | 10k operations/day; 24-hour retention | 1M operations/month included, then $0.40/M; longer retention |
| Email Service | Free to verified destinations; arbitrary recipients unavailable | 3,000 arbitrary-recipient emails/month included, then $0.35/1,000; verified-destination sends remain free |
| Workflows | 3,000 steps/day; 1 GB-month state; three-day instance retention | 500k steps and 1 GB-month included, then $0.80/100k steps and $0.20/GB-month, plus Worker usage |
| R2 Standard | 10 GB-month; 1M Class A and 10M Class B operations/month | $0.015/GB-month, $4.50/M Class A, $0.36/M Class B; no egress fee |
| Workers Logs | 200k events/day; three-day retention | 20M events/month and seven-day retention included, then $0.60/M |
| Cron Triggers | 5/account | 250/account |

Useful workload formulas:

- Worker requests/day include intake, upload grants and finalization, admin API
  reads, Cron invocations, and Workflow invocations where applicable.
- D1 writes/submission include submission rows, outbox and delivery rows, index
  entries, classifications, every delivery attempt transition, and attachment
  state transitions.
- Queue operations are approximately
  `(writes + reads + deletes) × ceil(message_bytes / 64 KB)`, plus retries and
  DLQ operations.
- Email cost depends on messages, not submissions. Staff plus submitter receipts
  may be two or more messages per accepted submission.
- R2 cost depends on retained byte-months and operations. Rejected and abandoned
  objects still consume resources until lifecycle deletion.
- Workflow steps include each durable operation. Retries do not count as steps
  for pricing, but their CPU and persisted state still matter.

For illustration, 20,000 arbitrary-recipient emails in a month on Workers Paid
would use the 3,000 included emails and add about $5.95 in email usage, in
addition to the $5 Workers minimum and any other overages. The same volume sent
only to verified staff destinations does not consume that email quota.

## Downstream decision inputs

The architecture ticket should make the following choices explicitly:

1. Required notification latency: Cron interval versus near-real-time.
2. Expected submissions and notification fan-out at the 50th, 95th, and abuse
   percentiles.
3. Fixed verified staff recipients versus arbitrary recipient email.
4. Single notification versus multi-step escalation or orchestration.
5. Whether free-tier-only operation is a requirement or an initial deployment
   mode.
6. Whether attachments are excluded, optional, or part of the default contract.
7. Retention, deletion, jurisdiction, and backup-recovery requirements.
8. Turnstile outage behavior: fail closed or quarantine.
9. Operator surface for failed delivery, spam review, replay, and audit.
10. Acceptable dependency maturity and pricing-change risk, especially for
    Workflows.

## Primary sources

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  and [limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
  [limits](https://developers.cloudflare.com/d1/platform/limits/),
  [transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
  [data location](https://developers.cloudflare.com/d1/configuration/data-location/),
  and [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) and
  [server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/),
  [limits](https://developers.cloudflare.com/queues/platform/limits/),
  [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
  [retries](https://developers.cloudflare.com/queues/configuration/batching-retries/),
  and [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/),
  [send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/),
  and [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
  and [limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
  [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
  and [event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Workers Logs pricing and retention](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

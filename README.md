# foundry-cms
Open-source, self-hosted visual CMS for schema-bound websites on Cloudflare

## Executable reference installation

The repository is an npm workspace monorepo with three initial boundaries:

- `apps/reference-site` — the Next.js 16 App Router installation configured for
  Cloudflare Workers through OpenNext;
- `packages/site-definition` — the versioned, client-neutral Site Definition
  contract and representative published content; and
- `packages/application` — the site-scoped application query used by both the
  public renderer and `/dash`.

Install and run the local development surface:

```sh
npm install
npm run dev
```

The public site is available at `http://localhost:3000`. In local development,
`http://localhost:3000/dash` uses a local Owner identity. Outside development,
the dashboard validates Cloudflare Access and reloads the current D1 membership
on every protected request. It fails closed if the assertion, Access issuer,
application audience or database binding is absent or invalid.

Production installation supplies:

- a D1 database through the `FOUNDRY_DB` binding, after replacing the
  provisioning placeholder in `apps/reference-site/wrangler.jsonc`;
- a private, client-owned R2 bucket through the `FOUNDRY_MEDIA` binding;
- `FOUNDRY_ACCESS_ISSUER`, set to the exact HTTPS Cloudflare Access team
  domain;
- `FOUNDRY_ACCESS_AUDIENCE`, set to the audience of the one Access application
  protecting `/dash`, `/api/foundry-cms` and preview paths; and
- `FOUNDRY_ACCESS_ACCOUNT_ID`, `FOUNDRY_ACCESS_APPLICATION_ID`,
  `FOUNDRY_ACCESS_POLICY_ID` and `FOUNDRY_ACCESS_LOGIN_METHOD_ID`, identifying
  the client-owned exact-email Allow policy and required OTP login method;
- `FOUNDRY_ACCESS_API_TOKEN`, a Worker secret restricted to Access Apps and
  Policies Write for that client account;
- `FOUNDRY_CANONICAL_ORIGIN` and a strong `FOUNDRY_CSRF_SECRET` Worker secret,
  used to bind every JSON mutation to the verified Access identity;
- `FOUNDRY_TURNSTILE_SECRET`, a Worker secret for the Turnstile widget whose
  hostname matches `FOUNDRY_CANONICAL_ORIGIN` and whose contact-form action is
  `contact`;
- the checked-in `FOUNDRY_FORM_RATE_LIMITER` binding, updated to use an
  installation-unique positive integer `namespace_id`;
- `FOUNDRY_FORM_BACKUP_RECIPIENT`, the client's base64-encoded SPKI public
  recovery key; its matching private key must remain outside Cloudflare;
- `FOUNDRY_PRODUCTION_BASE`, set to the exact 40- or 64-character Git commit
  containing the bundled published content; renderer identity comes from the
  Worker version-metadata binding (or an exact `FOUNDRY_RENDERER_VERSION`); and
- an initial Owner invitation created by guided provisioning before handoff.

Apply the checked-in D1 migrations to both the primary and isolated recovery
databases locally with:

```sh
npm run db:migrate:local --workspace @humber-foundry/reference-site
```

Before deployment, apply the same migrations to both remote databases:

```sh
npm run db:migrate:remote --workspace @humber-foundry/reference-site
```

Foundry stores no password or login session. Owners can invite Editors or other
Owners and activate, suspend or revoke memberships from `/dash`. Suspensions
and revocations take effect in D1 before the member's next protected request;
the database also prevents removal of the final active Owner. New invitations
remain unclaimable in `pending_access_sync` until the complete D1-derived
exact-email policy has been written to Cloudflare and read back successfully.
Failed policy work remains in a transactional outbox with bounded retry delays;
the custom Worker reconciles due work every five minutes, and Owners can also
retry immediately from the dashboard. Every member mutation carries an
idempotency key; D1 replays completed responses and blocks ambiguous duplicate
execution.

### Public form intake

The reference installation accepts the versioned, text-only contact form at
`POST /api/forms/contact/submissions`. Requests must be same-origin JSON no
larger than 16 KiB and include:

```json
{
  "schemaVersion": "1.0.0",
  "submissionId": "00000000-0000-4000-8000-000000000046",
  "fields": {
    "name": "Ada",
    "message": "Please tell me more."
  },
  "turnstileToken": "browser-token",
  "honeypot": "",
  "startedAt": "2026-07-27T19:59:45.000Z"
}
```

`submissionId` is a client-generated UUID v4 and the stable Turnstile
Siteverify idempotency key. After schema, origin, size, rate, abuse, hostname
and action checks pass, one D1 batch transaction records the immutable
submission, classification, payload-free audit fact, delivery intent and
outbox event. The endpoint returns `201` with the same opaque receipt on a
network retry only after durable acceptance. Borderline spam is retained with
delivery held; invalid and clearly automated input is rejected. Capacity,
Turnstile and D1 failures return retryable public errors without internal
details.

### Immutable content revisions

Owners and Editors can change schema-declared copy from `/dash`. Every save uses
a stable field path, idempotency key and base revision; D1 creates an immutable
revision or returns the latest revision as an explicit conflict. Saved revisions
render at `/__foundry/preview/<workspace>/<revision>` through the same site renderer used
by the public route. The short-lived preview capability is bound to the current
actor, workspace and revision, and its D1 bookmark preserves read-your-write
consistency. The preview identifies its exact content hash, schema version,
Worker renderer version and bundled production-base content hash.

### Client-owned media

Media sources are written to the private `FOUNDRY_MEDIA` R2 bucket under
`media/<site-id>/<asset-id>/source`. D1 stores stable asset metadata and
site- and draft-workspace-scoped occurrence references. Uploads verify the image
format and
dimensions from the source bytes before recording caller-supplied metadata.
Replacing one occurrence appends a revision
only for that occurrence; cropping appends normalized crop data and never
rewrites the R2 source. The selected occurrence revision and asset presentation
metadata are then fingerprinted into the Editor's immutable content revision;
the exact preview renders that bound manifest, while the public route continues
to render only the Git-published Site Definition. Published source delivery
checks the requested asset against that Git manifest before reading private R2.
The media and content receipts share a stable retry key bound to the workspace,
so a raced content head is reconciled against the latest revision and an
ambiguous response can be retried without appending another occurrence. All
mutations are idempotent and audited. Deletion first reserves an unreferenced
asset in D1, fences new references, and durably tombstones its stable identity
before removing its source. The reservation remains recoverable until the
source removal and mutation receipt complete. Any current or historical
occurrence revision rejects deletion so immutable previews never acquire a
broken media reference.

Build and verify the Cloudflare Workers artifact:

```sh
npm run build
npm run build:worker
npm run verify:worker
```

`verify:worker` starts the built artifact in the local `workerd` runtime,
confirms the public page renders, and confirms an unconfigured production
dashboard returns a not-found response. No Cloudflare account or secret is
required.

Run the deterministic checks:

```sh
npm test
npm run typecheck
npm run verify:bundle
```

The bundle check reads the optimized build and proves that protected dashboard
client code is absent from the public route’s emitted scripts.

## Product contracts

- [Production MCP contract](docs/mcp/README.md)
- [Guided per-client provisioning and operator CLI](docs/architecture/guided-client-provisioning.md)
- [Blog and newsletter publishing lifecycle](docs/domain/blog-newsletter-publishing-lifecycle.md)
- [Architecture decisions](docs/decisions/DECISION-LOG.md)

## Repository integrity

The repository runs an event-driven and daily integrity check over its Wayfinder
map, public GitHub metadata and tracked files.

The check enforces these invariants:

- every closed map child has a recognizable outcome comment and a decision
  pointer in its parent map;
- an open child with an explicit resolution is rejected as likely bookkeeping
  drift;
- a closed map cannot retain an open child;
- required map sections remain present;
- secret-manager references are rejected from public content; and
- optional client-specific terms are rejected without storing those terms in
  this public repository.

Configure the optional client boundary as a repository secret named
`WAYFINDER_FORBIDDEN_TERMS`. Its value is a JSON array of lowercase terms. The
workflow reports only the affected location, never the configured term.

Run the same check locally with:

```sh
node scripts/verify-repository-integrity.mjs
```

## Form notification configuration

The reference Worker processes accepted public forms on its five-minute
schedule. Each installation must replace the example `send_email`
`destination_address` in `apps/reference-site/wrangler.jsonc` with one verified
staff mailbox and configure `FOUNDRY_FORM_EMAIL_FROM` and
`FOUNDRY_FORM_EMAIL_RECIPIENT` to the same fixed sender/destination pair. The
application command accepts no recipient input; visitor confirmations and
arbitrary-recipient delivery are deliberately outside this adapter.
`FOUNDRY_FORM_EMAIL_PREVIEW_FIELDS` is a comma-separated, per-installation
allowlist of form field IDs that have been classified as safe for notification
previews; omit it to send no submitted values.

Delivery failures remain in D1 with capped retries for 24 hours. The protected
dashboard reports queue age, failures, retry attempts, adapter configuration,
and conservative logical D1 capacity bands (payload bytes plus per-record
overhead) without copying submission payloads. An outcome that
could have reached the provider is stopped for explicit human reconciliation
instead of being reclaimed automatically.

## Form privacy, retention, backup, and recovery

Only an active Owner can export, reclassify, erase, or restore form data.
Every view, export, classification, erasure, delivery action, backup, and
restore verification records only the actor membership, opaque delivery or
backup identifier, action, outcome code, and time. Audit rows never copy form
fields.

The scheduled Worker erases payloads after 30 days for suspected spam and
after 180 days for accepted submissions. It retains minimal audit facts for
one year. Installations may set the positive whole-day
`FOUNDRY_FORM_RETENTION_SPAM_DAYS`,
`FOUNDRY_FORM_RETENTION_ACCEPTED_DAYS`,
`FOUNDRY_FORM_RETENTION_AUDIT_DAYS`, and
`FOUNDRY_FORM_RETENTION_BACKUP_DAYS` variables (maximum 3,650 days) to
override those defaults. Invalid values fail closed. Erasure replaces the field
payload with an empty object, records the reason, and cancels any unclaimed
delivery that could still expose the payload. If a delivery already holds an
active lease, erasure returns a conflict instead of falsely claiming the
payload is gone; retry after the delivery reaches a terminal state. Immutable
receipt, classification, and audit identity remain.

Once per day, the Worker snapshots authoritative form submissions,
classifications, delivery/outbox state, and audit facts. It encrypts each
snapshot with a fresh AES-256-GCM data key, wraps that key to the client's
RSA-OAEP recovery recipient, and writes only the envelope to the private
`FOUNDRY_FORM_BACKUPS` R2 bucket. Configure
`FOUNDRY_FORM_BACKUP_RECIPIENT` as the base64-encoded SPKI public key. Keep the
matching PKCS#8 private key outside Cloudflare and the repository in
client-controlled recovery custody. The Worker can encrypt backups but cannot
decrypt them. A D1 lease fences the complete save-and-record operation. Backup
attempts use the last recorded backup as a stable logical retry checkpoint and
write immutable per-lease R2 objects; D1 atomically promotes only the winning
object pointer. A stale or ambiguous writer therefore cannot overwrite the
recoverable checkpoint, and its unreferenced ciphertext remains subject to the
same expiry sweep. The online snapshot path rejects per-site estimates above 8
MiB before loading all rows into Worker memory. Encrypted objects expire after
30 days by default. Configure the private R2 bucket's prefix lifecycle to the
same number of days as `FOUNDRY_FORM_RETENTION_BACKUP_DAYS` (30 when unset) so
the provider-side backstop never shortens the selected retention window.

Restore is deliberately fail-closed and runs from a client-controlled operator
machine, not the Worker. Set a short-lived `CLOUDFLARE_API_TOKEN` with D1
read/write and R2 object-read access, then run:

```sh
npm run forms:restore --workspace @humber-foundry/reference-site -- \
  --account-id <cloudflare-account-id> \
  --primary-database-id <primary-d1-id> \
  --recovery-database-id <isolated-recovery-d1-id> \
  --bucket <private-r2-bucket> \
  --backup-id <backup-id> \
  --private-key-file </client-controlled/private-key.pem> \
  --actor-membership-id <active-owner-membership-id> \
  --confirm-backup-id <same-backup-id>
```

The command reads the PKCS#8 private key only from the named local file, never
sends it to Cloudflare, never writes decrypted content to disk, and removes its
encrypted temporary download before exiting. The explicit confirmation and
different primary/recovery database IDs are mandatory. It restores only into
`FOUNDRY_FORM_RECOVERY_DB`. The target must be empty, the encrypted object
metadata and ciphertext hash must verify, authenticated decryption must
succeed, and a row-for-row snapshot hash must match after the transaction. It
records sanitized counts and the integrity hash in the recovery database as
part of promotion, mirrors those facts to the primary database, and then
atomically clears the disposable recovery copy. A retry can reconcile an
uncertain promotion, finish the primary mirror, or finish cleanup without
misattributing the original actor. Restore does not perform serving cutover.
Online backup and restore use bounded snapshots and multi-row statements to
remain within Worker memory and the D1 Free invocation budget; a snapshot that
exceeds the 8 MiB online estimate fails before all rows are loaded or any
recovery rows are written and must use an operator-managed export/import.

### Resolve a ticket atomically

Use the resolver instead of separately commenting, editing the map and closing a
ticket:

```sh
node scripts/resolve-wayfinder-ticket.mjs \
  --issue 42 \
  --map 1 \
  --outcome-file /path/to/outcome.md \
  --map-entry-file /path/to/map-entry.md \
  --reason completed \
  --dry-run
```

Remove `--dry-run` after reviewing the plan. The command validates the native
parent-child relationship, records one recognizable outcome, inserts one
decision pointer, closes the ticket with the requested reason, and then reads
everything back from GitHub. Re-running it is safe: completed steps are detected
and skipped.

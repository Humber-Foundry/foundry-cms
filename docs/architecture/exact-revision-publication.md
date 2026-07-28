# Exact revision approval and publication

Issue #38 implements the publication transaction accepted in
[ADR-0004](../decisions/ADR-0004-draft-preview-publish-pipeline.md).

## Authority boundary

Only the protected human dashboard endpoint
`/api/foundry-cms/publications` creates approvals or starts publication.
Requests must pass Cloudflare Access identity verification, resolve to an
active Owner or Editor membership, pass the human mutation check, and carry a
stable idempotency key. MCP identities and integrations have no route or
application capability that can create approval.

The dashboard enables approval only after the human opens the canonical
preview for the current saved revision. The approval fingerprint binds:

- the complete Site Definition content hash;
- a structural design projection;
- schema and renderer versions;
- the exact production Git base and published-content hash;
- the deterministic serialized artifact;
- the `site` publication channel and serialization version; and
- a non-secret channel-configuration hash covering the GitHub App
  installation, repository, production ref, public origin, deployment signal,
  Cloudflare account, and build trigger.

Any later revision, production-base, or channel-configuration change makes
that evidence unusable before Git is contacted. Private-key and API-token
values are deliberately excluded. For secrets configured in the Workers build
trigger, Cloudflare's non-secret creation timestamp remains in the channel
fingerprint as a rotation version, so rotating one intentionally requires a
fresh preview and approval without exposing its value. D1 inserts the approval
only while the workspace still points to that revision, and publication
requires the command workspace to equal the approval workspace.

## Deterministic Git publication

Published site content lives at
`packages/site-definition/src/published-site.json`. The publisher writes
canonical key-sorted JSON with one trailing newline, creates one blob, one tree
based on the approved head, and one commit whose sole parent is that head. It
then updates the configured production ref with `force: false`. A moved ref is
blocked and is never silently rebased.

The client-owned GitHub App token is repository-limited and requests only
contents write, checks read, and statuses read. The commit has no custom author
or committer fields. Attribution uses the non-secret `Foundry-*` trailers
defined by ADR-0004.

## Durable status and live verification

D1 stores immutable approvals, separate invalidation records, publication
operations, and append-only status events. A partial unique index permits only
one active production publication across workspaces. Claim and initial audit
are one transaction. The workspace-scoped idempotency key is bound to a
canonical command identity covering the workspace, revision, approval,
fingerprint, and requesting human. Each successful state mutation writes a
fresh token, and its audit insert is conditional on that exact token, so a
losing compare-and-swap cannot append a fictional event even when timestamps
collide. Once a commit SHA is recorded, it may be repeated but never replaced.
The short commit lease atomically requires the approval to remain
uninvalidated and the approved revision to remain current; D1 fences new
revision inserts in that workspace until the Git result releases that lease,
while other workspaces remain editable. The five-minute lease covers the
complete bounded GitHub request sequence. Its holder renews the matching token
before Git work and again immediately before the bounded, non-force production
ref update. Every renewal rechecks that the exact approval remains
uninvalidated and its revision remains current. A stale holder cannot advance
the ref or persist its result. An expired lease is reconciled by publish ID
before it can
become failed; a recovered exact commit is durably recorded and releases the
lease before deployment polling. The stable publication key and commit
trailers support replay and ambiguous-result reconciliation without creating
another content commit. When Git returned a candidate SHA before the reference
result became ambiguous, reconciliation verifies that exact commit trailer and
its ancestry from the current production head instead of searching a bounded
history page. A not-found observation remains uncertain until the same
15-minute deadline. Refresh transitions compare the prior durable status and
update timestamp, while exact reconciled commit evidence cannot be erased by a
delayed not-found result. Reload recovery prioritizes any active
publication over newer terminal contenders. A later publish request first
reconciles that global active operation, so a crashed Worker does not require
someone to revisit the originating workspace before the slot can be released.
If either production-base check observes drift, the approval receives a
durable `production_changed` invalidation before the request is rejected.
Recovery runs before validating a later request's production base, allowing a
commit that advanced the ref just before a Worker crash to be discovered. The
retained candidate evidence is also preserved while channel-configuration
reads are unavailable, so a later recovery can reconcile the exact commit
instead of losing the only durable link to a possibly completed side effect.
If Git cannot resolve an ambiguous no-SHA result for 15 minutes, the operation
becomes terminal with explicit `git_reconciliation_timeout` evidence.

The status vocabulary is:

`requested → committed → building → deployed → verified-live`

`blocked`, `failed`, and `unknown` preserve terminal or uncertain outcomes.
A definite GitHub rejection before an ambiguous commit or ref result becomes
`failed`; only a transport outcome that may have created the commit or moved
the ref becomes `unknown`. Terminal publications never re-enter the active
state machine through ordinary status refresh.
A successful configured Cloudflare check reports only `deployed`. Foundry
reports `verified-live` only after two uncached reads of
`/.well-known/foundry-release.json` both exactly match the expected commit,
published-content hash, and schema version. If the deployment signal remains
requested, unknown, or building for 15 minutes—or a deployed release never
serves the exact marker in that window—the operation becomes `failed` with its
commit evidence preserved so it cannot hold the global publication slot
forever. A transport or non-success response while probing the marker is
retryable unavailability, not evidence that the approval's production base
mismatches; it is retried until the same bounded release-marker deadline, then
becomes `failed`. Each GitHub and marker request also has a 30-second transport
timeout.
An Editor or Owner can explicitly retry a failed deployment whose commit
remains the production head. Foundry first claims that retry durably, then asks
the Cloudflare Workers Builds API to build that exact branch and commit hash;
it does not create or move a Git commit. Immediately before that external
request, Foundry revalidates the exact approval and production head under the
claimed retry. An observed mismatch durably invalidates approval and releases
the claim without dispatch. The returned build UUID is stored with the
publication and polled through the Builds API, so an earlier failed GitHub
check cannot be mistaken for the new attempt. The stable publication and
protected human-mutation receipt prevent a repeated request from dispatching a
second build. If a Worker disappears while dispatching, the durable attempt
becomes uncertain after one minute and terminal after the same bounded
15-minute recovery window rather than holding the global publication slot
indefinitely.
Any later edit invalidates that retry authority; the newer revision must be
previewed and approved instead. A retained commit whose ref update was
ambiguous can be retried through the same explicit action. Foundry verifies its
publish trailer, sole expected parent, and sole exact content-file change
before attempting the non-force ref compare-and-swap again.
The commit carries an HMAC publication signature over its parent, content path,
content hash, and complete attribution message. The signing secret is shared
only by the CMS publisher and Workers Builds, so an ordinary pull request
cannot forge the Foundry trailers and enter the exact content deployment path.
The only accepted trigger deploy command is `npm run deploy`. Before building,
that shipped command rejects staged, unstaged, or non-ignored untracked source,
then runs `scripts/deploy-exact-production.mjs`. The controller requires the
local checkout, `WORKERS_CI_COMMIT_SHA`, and `origin`'s protected production
ref to agree before upload. OpenNext uploads a non-serving, commit-tagged
Worker version first. The controller then routes Wrangler's
activation API calls through a loopback gate and rechecks the same fence on the
actual Cloudflare `POST /deployments` request before forwarding it. It requires
exactly one bounded activation payload naming only the uploaded version at 100
percent, checks the fence after receiving that payload, and verifies the fence
again after success. The gate forwards token-bearing production requests only
to the fixed Cloudflare API origin; an ambient base-URL variable cannot redirect
them. After Wrangler exits, the controller closes request acceptance and drains
every in-flight handler before classifying the result. Before promotion it
records the currently serving deployment and traffic allocation. If an
activation response is lost, the
controller polls deployment history for up to 30 seconds before deciding
whether the promotion succeeded. Delayed history visibility is not treated as
proof that another deployment superseded the attempt. If the protected ref
moves after Cloudflare accepts the promotion, including an activation
recovered from a lost response, the controller restores the prior allocation
only when deployment history proves its stale deployment has been superseded.
Because Cloudflare does not expose a conditional deployment write, the
controller reconciles a lost rollback response before any retry. It also waits
for the compensating deployment to become visible and restores any newer
deployment that raced its rollback. Once the controller has recorded the one
permitted activation and the final production-head fence passes, a later
non-zero Wrangler exit cannot turn that observed activation into an ambiguous
failure. Every direct Cloudflare request and reconciliation loop uses its
remaining bounded timeout. A build compares its published-content path with
the live release marker: content may
advance only through one direct, signature-verified Foundry publication
commit. This quarantines a content commit whose earlier deployment failed so a
later code build cannot publish it without the exact retry. The activation
proxy accepts only the fingerprinted Cloudflare account and Worker script
path. Together these deployment-time fences prevent an older or unapproved
revision from becoming the public site after an external merge. The build
result is also rejected if Cloudflare reports a different commit hash.
The dashboard backs active polling off from 2.5 to 30 seconds, continues after
transient refresh failures, and keeps an active publication visible while the
editor starts a new draft. GitHub installation tokens are reused in memory
until shortly before expiry. Editor inputs are locked while an approval request
is in flight so its response cannot be attached to a changed local draft.

Publication GET requests only read the durable state and remain side-effect
free, including during GitHub credential rotation. Cloudflare/GitHub
reconciliation is a protected, idempotent POST mutation
with the same Origin and CSRF boundary as approval and publish.

## Runtime configuration

Set these non-secret values for each installation:

- `FOUNDRY_GITHUB_APP_ID`
- `FOUNDRY_GITHUB_INSTALLATION_ID`
- `FOUNDRY_GITHUB_OWNER`
- `FOUNDRY_GITHUB_REPOSITORY`
- `FOUNDRY_PRODUCTION_BRANCH` (defaults to `main`)
- `FOUNDRY_PUBLIC_ORIGIN` (the canonical HTTPS public-site origin)
- `FOUNDRY_DEPLOYMENT_CHECK_NAME` (defaults to `Cloudflare`)
- `FOUNDRY_CLOUDFLARE_ACCOUNT_ID`
- `FOUNDRY_CLOUDFLARE_SCRIPT_TAG` (the immutable Workers Builds
  `external_script_id`)
- `FOUNDRY_CLOUDFLARE_SCRIPT_NAME` (the Worker name used by Wrangler and the
  Workers Versions/Deployments API)
- `FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID`
- `FOUNDRY_PRODUCTION_BASE` (a bootstrap fallback Git object ID)

Store `FOUNDRY_GITHUB_PRIVATE_KEY`, `FOUNDRY_CLOUDFLARE_API_TOKEN`, the
standard build-time `CLOUDFLARE_API_TOKEN`, and the 32-byte-or-longer
`FOUNDRY_PUBLICATION_SIGNING_SECRET` only as Worker/Build secrets. The signing
secret must be identical in the publisher Worker and Workers Builds. The
Foundry-prefixed Cloudflare token needs the narrow account-scoped Workers CI
Edit permission (called Workers CI Write in Cloudflare's newer permission
vocabulary) used to trigger and inspect an exact manual build. The standard
Wrangler token must also read and write the configured Worker's deployments.
Never put these secrets, the GitHub App JWT, an installation token, or the
one-time baseline provisioning token in D1, logs, build output, or client
bundles.

Approval and every active refresh read the live Workers build trigger and its
environment-variable metadata. The channel fingerprint covers repository
identity, branch/path filters, build and deploy commands, root directory,
caching, and sorted non-secret environment values. Secret values remain
hidden; their Cloudflare creation timestamps act as rotation versions. A
missing trigger or unreadable configuration fails closed.

Cloudflare requires `wrangler deploy` for a Worker's first upload; its Versions
API cannot create that initial deployment. During installation, before enabling
CMS publication, an operator sets
`FOUNDRY_BASELINE_PROVISION_COMMIT_SHA` to the exact protected production head
and supplies a short-lived `FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN` with
administration permission to manage repository rulesets. The operator then
runs `npm run provision:deployment-baseline` once. The command creates and
reads back a temporary active repository ruleset targeting only the exact
production ref with the `update` restriction,
`update_allows_fetch_and_merge: false`, and no bypass actors; checks the local,
build, and remote commits; deploys only the configured account and Worker
name; checks the protected head again; and requires the exact authorized
commit in the live release marker before deleting the temporary ruleset and
verifying its absence. A normal first run refuses a pre-existing deployment. A
rerun discovers, validates, and reuses the exact retained ruleset rather than
creating a second lock. If that retained-lock rerun finds the initial
deployment already present, it reconciles the exact production head,
authorized content, and live release marker, then removes the lock without
redeploying. A lost deletion response is resolved by reading the ruleset: a
verified `404` completes release, while an unreadable result is reported as an
unverified unlock state. On a provisioning failure before release, the
retained ruleset must not be manually removed until the deployment and marker
are reconciled. Remove both one-time values afterward. Normal `npm run deploy`
requires that verified serving baseline and never falls back to an unguarded
first upload.

Workers Builds must expose `WORKERS_CI_COMMIT_SHA` during the build. Next
embeds it as `FOUNDRY_RELEASE_COMMIT_SHA` in the release marker. A build without
a valid Git object ID returns a fail-closed `503` marker and can never be
reported live. The embedded commit is also the renderer and production base
for newly opened workspaces; the configured fallback is used only before the
first build supplies that value.

Production branch protection must grant the installation-scoped publisher App
only the documented non-force publication bypass. Human code changes continue
through the normal pull-request rules.

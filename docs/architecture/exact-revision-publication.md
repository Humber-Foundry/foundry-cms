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
- the `site` publication channel and serialization version.

Any later revision or production-base change makes that evidence unusable
before Git is contacted.

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
one active production publication across workspaces. The stable publication
key and commit trailers support replay and ambiguous-result reconciliation
without creating another content commit.

The status vocabulary is:

`requested → committed → building → deployed → verified-live`

`blocked`, `failed`, and `unknown` preserve terminal or uncertain outcomes.
A successful configured Cloudflare check reports only `deployed`. Foundry
reports `verified-live` only after two uncached reads of
`/.well-known/foundry-release.json` both exactly match the expected commit,
published-content hash, and schema version.

## Runtime configuration

Set these non-secret values for each installation:

- `FOUNDRY_GITHUB_APP_ID`
- `FOUNDRY_GITHUB_INSTALLATION_ID`
- `FOUNDRY_GITHUB_OWNER`
- `FOUNDRY_GITHUB_REPOSITORY`
- `FOUNDRY_PRODUCTION_BRANCH` (defaults to `main`)
- `FOUNDRY_PUBLIC_ORIGIN`
- `FOUNDRY_DEPLOYMENT_CHECK_NAME` (defaults to `Cloudflare`)
- `FOUNDRY_PRODUCTION_BASE` (a bootstrap fallback Git object ID)

Store `FOUNDRY_GITHUB_PRIVATE_KEY` only as a Worker secret. Never put the
private key, GitHub App JWT, or installation token in D1, logs, build output, or
client bundles.

Workers Builds must expose `WORKERS_CI_COMMIT_SHA` during the build. Next
embeds it as `FOUNDRY_RELEASE_COMMIT_SHA` in the release marker. A build without
a valid Git object ID returns a fail-closed `503` marker and can never be
reported live. The embedded commit is also the renderer and production base
for newly opened workspaces; the configured fallback is used only before the
first build supplies that value.

Production branch protection must grant the installation-scoped publisher App
only the documented non-force publication bypass. Human code changes continue
through the normal pull-request rules.

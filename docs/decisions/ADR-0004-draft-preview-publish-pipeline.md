# ADR-0004: Draft, preview and publish pipeline

- **Status:** Accepted
- **Date:** 2026-07-26
- **Amended:** 2026-07-27 by issue #39

## Context

Foundry CMS needs one publication path for human and MCP edits while preserving
the boundary already fixed by the product map: D1 owns mutable drafts,
deterministic files in Git own published content, and Git history is the
published undo record.

The pipeline must let an editor recover work after a browser or network failure,
preview the exact saved revision with the same Next/React renderers used by the
public site, detect concurrent changes rather than silently overwrite them,
write one trustworthy Git commit, and report truthfully when that commit is
actually serving.

This decision follows the schema, editor, rich-text, repository and renderer
decisions in issues
[#9](https://github.com/Humber-Foundry/foundry-cms/issues/9),
[#10](https://github.com/Humber-Foundry/foundry-cms/issues/10),
[#11](https://github.com/Humber-Foundry/foundry-cms/issues/11),
[#14](https://github.com/Humber-Foundry/foundry-cms/issues/14), and
[#16](https://github.com/Humber-Foundry/foundry-cms/issues/16), and resolves
[issue #13](https://github.com/Humber-Foundry/foundry-cms/issues/13).

The mechanics rely on current first-party behavior:

- [D1 batches are transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
  and D1 sessions can preserve read-your-write consistency with bookmarks.
- [GitHub installation tokens expire after one hour](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
  and can be limited to one repository and the app's declared permissions.
- GitHub's GraphQL
  [`createCommitOnBranch`](https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch)
  mutation accepts an expected head, file changes and a message in one atomic
  branch update.
- [Workers Builds deploys on a Git push](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)
  and reports build state against the commit through a check run or commit
  status.

## Decision

Use a **revisioned D1 draft workspace, an authenticated canonical preview, one
atomic expected-head GitHub App commit, and a verified Cloudflare deployment**.

### Draft storage and recovery

- Each editing session opens or resumes a D1 draft workspace anchored to the
  currently live Git commit, site-schema version and renderer version.
- A workspace can contain all content, design and structural changes intended
  for one publication. It has a stable ID, owner, collaborators, base commit,
  current revision, canonical content hash and lifecycle state.
- Each accepted save creates an immutable revision containing the canonical
  changed-document snapshots and manifest. One D1 transaction advances the
  workspace pointer and stores the revision, actor, idempotency result and audit
  event.
- Every mutation carries `workspaceId`, `baseRevision`, stable schema identity
  and an idempotency key. The revision advances only when `baseRevision` still
  matches. A stale write returns a conflict with the latest revision; it never
  becomes last-write-wins.
- The client updates local editor state immediately, records unsent commands in
  an IndexedDB outbox, and autosaves after a short debounce and on blur. The UI
  distinguishes local changes, saving, saved revision and conflict.
- The server returns a D1 session bookmark after a save. Preview and subsequent
  draft reads carry that bookmark so enabling read replicas later cannot make
  an editor read behind their acknowledged write.
- A browser tab is only presence, never ownership. Heartbeats expire, but the
  D1 workspace does not. Reopening `/dash` lists open workspaces and resumes the
  last durable revision; the local outbox replays unacknowledged idempotent
  commands when safe.
- Explicit discard soft-archives a workspace for 30 days. An open workspace is
  not purged for inactivity. Published workspaces retain their approved
  revision, hashes, actor references and Git mapping as audit records while
  intermediate autosave snapshots may be compacted after 30 days.

V1 does not implement CRDTs, operational transforms or ProseMirror step
merging. Separate workspaces may proceed in parallel. Two actors sharing one
workspace use optimistic concurrency and must resolve a stale revision before
continuing.

### Preview and approval

There are two previews with distinct promises:

- The Puck iframe is the immediate interactive projection of local and saved
  editor state.
- The canonical approval preview is an authenticated, same-origin URL for one
  persisted `workspaceId + revision`.

The canonical preview route loads the immutable D1 revision through a draft
overlay content repository: changed documents come from D1 and unchanged
documents come from the published files bundled into the active deployment.
It renders the ordinary registered Next/React components and design system.
It does not run a build and it cannot preview schema-external code changes.

Cloudflare Access and application authorization protect the route. A
short-lived preview capability is bound to the authenticated actor, workspace
and revision; it is not a shareable public draft URL.

Approval records the draft revision and content hash, the schema version, and
the live renderer commit exposed by the current deployment. Any later edit,
conflict resolution, schema change or live-renderer change invalidates the
approval. A human publisher confirms the canonical preview. An MCP actor may
prepare the workspace but cannot create this approval for itself.

### Publication transaction

Publication is an idempotent, recoverable operation with a stable publish ID:

1. Authorize the publisher and verify the exact approval, schema, references,
   managed assets and deterministic serialization.
2. Verify that the repository branch head and live release marker still equal
   the renderer commit used for approval. If either advanced, mark the draft
   stale and require rebase/conflict review, a new canonical preview and a new
   approval.
3. Acquire a short D1 publication lease and record the publish operation before
   contacting GitHub. Only one operation may advance the production branch at a
   time.
4. Mint a fresh, repository-limited GitHub App installation token. Serialize
   every changed file and use GitHub's `createCommitOnBranch` mutation with the
   approved head as `expectedHeadOid`. The mutation atomically creates the
   one-parent commit and advances the production branch, or rejects the stale
   expected head without creating a second publication commit.
5. If the reference moved, do not retry against the new head automatically.
   Release the lease and return the workspace to stale review.
6. Reconcile an ambiguous network result before retrying. The commit message
   contains the publish ID, workspace ID, approved revision and content hash,
   so a retry can find an already-created commit and never create a duplicate
   publication.
7. Store the resulting commit SHA and transition the operation from
   `committing` to `building`. D1 is operational state; the Git commit is the
   published content record.

No per-file Content API calls are used: all changed files land in one atomic
commit-on-branch mutation, so one approval creates one Git revision and one
build trigger.

This issue #39 amendment supersedes the original step 4 implementation detail
that created blobs, a tree and a commit before a separate non-force ref update.
That two-write boundary could leave a successful commit object orphaned with no
returned SHA after transport loss. The accepted authority, attribution,
single-parent, expected-head, no-silent-rebase and one-commit invariants remain
unchanged; the atomic mutation strengthens their recoverability.

Published restoration reads a historical Git revision into a new D1 workspace.
It then follows the same preview, approval and publication path and creates a
new commit; branch history is never rewritten.

### GitHub credential and commit identity

Each installation uses a **client-owned GitHub App**, created during guided
provisioning with GitHub's
[App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
and installed only on that site's repository.

The app requests only:

- Metadata read;
- Contents read/write;
- Checks read; and
- Commit statuses read.

It does not request Actions, Workflows, Administration or access to other
repositories. Its app ID, installation ID and private key live only in
client-owned Worker secrets. The private key, JWT and short-lived installation
tokens never enter D1, browser code, logs or Git.

The commit is authored and committed by the GitHub App bot without custom
author or committer fields so GitHub can
[verify the bot signature](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#signature-verification-for-bots).
This avoids falsely claiming that one person authored a commit assembled from
several human or agent revisions.

Truthful attribution is carried by stable, non-secret commit trailers:

```text
Foundry-Publish-Id: <uuid>
Foundry-Workspace: <uuid>
Foundry-Revision: <integer>
Foundry-Approved-By: <installation-local member id>
Foundry-Contributors: <installation-local actor ids>
Foundry-Content-Hash: <sha256>
```

D1 resolves those opaque actor IDs to the human, MCP connection or integration
and retains the complete edit/approval audit. Public commit metadata does not
expose email addresses or impersonate a GitHub user. A site may omit contributor
IDs from a public repository and retain them only in the D1 audit, but it must
always keep the publish ID, revision and content hash needed for reconciliation.

The production branch ruleset grants the publisher app a narrowly documented
bypass for its direct, non-force update. Human code changes continue through
the repository's normal pull-request rules. Provisioning fails closed if the
app cannot write the configured production branch or if force pushes are
allowed for the app.

### Build and truthful live status

The production branch is connected to Cloudflare Workers Builds. One successful
reference update triggers one build; saving and previewing trigger none.
Identical publish requests return the existing operation and do not create
another commit or build.

The build embeds Cloudflare's `WORKERS_CI_COMMIT_SHA`, the site-schema version
and the deterministic published-content hash into
`/.well-known/foundry-release.json`. The endpoint contains no secret or draft
data.

The dashboard exposes these states:

- `Saving draft`
- `Ready to publish`
- `Creating commit`
- `Waiting for build`
- `Building`
- `Verifying deployment`
- `Live`
- `Failed` or `Stale`

The deployment adapter reads the Cloudflare check run or commit status through
the GitHub App. Failure shows a stable error and a link to client-owned build
details. A successful check only means the build succeeded; Foundry says
**Live** only after the site's release endpoint returns the expected commit SHA
and content hash on repeated uncached reads. A timeout remains `Verifying` or
`Failed` and never claims success.

The default blocks another production publish while one is committing or
building. After failure, an Owner or Editor may retry the same Git commit's
deployment without creating a new content commit, or revise the draft and
produce a new approved commit.

### Concurrent changes

- Same-workspace races fail at the D1 revision compare-and-swap.
- Parallel workspaces remain independent until publication.
- Any production-branch advance invalidates an older approval, even when its
  changed file paths appear disjoint. The new branch may contain renderer or
  schema behavior the editor has not previewed.
- Rebase is a domain operation, not a Git merge hidden from the user. Foundry
  performs a three-way comparison by stable document, item and field identity,
  applies non-conflicting changes to a new draft revision, and presents
  overlapping changes for explicit choice.
- Rebase, conflict resolution and any change to the resulting content hash
  require a fresh canonical preview and approval.

## Consequences

- Draft work survives tab closure, browser crashes and transient network loss,
  with the last server-confirmed revision always explicit.
- Preview is fast because it reads D1 instead of rebuilding, while approval is
  still bound to the exact renderer and data that the user saw.
- One publication creates one atomic, verified bot commit and normally one
  Cloudflare build.
- Git and D1 have a deliberate recoverable consistency gap. The publish ID and
  reconciliation state are required because Git may accept a commit before the
  Worker records the response.
- Editors must re-preview after any production-head change. This is stricter
  than automatic non-overlapping Git rebases but prevents approval from being
  applied to an unpreviewed renderer.
- The client must own and protect a GitHub App private key. Guided provisioning,
  rotation, revocation and a publishing health check are required.
- The default pipeline waits for a full static rebuild per publish. Incremental
  or direct runtime content delivery can be added only as a new deployment
  adapter without changing D1 draft, approval or Git authority.

## Alternatives considered

- **Fine-grained personal access token** — rejected as the default because it is
  tied to a person, is manually rotated, and cannot provide the same
  installation-scoped bot identity. It may be a documented emergency recovery
  mechanism, never ordinary runtime configuration.
- **GitHub App user access token per publisher** — rejected because publishing
  must also work for approved MCP and scheduled operations, and Git identity
  would misleadingly collapse multi-actor work into the final button click.
- **One Git commit per autosave** — rejected because it makes private drafts
  public repository history and triggers excessive builds.
- **Preview branch and Cloudflare preview deployment per save** — rejected
  because build latency makes keystroke-to-preview editing impractical and
  exposes more draft artifacts outside D1.
- **Direct D1-to-production rendering** — rejected because it makes Git cease to
  be authoritative for published state.
- **Automatic last-write-wins or silent Git rebase** — rejected because either
  loses edits or publishes against a renderer the approver did not see.
- **Claim live when Git accepts the commit or the build check succeeds** —
  rejected because neither proves that the expected version is serving at the
  public hostname.

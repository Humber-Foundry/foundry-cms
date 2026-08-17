# ADR-0015: The framework/installation-owned seam and three-way foundation sync

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

An installation is created once by the `foundry-reference-site` scaffold. The
scaffold copies the foundation's framework template — `app/`, `components/`,
`src/`, `migrations/`, `public/`, `foundry/` and a fixed set of root config
files — into the installation with a write-if-absent (`wx`) flag. The scaffold
therefore only ever creates files; it never updates one.

That left no sanctioned way to bring an existing installation's framework source
up to a newer pinned foundation release. To adopt a new release an operator had
to hand-merge framework files. That is slow, error-prone and silently drops
work: a whole dashboard-editor architecture was missed in one such manual
upgrade. It also contradicts `docs/agents/client-installations.md`, which states
that code flows one way, product to installation, through a release and an
updated pin.

`release:prepare` already produces a signed foundation release descriptor
(`.foundry-foundation-release.json` / `foundation-release.json`) that records the
source revision, package integrity, compatibility and the migration list. What
it did not record was which framework files the release contains and what each
one's bytes are. Without that a sync command cannot tell an installation's local
change apart from a foundation change.

This decision covers the source-sync half of the upgrade story in issue #62 and
resolves issue #128. It does not cover vendoring the new packages or the
provider-side upgrade ceremony; those remain the operator flow's responsibility.

## Decision

### 1. The framework/installation-owned seam

Every scaffolded path is one of two kinds, and the two kinds are managed by
different owners.

- **Framework source** is the foundation's code. The release owns it. Sync may
  overwrite, add or remove it. It is exactly the set the scaffold's
  `isTemplatePath` classifies: everything under `app/`, `components/`, `src/`,
  `migrations/`, `public/` and `foundry/`, plus the named root config files
  (`custom-worker.ts`, `cloudflare-email.d.ts`, `next-env.d.ts`,
  `next.config.ts`, `open-next.config.ts`, `wrangler.jsonc`,
  `wrangler.recovery.jsonc`).
- **Installation-owned work** is the client's. Sync must never write, remove or
  report a conflict on it. It is three things:
  1. everything under `foundry/` — the Site Definition, page-component registry,
     published content and forms the installation edits through Foundry;
  2. any file under `public/` that the release does not ship — the client's
     media; and
  3. any file the release does not list at all.

`foundry/` is the one overlap: the scaffold seeds it once, create-only, so a new
installation has a working starting point, but from then on the installation
owns it. The release descriptor's framework manifest therefore lists `foundry/`
paths (they are part of what the scaffold lays down), and sync skips every
`foundry/` path so it can never overwrite installation content. `public/` and
"any unlisted file" need no special case: sync only ever visits paths in the
manifest, so a client media file or any other unlisted file is never touched.

`release:prepare` records this set as a **framework manifest** in the descriptor:
one entry per framework path in the packed reference-site tarball, each with its
sha256, derived from the exact tarball bytes through the same `isTemplatePath`
the scaffold uses. The manifest is the third input the sync needs; the existing
artifact and migration integrity fields are unchanged.

### 2. The three-way reconciliation rule

Sync compares three sides for each framework path: the installation's current
file, the file in the release the installation is pinned to (the **old**
manifest, read from the installation's current
`.foundry-foundation-release.json`), and the file in the **target** release (the
**new** manifest). For each path:

| Installation vs old | Changed in target | Action |
|---|---|---|
| Same as old release | Yes | **Overwrite** with the target's file |
| Same as old release | No | Nothing; already current |
| Locally modified | No (target unchanged) | **Keep the local override** |
| Locally modified | Yes | **Conflict**: keep the installation's file, record it |
| Absent locally | Present in target | **Add** |
| Present, same as old | Removed in target | **Remove** |
| Present, locally modified | Removed in target | **Report, do not delete** |

A conflict is the safe-default failure. Sync leaves the installation's file in
place, records the conflict with its path, and **exits non-zero unless the
operator passes `--accept-conflicts`**. Fail closed: an unreviewed conflict never
advances the installation. When conflicts are accepted, they are still reported
and their files are still left local for manual resolution.

Migrations are stricter, because a migration is immutable history. Sync is
additive-only: it adds a migration the installation does not have, keeps every
migration byte-for-byte, never deletes a past migration the target no longer
lists, and **fails closed — even with `--accept-conflicts` — if an
already-present migration does not match the target's bytes**, because that means
corruption or tampering, not a local edit.

After a clean, conflict-free sync the installation's framework files are
byte-identical to the target release's template, its `.foundry/*` pin files and
`package-lock.json` name the target, and typecheck and build pass. Sync verifies
the target's artifacts and descriptor digest with the operator's
`loadFoundationReleaseDescriptor` and `verifyFoundationReleaseArtifacts` — the
same trust checks the scaffold uses — and refuses to write anything until the
vendored release is the locked executable.

## Consequences

- Adopting a new release is one command, not a hand-merge. Installation work is
  preserved by construction, and a genuine collision stops the sync instead of
  being silently overwritten.
- The pure three-way rule lives in `@humber-foundry/operator`
  (`planFoundationSync`), so every branch is unit-tested without a filesystem.
  The scaffold, sync command and `release:prepare` share one `isTemplatePath`
  and one tar reader; none is forked.
- An installation pinned to a release that predates the framework manifest
  cannot be three-way synced, because it has no old manifest. Sync fails closed
  with a clear error rather than guessing.
- The descriptor now has a required `framework` field. Every release the new
  `release:prepare` produces carries it; the descriptor parser rejects a
  descriptor without it, and rejects a manifest path that is not a well-formed
  member of the framework set.

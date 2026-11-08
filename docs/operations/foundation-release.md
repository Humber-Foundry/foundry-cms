# Foundation release

The four public Foundry packages are one synchronized release. A version is not
usable when only some packages exist, when their bytes differ from the release
descriptor, or when the descriptor names a different source revision.

## Prepare and verify

From a clean checkout of the intended commit:

```sh
npm ci
npm run release:prepare
npm run release:verify
```

Preparation packs `@humber-foundry/operator`, `@humber-foundry/reference-site`,
`@humber-foundry/application`, and `@humber-foundry/site-definition` at the root version. It
then generates `foundation-release/foundation-release.json` from the tarball
bytes and current commit. The descriptor records SHA-512 npm integrity,
SHA-256, byte size, Node/npm compatibility, every migration checksum, a
framework manifest of every framework path with its SHA-256, the source
revision, and workflow provenance. The companion `foundation-release.sha256`
binds consumers to the exact descriptor bytes.

The framework manifest is every path in the packed reference-site tarball that
the scaffold's `isTemplatePath` classifies as framework source — everything
under `app/`, `components/`, `src/`, `migrations/`, `public/` and `foundry/`,
plus the named root config files, `tsconfig.json` among them. It is what lets
an installation be synced to a newer release without a hand-merge.

The reference site's own `tsconfig.json` extends the workspace configuration,
so preparation packs a generated installation `tsconfig.json` in its place.
That file already holds every setting Next.js requires or suggests, so
`next build` leaves it unchanged. Its `jsx` setting is `react-jsx`, so an
installation that adds Vitest can run its own `.tsx` tests. Verification fails
with `foundation_scaffold_tsconfig_rewritten_by_build` if the build changes
it.

Verification creates a new temporary directory outside the workspace. It
installs the four tarballs, generates a lockfile, rejects workspace links,
loads the compiled operator, makes the reference-site scaffolder verify every
tarball before copying, typechecks and builds the site, builds the OpenNext
Worker, and runs `wrangler deploy --dry-run`. No Cloudflare, GitHub, npm, or
client credential is read by this verification.

The install adds no npm overrides, the same as a new installation's first
install. Puck and the tiptap starter kit depend on tiptap packages with open
ranges. Tiptap packages need exactly matching versions of each other. So the
reference-site package lists every resolved `@tiptap/*` package at one exact
version. The scaffold and sync write that set as the installation's overrides.
The scaffold stops with `foundation_release_tiptap_version_drift` when the
lockfile resolves a tiptap package at a version other than its
`@tiptap/core`. It stops with `foundation_release_tiptap_core_missing` when
the lockfile has tiptap packages but no `@tiptap/core`. An installation can
add its own tiptap package at the core version. The sync does not run these
checks. Before a sync, the lockfile still reflects the previous release's
overrides, so the checks could block the sync that replaces them.

A Puck or tiptap upgrade can add a tiptap package. Add that package to
`apps/reference-site/package.json` at the shared version. The
`foundation-release-lib` test fails until you do.

## Sync an installation to a newer release

The scaffold copies a release's framework source into a new installation once,
create-only; it never updates a file. To bring an existing installation up to a
newer release, use the sync command. It is the counterpart to the scaffold and
ships in the reference-site package as the `foundry-reference-site-sync` bin.

First vendor the target release's packages in the installation, so its
`package-lock.json` names the target. The sync refuses to write until all four
target packages are locked: same version, same file and same `sha512-`
integrity as the target's descriptor.

An installation often vendors the four tarballs at a fixed path and version,
for example `vendor/humber-foundry-reference-site-0.1.0.tgz`. A newer release
at the same version replaces their bytes at the same path. A plain
`npm install` does not read the new bytes. It keeps the old `integrity` in
`package-lock.json`, and it keeps or restores the old code in `node_modules`
from npm's cache. Deleting `node_modules` does not help. So, after you copy the
new tarballs into place, install them by name:

```sh
npm install \
  ./vendor/humber-foundry-application-<version>.tgz \
  ./vendor/humber-foundry-operator-<version>.tgz \
  ./vendor/humber-foundry-reference-site-<version>.tgz \
  ./vendor/humber-foundry-site-definition-<version>.tgz
```

Use the paths your `package.json` names. This command reads each tarball,
writes its real `sha512-` integrity to `package-lock.json` and installs its
code in `node_modules`. No hand editing of the lock is needed.

If you skip this step, the sync stops with `foundation_sync_lock_stale` and
lists the packages. This happens when a lock entry names the target version
and file, and the vendored file holds the target's bytes, but the entry still
holds an older integrity. The error prints the exact `npm install` command
for the stale tarballs. Run it in the installation directory, then run the
sync again. Any other mismatch stops the sync with
`foundation_scaffold_executable_not_locked`. That means the vendored files are
not the target release, so vendor them again.

Then run the sync:

```sh
foundry-reference-site-sync \
  --target <installation-directory> \
  --descriptor <path>/foundation-release.json \
  --descriptor-digest "$(cat <path>/foundation-release.sha256)" \
  --artifacts <path>/artifacts
```

The sync verifies the target's artifacts and descriptor digest with the
operator, reads the installation's current pin for the release it is on, and
reconciles every framework path three ways — the installation's current file,
the pinned old release and the target. For each path it either overwrites a file
the installation never changed, keeps a local override the target did not
change, adds a new file, removes an unmodified deletion, or records a **conflict**
when the file changed both locally and in the target. A conflict leaves the
installation's file in place and the command **exits non-zero**; pass
`--accept-conflicts` only after reviewing the reported paths to let the pins
advance with the conflicts left local for manual resolution. It never touches
installation-owned paths: everything under `foundry/`, client media under
`public/` the release does not ship, and any file not in the manifest.

Migrations are additive-only: the sync adds new migrations, keeps every existing
one byte-for-byte, never deletes a past migration, and fails closed if an
already-present migration does not match the target's bytes.

`tsconfig.json` is framework source, so the same three-way rule applies to it.
An installation that changed its `tsconfig.json` keeps the change: the report
shows it as `keep` when the target did not change the file, or as a
`conflict` when the target did. A release before issue #139 did not list
`tsconfig.json`. When you sync from such a release, an installation's
`tsconfig.json` that differs from the target's is a conflict. Review it, then
pass `--accept-conflicts` to keep the installation's file.

The sync also writes the target release's build scripts, engines and tiptap
overrides to the installation's `package.json`, and it moves the release pins
(`.foundry-foundation-release.json`, and `.foundry/installation.json` when it
exists) to the target. Run `npm install` after the sync, so the lockfile moves
to the target's tiptap set. The sync never writes `package-lock.json`. Only
npm writes it, in the install before the sync and in the install after it.

The command prints a report with one line for every file it writes, adds or
removes, every local override it keeps and every conflict, with its path.
`package.json` and the pin files appear as `write` lines when their bytes
change. The summary counts every write and removal. The sync never changes a
file that the report does not name, so after a sync `git status` lists only
files the report names, plus any you changed yourself. After a clean,
conflict-free sync and `npm install`, the installation's framework files are
byte-identical to the target's template, its `.foundry/*` pin files and
`package-lock.json` name the target, and typecheck and build pass. See
[ADR-0015](../decisions/ADR-0015-foundation-framework-sync-seam.md).

## Publication boundary

Publication is intentionally unavailable through an ordinary local command.
An owner dispatches the **Foundation release** workflow from `main`, supplies
the exact version, types `publish`, and approves the protected
`foundation-release` environment. That workflow repeats preparation and the
clean external verification before publishing. The workflow
publishes missing artifacts, verifies registry integrity after each package,
installs the published packages in an isolated directory, and has the published
operator verify npm's cryptographically checked Sigstore/SLSA attestations
against the exact repository, workflow, commit and tarball digests. It then
creates a GitHub release containing the descriptor, checksum and exact tarballs.
An existing release is downloaded and compared byte-for-byte before a retry may
accept it. A retry may resume a partial registry publication only when every
already-published tarball has the descriptor's exact integrity; any conflict
fails closed.

The workflow itself queries the GitHub API and fails unless the repository
environment requires at least one reviewer, prevents self-review, and disables
administrator bypass. The live environment permits only `main`. The first
registration of these package names is a one-time exception because npm cannot
configure a trusted publisher until a package already exists. For that first
run only, an owner creates a short-lived granular npm token with publish access
to the `@humber-foundry` scope, stores it as the `NPM_BOOTSTRAP_TOKEN` secret on the
protected environment, and selects `bootstrap`. The workflow refuses bootstrap
after all four package names exist. Immediately after that run, the owner
configures this repository and `foundation-release.yml` as the trusted
publisher on each npm package, deletes the environment secret, and revokes the
token. Every later run selects `trusted`; the workflow refuses that mode until
all package names exist and refuses it if any npm token is present. No npm token
belongs in repository secrets or remains after bootstrap.

## Verify a published release

Download all assets from `foundation-v<VERSION>` into an empty directory. Check
the descriptor bytes first, then each artifact:

```sh
node -e "const fs=require('node:fs'),c=require('node:crypto');const s=fs.readFileSync('foundation-release.json');const got='sha256:'+c.createHash('sha256').update(s).digest('hex');const want=fs.readFileSync('foundation-release.sha256','utf8').trim();if(got!==want)process.exit(1)"
node -e "const fs=require('node:fs'),c=require('node:crypto'),d=require('./foundation-release.json');for(const a of Object.values(d.artifacts)){const b=fs.readFileSync(a.filename),i='sha512-'+c.createHash('sha512').update(b).digest('base64');if(i!==a.integrity||b.length!==a.size)process.exit(1)}"
VERSION="$(node -p "require('./foundation-release.json').version")"
npm install "@humber-foundry/application@$VERSION" "@humber-foundry/operator@$VERSION" "@humber-foundry/reference-site@$VERSION" "@humber-foundry/site-definition@$VERSION"
npm audit signatures --json --include-attestations > npm-provenance.json
node -e "Promise.all([import('@humber-foundry/operator'),require('node:fs').promises.readFile('foundation-release.json','utf8'),require('node:fs').promises.readFile('npm-provenance.json','utf8')]).then(([o,d,a])=>o.assertFoundationReleaseNpmProvenance({descriptor:JSON.parse(d),auditSource:a}))"
```

The #59 operator flow must pin the descriptor digest in its reviewed plan and
pass the descriptor and tarball directory to `foundry-reference-site`. The
scaffolder refuses to write any site file until the operator has verified all
four artifact bytes.

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
plus the named root config files. It is what lets an installation be synced to a
newer release without a hand-merge.

Verification creates a new temporary directory outside the workspace. It
installs the four tarballs, generates a lockfile, rejects workspace links,
loads the compiled operator, makes the reference-site scaffolder verify every
tarball before copying, typechecks and builds the site, builds the OpenNext
Worker, and runs `wrangler deploy --dry-run`. No Cloudflare, GitHub, npm, or
client credential is read by this verification.

## Sync an installation to a newer release

The scaffold copies a release's framework source into a new installation once,
create-only; it never updates a file. To bring an existing installation up to a
newer release, use the sync command. It is the counterpart to the scaffold and
ships in the reference-site package as the `foundry-reference-site-sync` bin.

First vendor the target release's packages in the installation, so its
`package-lock.json` names the target — the sync refuses to write until the
target is the locked executable, exactly as the scaffold does. Then run:

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

The command prints a report of every file written, added, removed, kept as an
override and every conflict with its path. After a clean, conflict-free sync the
installation's framework files are byte-identical to the target's template, its
`.foundry/*` pin files and `package-lock.json` name the target, and typecheck
and build pass. See
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

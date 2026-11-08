#!/usr/bin/env node

// Foundation source sync — the counterpart to the one-time scaffold.
//
// The scaffold lays a release's framework files into a new installation once,
// create-only. This command updates an existing installation to a newer target
// release, reconciling every framework path three ways (installation vs the
// pinned old release vs the target) so installation-owned work is preserved.
// See docs/decisions/ADR-0015-foundation-framework-sync-seam.md.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLockedReleaseExecutable,
  installationPackageText,
  isTemplatePath,
  parseReleaseArguments,
  tarEntries,
} from "./foundation-release-lib.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releasePinNote = "release pin";

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Returns the bootstrap manifest with its foundation pin moved to the target
// release, or `null` when the installation has no bootstrap manifest.
async function bootstrapManifestWithPin({ target, descriptor, digest }) {
  const manifestPath = join(target, ".foundry/installation.json");
  if (!(await fileExists(manifestPath))) return null;
  const { parseBootstrapManifest, serializeBootstrapManifest } = await import(
    "@humber-foundry/operator"
  );
  const current = await parseBootstrapManifest(await readFile(manifestPath, "utf8"));
  const updated = {
    ...current,
    foundationRelease: { version: descriptor.version, digest },
  };
  // Re-parse to re-derive and re-validate every field before writing it back.
  const validated = await parseBootstrapManifest(JSON.stringify(updated));
  return serializeBootstrapManifest(validated);
}

async function main() {
  const options = parseReleaseArguments(process.argv.slice(2), {
    required: ["target", "descriptor", "descriptor-digest", "artifacts"],
    booleans: ["accept-conflicts"],
  });
  const target = resolve(options.target);
  const artifactDirectory = resolve(options.artifacts);
  const descriptorPath = resolve(options.descriptor);
  const acceptConflicts = options["accept-conflicts"] === true;

  const descriptorSource = await readFile(descriptorPath, "utf8");
  const actualDigest = Buffer.from(
    `sha256:${createHash("sha256").update(descriptorSource).digest("hex")}`,
  );
  const expectedDigest = Buffer.from(options["descriptor-digest"]);
  if (
    actualDigest.length !== expectedDigest.length ||
    !timingSafeEqual(actualDigest, expectedDigest)
  ) {
    throw new Error("foundation_release_descriptor_digest_mismatch");
  }

  const untrustedDescriptor = JSON.parse(descriptorSource);
  // The target packages must already be vendored — same trust check the
  // scaffold uses — so the installation cannot advance its pin past the code it
  // actually runs.
  const lock = JSON.parse(await readFile(join(target, "package-lock.json"), "utf8"));
  for (const name of ["@humber-foundry/operator", "@humber-foundry/reference-site"]) {
    assertLockedReleaseExecutable({ descriptor: untrustedDescriptor, lock, name });
  }

  const {
    loadFoundationReleaseDescriptor,
    parseFoundationReleaseDescriptor,
    reconcileFoundationFramework,
    verifyFoundationReleaseArtifacts,
  } = await import("@humber-foundry/operator");

  const descriptor = await loadFoundationReleaseDescriptor({
    descriptorPath,
    expectedDigest: options["descriptor-digest"],
  });

  // The installation's current pin gives the OLD release's framework manifest,
  // the third side of the comparison. An installation pinned to a release that
  // predates the framework manifest cannot be three-way synced.
  const pinPath = join(target, ".foundry-foundation-release.json");
  let oldDescriptor;
  try {
    oldDescriptor = parseFoundationReleaseDescriptor(
      await readFile(pinPath, "utf8"),
    );
  } catch {
    throw new Error("foundation_sync_installation_pin_unusable");
  }

  const artifactBytes = new Map();
  await verifyFoundationReleaseArtifacts({
    descriptor,
    readArtifact: async (filename) => {
      const bytes = await readFile(join(artifactDirectory, filename));
      artifactBytes.set(filename, bytes);
      return bytes;
    },
  });

  const referenceArtifact = descriptor.artifacts["@humber-foundry/reference-site"];
  const entries = tarEntries(artifactBytes.get(referenceArtifact.filename));
  const targetFiles = new Map();
  for (const [path, bytes] of entries) {
    if (isTemplatePath(path)) targetFiles.set(path, bytes);
  }

  // Every file the sync writes besides framework source. The operator writes
  // them after the framework files, only when their bytes change, and names
  // each write in the report. The pins come last, so an interrupted sync never
  // advances a pin past files it has not written.
  const derivedFiles = [
    {
      path: "package.json",
      bytes: Buffer.from(
        await installationPackageText({ target, descriptor, packageRoot }),
      ),
      note: "build configuration from target release",
    },
    {
      path: ".foundry-foundation-release.json",
      bytes: Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`),
      note: releasePinNote,
    },
  ];
  const bootstrapManifest = await bootstrapManifestWithPin({
    target,
    descriptor,
    digest: options["descriptor-digest"],
  });
  if (bootstrapManifest !== null) {
    derivedFiles.push({
      path: ".foundry/installation.json",
      bytes: Buffer.from(bootstrapManifest),
      note: releasePinNote,
    });
  }

  // The operator is the only writer: this command never writes an
  // installation file itself, so the report names every file the sync changed.
  const { plan, report } = await reconcileFoundationFramework({
    installationDir: target,
    targetFiles,
    oldFiles: oldDescriptor.framework.files,
    newFiles: descriptor.framework.files,
    derivedFiles,
    acceptConflicts,
  });

  process.stdout.write(report);

  if (plan.blocked) {
    // Fail closed. No file, build configuration or pin is advanced while a
    // conflict is unresolved or a migration does not match.
    if (plan.migrationMismatches.length > 0) {
      throw new Error("foundation_sync_migration_mismatch");
    }
    throw new Error("foundation_sync_conflicts_unresolved");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

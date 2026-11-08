import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  changedPaths,
  installationFileHashes,
} from "../apps/reference-site/scripts/installation-file-changes.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseDirectory = join(root, "foundation-release");

function command(name, args, cwd, env) {
  execFileSync(name, args, { cwd, stdio: "inherit", env });
}

// Returns the failed command's stderr.
function expectCommandFailure(name, args, cwd, env, expected) {
  try {
    execFileSync(name, args, { cwd, encoding: "utf8", env });
  } catch (error) {
    if (String(error.stderr).includes(expected)) return String(error.stderr);
    throw error;
  }
  throw new Error("foundation_release_negative_test_did_not_fail");
}

// Directories a build or install creates. They are not files the sync owns.
const generatedDirectories = [
  ".foundry-verification-home",
  ".next",
  ".open-next",
  ".wrangler",
  "node_modules",
];

async function main() {
  const descriptor = JSON.parse(
    await readFile(join(releaseDirectory, "foundation-release.json"), "utf8"),
  );
  const digest = (
    await readFile(join(releaseDirectory, "foundation-release.sha256"), "utf8")
  ).trim();
  const target = await mkdtemp(join(tmpdir(), "foundry-foundation-release-"));
  try {
    const isolatedHome = join(target, ".foundry-verification-home");
    const npmUserConfig = join(isolatedHome, ".npmrc");
    await mkdir(isolatedHome, { recursive: true });
    await writeFile(npmUserConfig, "registry=https://registry.npmjs.org/\nprovenance=false\n");
    const env = {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      CI: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      NPM_CONFIG_USERCONFIG: npmUserConfig,
      NPM_CONFIG_CACHE: join(isolatedHome, "npm-cache"),
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    };
    const dependencies = Object.fromEntries(
      Object.entries(descriptor.artifacts).map(([name, artifact]) => [
        name,
        `file:${join(releaseDirectory, "artifacts", artifact.filename)}`,
      ]),
    );
    // No overrides: this is a client's first install, before the scaffold
    // writes any. The release artifacts alone must resolve one tiptap set.
    await writeFile(
      join(target, "package.json"),
      `${JSON.stringify(
        {
          name: "foundry-foundation-external-verification",
          version: "0.0.0",
          private: true,
          type: "module",
          scripts: {},
          dependencies,
        },
        null,
        2,
      )}\n`,
    );
    command("npm", ["install", "--package-lock-only=false", "--ignore-scripts=false"], target, env);
    const scaffoldCommand = join(target, "node_modules/.bin/foundry-reference-site");
    const scaffoldArguments = [
        "--target",
        target,
        "--descriptor",
        join(releaseDirectory, "foundation-release.json"),
        "--descriptor-digest",
        digest,
        "--artifacts",
        join(releaseDirectory, "artifacts"),
      ];
    const lockPath = join(target, "package-lock.json");
    const originalLock = await readFile(lockPath, "utf8");
    const mismatchedLock = JSON.parse(originalLock);
    mismatchedLock.packages["node_modules/@humber-foundry/reference-site"].integrity =
      `sha512-${Buffer.alloc(64).toString("base64")}`;
    await writeFile(lockPath, `${JSON.stringify(mismatchedLock, null, 2)}\n`);
    expectCommandFailure(
      scaffoldCommand,
      scaffoldArguments,
      target,
      env,
      "foundation_scaffold_executable_not_locked:@humber-foundry/reference-site",
    );
    await writeFile(lockPath, originalLock);
    command(scaffoldCommand, scaffoldArguments, target, env);
    await readFile(
      join(
        target,
        "app/%5F%5Ffoundry/preview/[workspaceId]/[revision]/page.tsx",
      ),
    );
    const browserSafeSiteDefinition = await readFile(
      join(target, "foundry/site-definition.ts"),
      "utf8",
    );
    const serverOnlySiteDefinition = await readFile(
      join(target, "foundry/site-definition.server.ts"),
      "utf8",
    );
    const installationGuide = await readFile(
      join(target, "foundry/README.md"),
      "utf8",
    );
    const scaffoldedSite = JSON.parse(
      await readFile(join(target, "foundry/published-site.json"), "utf8"),
    );
    if (
      !browserSafeSiteDefinition.includes("installedSiteDefinition") ||
      browserSafeSiteDefinition.includes('import "server-only"') ||
      !serverOnlySiteDefinition.includes('import "server-only"') ||
      !installationGuide.includes("client repository's boundary") ||
      scaffoldedSite.site.id !== "site_client_installation" ||
      scaffoldedSite.site.navigation.length !== 0 ||
      scaffoldedSite.home.sections.length !== 0 ||
      (scaffoldedSite.blog !== undefined &&
        scaffoldedSite.blog.posts.length !== 0) ||
      JSON.stringify(scaffoldedSite).includes("Foundry Reference")
    ) {
      throw new Error("foundation_scaffold_site_definition_seams_invalid");
    }
    command("npm", ["run", "build:operator"], target, env);
    command("npm", ["run", "typecheck"], target, env);
    command("npm", ["run", "build"], target, env);
    command("npm", ["run", "smoke:deployment"], target, env);

    // The shipped tsconfig.json must survive the Next.js build unchanged. If
    // the build rewrote it, the next sync would see a local change.
    const shippedTsconfig = descriptor.framework.files.find(
      (file) => file.path === "tsconfig.json",
    );
    const builtTsconfig = createHash("sha256")
      .update(await readFile(join(target, "tsconfig.json")))
      .digest("hex");
    if (shippedTsconfig === undefined || builtTsconfig !== shippedTsconfig.sha256) {
      throw new Error("foundation_scaffold_tsconfig_rewritten_by_build");
    }

    // Exercise the real sync command against the release the installation is
    // already pinned to. A same-release sync must be a clean no-op that never
    // touches an installation-owned file, and it must fail closed exactly like
    // the scaffold when the vendored release is not locked.
    const syncCommand = join(target, "node_modules/.bin/foundry-reference-site-sync");
    const syncArguments = [
      "--target",
      target,
      "--descriptor",
      join(releaseDirectory, "foundation-release.json"),
      "--descriptor-digest",
      digest,
      "--artifacts",
      join(releaseDirectory, "artifacts"),
    ];
    const filesBeforeSync = await installationFileHashes(target, {
      skip: generatedDirectories,
    });
    const idempotentReport = execFileSync(syncCommand, syncArguments, {
      cwd: target,
      encoding: "utf8",
      env,
    });
    const changedBySync = changedPaths(
      filesBeforeSync,
      await installationFileHashes(target, { skip: generatedDirectories }),
    );
    if (changedBySync.length > 0) {
      throw new Error(`foundation_sync_idempotent_changed:${changedBySync.join(",")}`);
    }
    const pinnedAfterSync = JSON.parse(
      await readFile(join(target, ".foundry-foundation-release.json"), "utf8"),
    );
    const siteAfterSync = JSON.parse(
      await readFile(join(target, "foundry/published-site.json"), "utf8"),
    );
    if (
      !idempotentReport.includes("0 written") ||
      pinnedAfterSync.version !== descriptor.version ||
      siteAfterSync.site.navigation.length !== 0 ||
      siteAfterSync.home.sections.length !== 0 ||
      JSON.stringify(siteAfterSync).includes("Foundry Reference")
    ) {
      throw new Error("foundation_sync_idempotent_check_invalid");
    }

    // A local override of a framework file must survive the sync when the target
    // release did not change that file.
    const overriddenPath = join(target, "next.config.ts");
    const overriddenBefore = await readFile(overriddenPath, "utf8");
    await writeFile(
      overriddenPath,
      `${overriddenBefore}\n// installation override\n`,
    );
    const overrideReport = execFileSync(syncCommand, syncArguments, {
      cwd: target,
      encoding: "utf8",
      env,
    });
    const overriddenAfter = await readFile(overriddenPath, "utf8");
    if (
      !overriddenAfter.includes("// installation override") ||
      !overrideReport.includes("next.config.ts") ||
      !overrideReport.includes("keep")
    ) {
      throw new Error("foundation_sync_override_not_preserved");
    }
    await writeFile(overriddenPath, overriddenBefore);

    // The sync command refuses to advance when the target release is not the
    // vendored, locked executable.
    const originalSyncLock = await readFile(lockPath, "utf8");
    const referenceLockKey = "node_modules/@humber-foundry/reference-site";
    const notLockedSyncLock = JSON.parse(originalSyncLock);
    notLockedSyncLock.packages[referenceLockKey].version = "0.0.0-not-the-release";
    await writeFile(lockPath, `${JSON.stringify(notLockedSyncLock, null, 2)}\n`);
    expectCommandFailure(
      syncCommand,
      syncArguments,
      target,
      env,
      "foundation_scaffold_executable_not_locked:@humber-foundry/reference-site",
    );
    // A lock that still holds an older integrity for the target's vendored
    // bytes is stale. The sync names the npm command that relocks them, and
    // that command must make the lock hold the tarball's real integrity.
    const staleSyncLock = JSON.parse(originalSyncLock);
    staleSyncLock.packages[referenceLockKey].integrity =
      `sha512-${Buffer.alloc(64).toString("base64")}`;
    await writeFile(lockPath, `${JSON.stringify(staleSyncLock, null, 2)}\n`);
    const staleError = expectCommandFailure(
      syncCommand,
      syncArguments,
      target,
      env,
      "foundation_sync_lock_stale:@humber-foundry/reference-site\n",
    );
    const relockCommand = /^ {2}(npm install \S+)$/mu.exec(staleError)?.[1];
    if (
      relockCommand === undefined ||
      !relockCommand.endsWith(
        `/${descriptor.artifacts["@humber-foundry/reference-site"].filename}`,
      )
    ) {
      throw new Error("foundation_sync_lock_stale_command_missing");
    }
    const packagePath = join(target, "package.json");
    const beforeRelockPackage = await readFile(packagePath, "utf8");
    command("sh", ["-c", relockCommand], target, env);
    const relocked = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      relocked.packages[referenceLockKey].integrity !==
      descriptor.artifacts["@humber-foundry/reference-site"].integrity
    ) {
      throw new Error("foundation_sync_lock_stale_command_did_not_relock");
    }
    await writeFile(packagePath, beforeRelockPackage);
    await writeFile(lockPath, originalSyncLock);

    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    if (lock.lockfileVersion !== 3) throw new Error("foundation_release_lockfile_invalid");
    const lockSource = JSON.stringify(lock);
    if (
      lockSource.includes("workspace:") ||
      (lockSource.includes("node_modules/@humber-foundry/") &&
        lockSource.includes("\"link\":true"))
    ) {
      throw new Error("foundation_release_workspace_link_detected");
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseDirectory = join(root, "foundation-release");

function command(name, args, cwd, env) {
  execFileSync(name, args, { cwd, stdio: "inherit", env });
}

function expectCommandFailure(name, args, cwd, env, expected) {
  try {
    execFileSync(name, args, { cwd, encoding: "utf8", env });
  } catch (error) {
    if (String(error.stderr).includes(expected)) return;
    throw error;
  }
  throw new Error("foundation_release_negative_test_did_not_fail");
}

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
    const referenceManifest = JSON.parse(
      await readFile(join(root, "apps/reference-site/package.json"), "utf8"),
    );
    const tiptapOverrides = Object.fromEntries(
      Object.entries(referenceManifest.dependencies).filter(([name]) =>
        /^@tiptap\/(?:core|pm|extension-(?:bubble|floating)-menu|extension-list)$/u.test(
          name,
        ),
      ),
    );
    const dependencies = Object.fromEntries(
      Object.entries(descriptor.artifacts).map(([name, artifact]) => [
        name,
        `file:${join(releaseDirectory, "artifacts", artifact.filename)}`,
      ]),
    );
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
          overrides: tiptapOverrides,
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
    const idempotentReport = execFileSync(syncCommand, syncArguments, {
      cwd: target,
      encoding: "utf8",
      env,
    });
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
    const beforeTamperLock = await readFile(lockPath, "utf8");
    const tamperedSyncLock = JSON.parse(beforeTamperLock);
    tamperedSyncLock.packages["node_modules/@humber-foundry/reference-site"].integrity =
      `sha512-${Buffer.alloc(64).toString("base64")}`;
    await writeFile(lockPath, `${JSON.stringify(tamperedSyncLock, null, 2)}\n`);
    expectCommandFailure(
      syncCommand,
      syncArguments,
      target,
      env,
      "foundation_scaffold_executable_not_locked:@humber-foundry/reference-site",
    );
    await writeFile(lockPath, beforeTamperLock);

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

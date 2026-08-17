import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  isTemplatePath,
  tarEntries,
} from "../apps/reference-site/scripts/foundation-release-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "foundation-release");
const artifactsDirectory = join(output, "artifacts");
const stageDirectory = join(output, ".stage");
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const packageNames = [
  "@humber-foundry/application",
  "@humber-foundry/operator",
  "@humber-foundry/reference-site",
  "@humber-foundry/site-definition",
];
const packageLocations = {
  "@humber-foundry/application": "packages/application",
  "@humber-foundry/operator": "packages/operator",
  "@humber-foundry/reference-site": "apps/reference-site",
  "@humber-foundry/site-definition": "packages/site-definition",
};

function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function digest(algorithm, bytes, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function copySources(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (path) =>
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) &&
      !path.includes("/__snapshots__/") &&
      !path.includes("/test-support/"),
  });
}

async function stageLibrary({ name, location, entry, platform, dependencies = {} }) {
  const target = join(stageDirectory, name.slice(1).replace("/", "-"));
  await mkdir(join(target, "dist"), { recursive: true });
  await copySources(join(root, location, "src"), join(target, "src"));
  await build({
    entryPoints: [join(root, location, entry)],
    outfile: join(target, "dist/index.js"),
    bundle: true,
    format: "esm",
    platform,
    target: "es2022",
    packages: "external",
    sourcemap: false,
    legalComments: "none",
  });
  return { target, dependencies };
}

async function stageReferenceSite(version) {
  const target = join(stageDirectory, "foundry-reference-site");
  await mkdir(target, { recursive: true });
  for (const directory of [
    "app",
    "components",
    "foundry",
    "migrations",
    "public",
    "src",
  ]) {
    await copySources(
      join(root, "apps/reference-site", directory),
      join(target, directory),
    );
  }
  await mkdir(join(target, "scripts"), { recursive: true });
  for (const scriptName of [
    "foundation-release-lib.mjs",
    "scaffold-foundation-release.mjs",
    "sync-foundation-release.mjs",
  ]) {
    await cp(
      join(root, "apps/reference-site/scripts", scriptName),
      join(target, "scripts", scriptName),
    );
  }
  for (const filename of [
    "cloudflare-email.d.ts",
    "custom-worker.ts",
    "next-env.d.ts",
    "next.config.ts",
    "open-next.config.ts",
    "wrangler.jsonc",
    "wrangler.recovery.jsonc",
  ]) {
    await cp(join(root, "apps/reference-site", filename), join(target, filename));
  }
  const source = await json(join(root, "apps/reference-site/package.json"));
  const rootPackage = await json(join(root, "package.json"));
  return {
    target,
    dependencies: {
      ...source.dependencies,
      "@humber-foundry/application": version,
      "@humber-foundry/operator": version,
      "@humber-foundry/site-definition": version,
      ...source.devDependencies,
      "@types/commonmark": rootPackage.devDependencies["@types/commonmark"],
      ajv: rootPackage.devDependencies.ajv,
      commonmark: rootPackage.devDependencies.commonmark,
      typescript: rootPackage.devDependencies.typescript,
    },
  };
}

async function main() {
  const allowDirty = process.argv.includes("--allow-dirty");
  const status = command("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (!allowDirty && status !== "") {
    throw new Error("foundation_release_requires_clean_source_commit");
  }
  const sourceRevision = command("git", ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    throw new Error("foundation_release_source_revision_invalid");
  }
  const rootPackage = await json(join(root, "package.json"));
  const version = rootPackage.version;
  if (!versionPattern.test(version)) throw new Error("foundation_release_version_invalid");
  for (const [name, location] of Object.entries(packageLocations)) {
    const manifest = await json(join(root, location, "package.json"));
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(`foundation_release_version_drift:${name}`);
    }
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(artifactsDirectory, { recursive: true });
  await mkdir(stageDirectory, { recursive: true });

  const stages = {
    "@humber-foundry/site-definition": await stageLibrary({
      name: "@humber-foundry/site-definition",
      location: "packages/site-definition",
      entry: "src/index.ts",
      platform: "neutral",
    }),
    "@humber-foundry/application": await stageLibrary({
      name: "@humber-foundry/application",
      location: "packages/application",
      entry: "src/index.ts",
      platform: "neutral",
      dependencies: { "@humber-foundry/site-definition": version },
    }),
    "@humber-foundry/operator": await stageLibrary({
      name: "@humber-foundry/operator",
      location: "packages/operator",
      entry: "src/index.ts",
      platform: "node",
      dependencies: { "@humber-foundry/application": version },
    }),
    "@humber-foundry/reference-site": await stageReferenceSite(version),
  };

  const artifacts = {};
  const artifactBytes = {};
  for (const name of packageNames) {
    const stage = stages[name];
    const packageJson = {
      name,
      version,
      description: `Foundry CMS synchronized foundation package (${name})`,
      license: "MIT",
      repository: {
        type: "git",
        url: "https://github.com/Humber-Foundry/foundry-cms.git",
      },
      type: "module",
      engines: { node: rootPackage.engines.node },
      publishConfig: { access: "public" },
      dependencies: stage.dependencies,
      ...(name === "@humber-foundry/reference-site"
        ? {
            bin: {
              "foundry-reference-site": "scripts/scaffold-foundation-release.mjs",
              "foundry-reference-site-sync":
                "scripts/sync-foundation-release.mjs",
            },
          }
        : {
            exports: {
              ".": { types: "./src/index.ts", import: "./dist/index.js" },
            },
          }),
    };
    await cp(join(root, "LICENSE"), join(stage.target, "LICENSE"));
    await writeFile(join(stage.target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    const pack = JSON.parse(
      command("npm", ["pack", stage.target, "--pack-destination", artifactsDirectory, "--json"]),
    );
    const filename = pack[0]?.filename;
    if (typeof filename !== "string") throw new Error(`foundation_release_pack_failed:${name}`);
    const bytes = await readFile(join(artifactsDirectory, filename));
    artifactBytes[name] = bytes;
    artifacts[name] = {
      name,
      version,
      filename,
      size: bytes.byteLength,
      integrity: `sha512-${digest("sha512", bytes, "base64")}`,
      sha256: digest("sha256", bytes),
    };
  }

  // The framework manifest records every framework path in the packed
  // reference-site tarball with its sha256, so an installation can be synced to
  // this release. It is derived from the exact tarball bytes and the shared
  // `isTemplatePath`, so it lists precisely the paths the scaffold copies and
  // the sync command reconciles.
  const frameworkFiles = [...tarEntries(artifactBytes["@humber-foundry/reference-site"])]
    .filter(([path]) => isTemplatePath(path))
    .map(([path, entryBytes]) => ({ path, sha256: digest("sha256", entryBytes) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (frameworkFiles.length === 0) {
    throw new Error("foundation_release_framework_manifest_empty");
  }

  const migrationDirectory = join(root, "apps/reference-site/migrations");
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  const migrations = [];
  for (const name of migrationNames) {
    const path = `apps/reference-site/migrations/${name}`;
    migrations.push({ path, sha256: digest("sha256", await readFile(join(root, path))) });
  }
  const descriptor = {
    schemaVersion: "foundry.foundation-release/v1",
    version,
    source: {
      repository: "https://github.com/Humber-Foundry/foundry-cms",
      revision: sourceRevision,
    },
    compatibility: {
      node: rootPackage.engines.node,
      npm: `>=${rootPackage.packageManager.slice("npm@".length)}`,
      packageManager: rootPackage.packageManager,
    },
    migrations: {
      latest: basename(migrationNames.at(-1), ".sql").slice(0, 4),
      files: migrations,
    },
    framework: {
      files: frameworkFiles,
    },
    artifacts,
    provenance: {
      builderWorkflow:
        "https://github.com/Humber-Foundry/foundry-cms/actions/workflows/foundation-release.yml",
      sourceRevision,
      subjects: packageNames.map((name) => ({ name, sha256: artifacts[name].sha256 })),
    },
  };
  const descriptorSource = `${JSON.stringify(descriptor, null, 2)}\n`;
  await writeFile(join(output, "foundation-release.json"), descriptorSource);
  await writeFile(
    join(output, "foundation-release.sha256"),
    `sha256:${digest("sha256", descriptorSource)}\n`,
  );
  await rm(stageDirectory, { recursive: true, force: true });
  process.stdout.write(`Prepared ${packageNames.length} artifacts for ${version} at ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

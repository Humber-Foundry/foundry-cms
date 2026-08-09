import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const releaseDirectory = join(root, "foundation-release");

function command(name, args, options = {}) {
  return execFileSync(name, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function registryIntegrity(name, version) {
  try {
    const value = command("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"]);
    return JSON.parse(value);
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("E404")) return null;
    throw new Error(`foundation_release_registry_preflight_failed:${name}`);
  }
}

function registryPackageExists(name) {
  try {
    command("npm", ["view", name, "name", "--json"]);
    return true;
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("E404")) return false;
    throw new Error(`foundation_release_registry_preflight_failed:${name}`);
  }
}

export function assertProtectedEnvironment(environment) {
  const reviewerRule = environment?.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  if (
    environment?.name !== "foundation-release" ||
    environment?.can_admins_bypass !== false ||
    reviewerRule?.prevent_self_review !== true ||
    !Array.isArray(reviewerRule?.reviewers) ||
    reviewerRule.reviewers.length === 0
  ) {
    throw new Error("foundation_release_environment_not_protected");
  }
}

export async function assertPublicationAuthentication({
  artifacts,
  mode,
  bootstrapToken,
  packageExists,
}) {
  const packagePresence = await Promise.all(
    artifacts.map(async (artifact) => packageExists(artifact)),
  );
  if (mode === "bootstrap") {
    if (!bootstrapToken || packagePresence.every(Boolean)) {
      throw new Error("foundation_release_bootstrap_not_permitted");
    }
    return;
  }
  if (
    mode !== "trusted" ||
    bootstrapToken ||
    packagePresence.some((value) => !value)
  ) {
    throw new Error("foundation_release_trusted_publisher_unavailable");
  }
}

export async function publishRegistryArtifacts({
  artifacts,
  getIntegrity,
  publish,
  verifyProvenance,
}) {
  for (const artifact of artifacts) {
    const existing = await getIntegrity(artifact);
    if (existing !== null && existing !== artifact.integrity) {
      throw new Error(`foundation_release_registry_conflict:${artifact.name}`);
    }
  }
  for (const artifact of artifacts) {
    if ((await getIntegrity(artifact)) === null) await publish(artifact);
    if ((await getIntegrity(artifact)) !== artifact.integrity) {
      throw new Error(`foundation_release_registry_verification_failed:${artifact.name}`);
    }
  }
  await verifyProvenance();
}

export function isAbsentGitHubRelease(stderr) {
  return stderr.trim() === "gh: Not Found (HTTP 404)";
}

export async function reconcileGitHubRelease({
  existing,
  verifyExisting,
  create,
}) {
  if (existing === null) {
    await create();
    return;
  }
  await verifyExisting(existing);
}

async function main() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.FOUNDRY_RELEASE_APPROVED !== "publish"
  ) {
    throw new Error("foundation_release_publication_not_approved");
  }
  const descriptor = JSON.parse(
    await readFile(join(releaseDirectory, "foundation-release.json"), "utf8"),
  );
  if (
    descriptor.source.revision !== process.env.GITHUB_SHA ||
    descriptor.version !== process.env.FOUNDRY_RELEASE_VERSION
  ) {
    throw new Error("foundation_release_publication_source_mismatch");
  }

  const artifacts = Object.values(descriptor.artifacts);
  assertProtectedEnvironment(
    JSON.parse(
      command("gh", [
        "api",
        "repos/Humber-Foundry/foundry-cms/environments/foundation-release",
      ]),
    ),
  );
  const publicationMode = process.env.FOUNDRY_RELEASE_AUTHENTICATION;
  const bootstrapToken = process.env.NODE_AUTH_TOKEN ?? "";
  await assertPublicationAuthentication({
    artifacts,
    mode: publicationMode,
    bootstrapToken,
    packageExists: (artifact) => registryPackageExists(artifact.name),
  });
  await publishRegistryArtifacts({
    artifacts,
    getIntegrity: (artifact) =>
      registryIntegrity(artifact.name, artifact.version),
    publish: (artifact) => {
      command(
        "npm",
        [
          "publish",
          join(releaseDirectory, "artifacts", artifact.filename),
          "--access",
          "public",
          "--provenance",
        ],
        publicationMode === "bootstrap"
          ? { env: { ...process.env, NODE_AUTH_TOKEN: bootstrapToken } }
          : {
              env: Object.fromEntries(
                Object.entries(process.env).filter(
                  ([name]) => name !== "NODE_AUTH_TOKEN" && name !== "NPM_TOKEN",
                ),
              ),
            },
      );
    },
    verifyProvenance: async () => {
      const provenanceDirectory = await mkdtemp(
        join(tmpdir(), "foundry-published-provenance-"),
      );
      try {
        await writeFile(
          join(provenanceDirectory, "package.json"),
          `${JSON.stringify({
            name: "foundry-published-provenance-verification",
            version: "0.0.0",
            private: true,
            dependencies: Object.fromEntries(
              artifacts.map((artifact) => [artifact.name, artifact.version]),
            ),
          })}\n`,
        );
        command("npm", ["install", "--ignore-scripts"], {
          cwd: provenanceDirectory,
        });
        const auditSource = command(
          "npm",
          ["audit", "signatures", "--json", "--include-attestations"],
          { cwd: provenanceDirectory, maxBuffer: 20 * 1024 * 1024 },
        );
        const operator = await import(
          pathToFileURL(
            join(
              provenanceDirectory,
              "node_modules/@humber-foundry/operator/dist/index.js",
            ),
          ).href
        );
        operator.assertFoundationReleaseNpmProvenance({ descriptor, auditSource });
      } finally {
        await rm(provenanceDirectory, { recursive: true, force: true });
      }
    },
  });

  const tag = `foundation-v${descriptor.version}`;
  const assets = [
    join(releaseDirectory, "foundation-release.json"),
    join(releaseDirectory, "foundation-release.sha256"),
    ...Object.values(descriptor.artifacts).map((artifact) =>
      join(releaseDirectory, "artifacts", artifact.filename),
    ),
  ];
  const expectedAssets = new Map(
    await Promise.all(
      assets.map(async (path) => [
        path.split("/").at(-1),
        (await stat(path)).size,
      ]),
    ),
  );
  const repository = command("gh", [
    "api",
    "repos/Humber-Foundry/foundry-cms",
    "--jq",
    ".full_name",
  ]);
  if (repository !== "Humber-Foundry/foundry-cms") {
    throw new Error("foundation_release_github_repository_unavailable");
  }
  let current = null;
  try {
    const release = JSON.parse(
      command("gh", [
        "api",
        `repos/Humber-Foundry/foundry-cms/releases/tags/${tag}`,
      ]),
    );
    current = {
      tagName: release.tag_name,
      targetCommitish: release.target_commitish,
      assets: release.assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
      })),
    };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (!isAbsentGitHubRelease(stderr)) {
      throw new Error("foundation_release_github_release_lookup_failed");
    }
  }
  await reconcileGitHubRelease({
    existing: current,
    verifyExisting: async (existing) => {
      if (
        existing.tagName !== tag ||
        existing.targetCommitish !== descriptor.source.revision ||
        existing.assets.length !== expectedAssets.size ||
        existing.assets.some(
          (asset) => expectedAssets.get(asset.name) !== asset.size,
        )
      ) {
        throw new Error("foundation_release_github_release_conflict");
      }
      const downloaded = await mkdtemp(
        join(tmpdir(), "foundry-release-assets-"),
      );
      try {
        command("gh", ["release", "download", tag, "--dir", downloaded]);
        for (const local of assets) {
          const expected = await readFile(local);
          const actual = await readFile(
            join(downloaded, local.split("/").at(-1)),
          );
          if (!expected.equals(actual)) {
            throw new Error("foundation_release_github_release_conflict");
          }
        }
      } finally {
        await rm(downloaded, { recursive: true, force: true });
      }
    },
    create: async () => {
      command("gh", [
        "release",
        "create",
        tag,
        ...assets,
        "--target",
        descriptor.source.revision,
        "--title",
        `Foundry foundation ${descriptor.version}`,
        "--notes",
        "Synchronized public foundation artifacts. Verify foundation-release.sha256 and every descriptor integrity before use.",
      ]);
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

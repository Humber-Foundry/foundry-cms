import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

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

  for (const artifact of Object.values(descriptor.artifacts)) {
    const existing = registryIntegrity(artifact.name, artifact.version);
    if (existing !== null && existing !== artifact.integrity) {
      throw new Error(`foundation_release_registry_conflict:${artifact.name}`);
    }
  }
  for (const artifact of Object.values(descriptor.artifacts)) {
    if (registryIntegrity(artifact.name, artifact.version) === null) {
      command("npm", [
        "publish",
        join(releaseDirectory, "artifacts", artifact.filename),
        "--access",
        "public",
        "--provenance",
      ]);
    }
    if (registryIntegrity(artifact.name, artifact.version) !== artifact.integrity) {
      throw new Error(`foundation_release_registry_verification_failed:${artifact.name}`);
    }
  }

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
  let releaseExists = false;
  try {
    const current = JSON.parse(
      command("gh", [
        "release",
        "view",
        tag,
        "--json",
        "assets,tagName,targetCommitish",
      ]),
    );
    releaseExists = true;
    if (
      current.tagName !== tag ||
      current.targetCommitish !== descriptor.source.revision ||
      current.assets.length !== expectedAssets.size ||
      current.assets.some(
        (asset) => expectedAssets.get(asset.name) !== asset.size,
      )
    ) {
      throw new Error("foundation_release_github_release_conflict");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "foundation_release_github_release_conflict") {
      throw error;
    }
  }
  if (!releaseExists) {
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
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

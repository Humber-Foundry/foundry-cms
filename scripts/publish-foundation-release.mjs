import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
          Object.values(descriptor.artifacts).map((artifact) => [
            artifact.name,
            artifact.version,
          ]),
        ),
      })}\n`,
    );
    command("npm", ["install", "--ignore-scripts"], { cwd: provenanceDirectory });
    const auditSource = command(
      "npm",
      ["audit", "signatures", "--json", "--include-attestations"],
      { cwd: provenanceDirectory, maxBuffer: 20 * 1024 * 1024 },
    );
    const operator = await import(
      pathToFileURL(
        join(
          provenanceDirectory,
          "node_modules/@foundry/operator/dist/index.js",
        ),
      ).href
    );
    operator.assertFoundationReleaseNpmProvenance({ descriptor, auditSource });
  } finally {
    await rm(provenanceDirectory, { recursive: true, force: true });
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
  let current = null;
  try {
    current = JSON.parse(
      command("gh", [
        "release",
        "view",
        tag,
        "--json",
        "assets,tagName,targetCommitish",
      ]),
    );
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (!/(?:release not found|not found)/iu.test(stderr)) {
      throw new Error("foundation_release_github_release_lookup_failed");
    }
  }
  if (current !== null) {
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
    const downloaded = await mkdtemp(join(tmpdir(), "foundry-release-assets-"));
    try {
      command("gh", ["release", "download", tag, "--dir", downloaded]);
      for (const local of assets) {
        const expected = await readFile(local);
        const actual = await readFile(join(downloaded, local.split("/").at(-1)));
        if (!expected.equals(actual)) {
          throw new Error("foundation_release_github_release_conflict");
        }
      }
    } finally {
      await rm(downloaded, { recursive: true, force: true });
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

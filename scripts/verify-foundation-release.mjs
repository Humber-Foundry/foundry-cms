import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseDirectory = join(root, "foundation-release");

function command(name, args, cwd) {
  execFileSync(name, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "1" } });
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
          overrides: {
            "@tiptap/core": "3.29.1",
            "@tiptap/extension-bubble-menu": "3.29.1",
            "@tiptap/extension-floating-menu": "3.29.1",
            "@tiptap/pm": "3.29.1",
          },
        },
        null,
        2,
      )}\n`,
    );
    command("npm", ["install", "--package-lock-only=false", "--ignore-scripts=false"], target);
    command(
      join(target, "node_modules/.bin/foundry-reference-site"),
      [
        "--target",
        target,
        "--descriptor",
        join(releaseDirectory, "foundation-release.json"),
        "--descriptor-digest",
        digest,
        "--artifacts",
        join(releaseDirectory, "artifacts"),
      ],
      target,
    );
    command("npm", ["run", "build:operator"], target);
    command("npm", ["run", "typecheck"], target);
    command("npm", ["run", "build"], target);
    command("npm", ["run", "smoke:deployment"], target);
    const lock = JSON.parse(await readFile(join(target, "package-lock.json"), "utf8"));
    if (lock.lockfileVersion !== 3) throw new Error("foundation_release_lockfile_invalid");
    const lockSource = JSON.stringify(lock);
    if (
      lockSource.includes("workspace:") ||
      (lockSource.includes("node_modules/@foundry/") &&
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

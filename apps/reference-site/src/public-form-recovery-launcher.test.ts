import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("public form recovery launcher", () => {
  it("resolves its entrypoint and Wrangler from a checkout path with spaces", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "foundry recovery launcher "),
    );
    temporaryDirectories.push(temporaryDirectory);
    const checkout = join(temporaryDirectory, "checkout with spaces");
    await symlink(
      fileURLToPath(new URL("../../..", import.meta.url)),
      checkout,
      "dir",
    );

    const { stdout } = await executeFile(process.execPath, [
      "--preserve-symlinks-main",
      join(
        checkout,
        "apps/reference-site/scripts/run-public-form-recovery.mjs",
      ),
      "--help",
    ]);

    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--confirm-backup-id");
  });
});

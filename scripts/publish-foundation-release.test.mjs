import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("foundation release publication boundary", () => {
  it("cannot publish outside the approved protected workflow", () => {
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.FOUNDRY_RELEASE_APPROVED;
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "publish-foundation-release.mjs")],
      { encoding: "utf8", env },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("foundation_release_publication_not_approved");
    expect(result.stdout).toBe("");
  });

  it("publishes missing packages before requiring registry provenance", async () => {
    const source = await readFile(
      resolve(import.meta.dirname, "publish-foundation-release.mjs"),
      "utf8",
    );
    const publish = source.indexOf('"publish",');
    const installPublished = source.indexOf(
      'command("npm", ["install", "--ignore-scripts"]',
    );
    expect(publish).toBeGreaterThan(0);
    expect(installPublished).toBeGreaterThan(publish);
  });
});

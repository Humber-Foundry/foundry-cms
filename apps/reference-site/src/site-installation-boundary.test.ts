import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const applicationRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

describe("installation-owned runtime boundary", () => {
  it("keeps the bundled reference fixture behind the browser-safe seam", async () => {
    const entries = await readdir(applicationRoot, {
      recursive: true,
      withFileTypes: true,
    });
    const violations: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = resolve(entry.parentPath, entry.name);
      const repositoryPath = relative(applicationRoot, path);
      if (
        ![".ts", ".tsx"].includes(extname(path)) ||
        /(?:^|\/)(?:test-support|__snapshots__)(?:\/|$)/u.test(repositoryPath) ||
        /\.test\.tsx?$/u.test(repositoryPath) ||
        repositoryPath === "foundry/site-definition.ts"
      ) {
        continue;
      }
      const source = await readFile(path, "utf8");
      if (
        source.includes("referenceSiteDefinition") ||
        source.includes("referenceSiteApplication") ||
        source.includes("reference-installation")
      ) {
        violations.push(repositoryPath);
      }
    }
    expect(violations).toEqual([]);
  });
});

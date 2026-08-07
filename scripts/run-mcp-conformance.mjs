#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temporaryDirectory = mkdtempSync(join(tmpdir(), "foundry-mcp-conformance-"));
const reportPath = join(temporaryDirectory, "vitest.json");
const testFiles = [
  "apps/reference-site/src/mcp-http-runtime.test.ts",
  "apps/reference-site/src/mcp-tool-registry.test.ts",
  "packages/application/src/content-publication.test.ts",
  "packages/application/src/mcp-read.test.ts",
  "packages/application/src/mcp-drafts.test.ts",
  "packages/application/src/mcp-publications.test.ts",
  "packages/application/src/mcp-campaign.test.ts",
  "packages/application/src/mcp-analytics.test.ts",
];

try {
  const tests = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      ...testFiles,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (tests.status !== 0) {
    process.stdout.write(tests.stdout ?? "");
    process.stderr.write(tests.stderr ?? "");
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      for (const file of report.testResults ?? []) {
        for (const assertion of file.assertionResults ?? []) {
          if (assertion.status === "failed") {
            console.error(`FAILED ${assertion.fullName}`);
            for (const message of assertion.failureMessages ?? []) {
              console.error(message);
            }
          }
        }
      }
    } catch {
      console.error("MCP conformance tests failed without a readable report.");
    }
    process.exit(tests.status ?? 1);
  }
  const verification = spawnSync(
    process.execPath,
    [join(root, "scripts/verify-mcp-conformance.mjs"), reportPath],
    { cwd: root, encoding: "utf8" },
  );
  process.stdout.write(verification.stdout ?? "");
  process.stderr.write(verification.stderr ?? "");
  process.exitCode = verification.status ?? 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

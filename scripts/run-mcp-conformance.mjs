#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTestsWithEvidence } from "./run-tests-with-evidence.mjs";

const root = process.cwd();
const temporaryDirectory = mkdtempSync(join(tmpdir(), "foundry-mcp-conformance-"));
const reportPath = join(temporaryDirectory, "vitest.json");
const testFiles = [
  "apps/reference-site/src/analytics-source-adapters.test.ts",
  "apps/reference-site/src/mcp-http-runtime.test.ts",
  "apps/reference-site/src/mcp-protocol-conformance.test.ts",
  "apps/reference-site/src/mcp-tool-registry.test.ts",
  "packages/application/src/content-publication.test.ts",
  "packages/application/src/mcp-read.test.ts",
  "packages/application/src/mcp-drafts.test.ts",
  "packages/application/src/mcp-publications.test.ts",
  "packages/application/src/mcp-campaign.test.ts",
  "packages/application/src/mcp-analytics.test.ts",
];

try {
  const testsPassed = await runTestsWithEvidence({ reportPath, testFiles });
  if (!testsPassed) {
    process.exitCode = 1;
  } else {
    const verification = spawnSync(
      process.execPath,
      [join(root, "scripts/verify-mcp-conformance.mjs"), reportPath],
      { cwd: root, encoding: "utf8" },
    );
    process.stdout.write(verification.stdout ?? "");
    process.stderr.write(verification.stderr ?? "");
    process.exitCode = verification.status ?? 1;
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

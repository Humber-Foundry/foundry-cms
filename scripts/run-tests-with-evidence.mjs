#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startVitest } from "vitest/node";

function discoverTestFiles(root) {
  const directory = mkdtempSync(join(tmpdir(), "foundry-vitest-list-"));
  const listPath = join(directory, "files.json");
  try {
    const discovery = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "list",
        "--filesOnly",
        `--json=${listPath}`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (discovery.status !== 0) {
      process.stdout.write(discovery.stdout ?? "");
      process.stderr.write(discovery.stderr ?? "");
      throw new Error("Vitest test-file discovery failed.");
    }
    const files = JSON.parse(readFileSync(listPath, "utf8"));
    return files.map(({ file }) => file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function runBatch(root, testFiles) {
  const vitest = await startVitest("test", testFiles, {
    run: true,
    watch: false,
    reporters: ["default"],
  });
  if (vitest === undefined) {
    throw new Error("Vitest did not create a test context.");
  }
  try {
    const modules = vitest.state.getTestModules();
    const unhandledErrors = vitest.state.getUnhandledErrors();
    const testResults = modules.map((module) => ({
      name: resolve(root, module.moduleId),
      status: module.ok() ? "passed" : "failed",
      assertionResults: [...module.children.allTests()].map((test) => {
        const result = test.result();
        return {
          title: test.name,
          fullName: test.fullName,
          status: result.state,
          failureMessages: (result.errors ?? []).map(
            (error) => error.stack ?? error.message,
          ),
        };
      }),
    }));
    return {
      success:
        modules.length > 0 &&
        modules.every((module) => module.ok()) &&
        unhandledErrors.length === 0,
      testResults,
    };
  } finally {
    await vitest.close();
  }
}

export async function runTestsWithEvidence({ reportPath, testFiles = [] }) {
  const root = process.cwd();
  const files = testFiles.length === 0
    ? discoverTestFiles(root)
    : testFiles;
  const batches = files.map((file) => [file]);
  const results = [];
  for (const batch of batches) {
    results.push(await runBatch(root, batch));
  }
  const success = results.every((result) => result.success);
  const testResults = results.flatMap((result) => result.testResults);
  writeFileSync(
    resolve(root, reportPath),
    JSON.stringify({ success, testResults }),
    "utf8",
  );
  return success;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , reportPath, ...testFiles] = process.argv;
  if (reportPath === undefined) {
    throw new Error(
      "Usage: run-tests-with-evidence.mjs REPORT [TEST_FILE ...]",
    );
  }
  if (!(await runTestsWithEvidence({ reportPath, testFiles }))) {
    process.exitCode = 1;
  }
}

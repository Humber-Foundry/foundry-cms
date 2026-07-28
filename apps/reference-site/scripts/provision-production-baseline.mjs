#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { assertExactProductionContent } from "./assert-exact-production-content.mjs";
import { assertExactProductionHead } from "./assert-exact-production-head.mjs";

const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

function waitForProcess(process) {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            `production_baseline_provision_failed:${code ?? "signal"}:${
              signal ?? "none"
            }`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}

export async function provisionProductionBaseline({
  environment = process.env,
  assertHead = assertExactProductionHead,
  verifyRelease = assertExactProductionContent,
  startProvision,
} = {}) {
  const expectedCommit =
    environment.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  const authorizedCommit =
    environment.FOUNDRY_BASELINE_PROVISION_COMMIT_SHA?.trim().toLowerCase();
  const accountId = environment.FOUNDRY_CLOUDFLARE_ACCOUNT_ID?.trim();
  const scriptTag = environment.FOUNDRY_CLOUDFLARE_SCRIPT_TAG?.trim();
  if (
    expectedCommit === undefined ||
    !objectIdPattern.test(expectedCommit) ||
    authorizedCommit !== expectedCommit ||
    accountId === undefined ||
    accountId.length === 0 ||
    scriptTag === undefined ||
    scriptTag.length === 0
  ) {
    throw new Error("production_baseline_provision_not_authorized");
  }

  assertHead();
  const provision =
    startProvision?.({ accountId, expectedCommit, scriptTag }) ??
    spawn(
      "opennextjs-cloudflare",
      ["deploy", "--", "--name", scriptTag],
      {
        stdio: "inherit",
        shell: false,
        env: {
          ...environment,
          CLOUDFLARE_ACCOUNT_ID: accountId,
        },
      },
    );
  await waitForProcess(provision);
  assertHead();
  await verifyRelease();
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  provisionProductionBaseline()
    .then(() => {
      console.log("Production deployment baseline provisioned and verified.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

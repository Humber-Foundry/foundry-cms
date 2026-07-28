#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  assertExactProductionContent,
  assertExactProductionRelease,
} from "./assert-exact-production-content.mjs";
import { assertProductionDeploymentAbsent } from "./deploy-exact-production.mjs";
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

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

async function readBranchLock({ branchUrl, headers, fetchImplementation }) {
  const response = await fetchImplementation(`${branchUrl}/protection`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error("production_baseline_branch_lock_unavailable");
  }
  const protection = await response.json();
  if (
    typeof protection !== "object" ||
    protection === null ||
    typeof protection.lock_branch !== "object" ||
    protection.lock_branch === null ||
    typeof protection.lock_branch.enabled !== "boolean"
  ) {
    throw new Error("production_baseline_branch_lock_invalid");
  }
  return protection.lock_branch.enabled;
}

export async function acquireProductionBranchLock({
  environment = process.env,
  fetchImplementation = fetch,
} = {}) {
  const owner = environment.FOUNDRY_GITHUB_OWNER?.trim();
  const repository = environment.FOUNDRY_GITHUB_REPOSITORY?.trim();
  const branch =
    environment.FOUNDRY_PRODUCTION_BRANCH?.trim() || "main";
  const token =
    environment.FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN?.trim();
  if (
    owner === undefined ||
    owner.length === 0 ||
    repository === undefined ||
    repository.length === 0 ||
    branch.length === 0 ||
    token === undefined ||
    token.length === 0
  ) {
    throw new Error("production_baseline_branch_lock_not_configured");
  }
  const branchUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}` +
    `/${encodeURIComponent(repository)}/branches/${encodeURIComponent(branch)}`;
  const headers = githubHeaders(token);
  if (
    await readBranchLock({
      branchUrl,
      headers,
      fetchImplementation,
    })
  ) {
    throw new Error("production_baseline_branch_already_locked");
  }
  const lockResponse = await fetchImplementation(`${branchUrl}/lock`, {
    method: "PUT",
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!lockResponse.ok) {
    throw new Error("production_baseline_branch_lock_failed");
  }
  if (
    !(await readBranchLock({
      branchUrl,
      headers,
      fetchImplementation,
    }))
  ) {
    throw new Error("production_baseline_branch_lock_failed");
  }

  return async function releaseBranchLock() {
    const unlockResponse = await fetchImplementation(`${branchUrl}/lock`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!unlockResponse.ok) {
      throw new Error("production_baseline_branch_unlock_failed");
    }
    if (
      await readBranchLock({
        branchUrl,
        headers,
        fetchImplementation,
      })
    ) {
      throw new Error("production_baseline_branch_unlock_failed");
    }
  };
}

export async function provisionProductionBaseline({
  environment = process.env,
  assertHead = assertExactProductionHead,
  assertDeploymentAbsent = assertProductionDeploymentAbsent,
  authorizeContent = assertExactProductionContent,
  verifyRelease = assertExactProductionRelease,
  acquireBranchLock = () =>
    acquireProductionBranchLock({ environment }),
  startProvision,
} = {}) {
  const expectedCommit =
    environment.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  const authorizedCommit =
    environment.FOUNDRY_BASELINE_PROVISION_COMMIT_SHA?.trim().toLowerCase();
  const accountId = environment.FOUNDRY_CLOUDFLARE_ACCOUNT_ID?.trim();
  const scriptName =
    environment.FOUNDRY_CLOUDFLARE_SCRIPT_NAME?.trim();
  if (
    expectedCommit === undefined ||
    !objectIdPattern.test(expectedCommit) ||
    authorizedCommit !== expectedCommit ||
    accountId === undefined ||
    accountId.length === 0 ||
    scriptName === undefined ||
    scriptName.length === 0
  ) {
    throw new Error("production_baseline_provision_not_authorized");
  }

  await assertDeploymentAbsent();
  const releaseBranchLock = await acquireBranchLock();
  assertHead();
  await assertDeploymentAbsent();
  assertHead();
  const {
    FOUNDRY_BASELINE_PROVISION_GITHUB_TOKEN: _baselineGitHubToken,
    ...provisionEnvironment
  } = environment;
  const provision =
    startProvision?.({ accountId, expectedCommit, scriptName }) ??
    spawn(
      "opennextjs-cloudflare",
      ["deploy", "--", "--name", scriptName],
      {
        stdio: "inherit",
        shell: false,
        env: {
          ...provisionEnvironment,
          CLOUDFLARE_ACCOUNT_ID: accountId,
        },
      },
    );
  await waitForProcess(provision);
  assertHead();
  await authorizeContent();
  await verifyRelease();
  await releaseBranchLock();
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

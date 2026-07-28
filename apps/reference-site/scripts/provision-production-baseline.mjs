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
const branchPattern = /^[A-Za-z0-9._/-]+$/u;

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
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

function isExactProductionLockRuleset(ruleset, { name, qualifiedName }) {
  return (
    typeof ruleset === "object" &&
    ruleset !== null &&
    Number.isSafeInteger(ruleset.id) &&
    ruleset.id > 0 &&
    ruleset.name === name &&
    ruleset.target === "branch" &&
    ruleset.enforcement === "active" &&
    Array.isArray(ruleset.bypass_actors) &&
    ruleset.bypass_actors.length === 0 &&
    Array.isArray(ruleset.conditions?.ref_name?.include) &&
    ruleset.conditions.ref_name.include.length === 1 &&
    ruleset.conditions.ref_name.include[0] === qualifiedName &&
    Array.isArray(ruleset.conditions.ref_name.exclude) &&
    ruleset.conditions.ref_name.exclude.length === 0 &&
    Array.isArray(ruleset.rules) &&
    ruleset.rules.length === 1 &&
    ruleset.rules[0]?.type === "update"
  );
}

async function findProductionLockRuleset({
  fetchImplementation,
  headers,
  name,
  rulesetsUrl,
}) {
  const response = await fetchImplementation(
    `${rulesetsUrl}?includes_parents=false&targets=branch&per_page=100`,
    {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const rulesets = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(rulesets)) {
    throw new Error("production_baseline_branch_lock_unavailable");
  }
  const matches = rulesets.filter((ruleset) => ruleset?.name === name);
  if (
    matches.length > 1 ||
    (matches.length === 1 &&
      (!Number.isSafeInteger(matches[0]?.id) || matches[0].id <= 0))
  ) {
    throw new Error("production_baseline_branch_lock_invalid");
  }
  return matches[0]?.id ?? null;
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
    !branchPattern.test(branch) ||
    token === undefined ||
    token.length === 0
  ) {
    throw new Error("production_baseline_branch_lock_not_configured");
  }
  const headers = githubHeaders(token);
  const qualifiedName = `refs/heads/${branch}`;
  const name = `Foundry production baseline lock: ${branch}`;
  const rulesetsUrl = `https://api.github.com/repos/${encodeURIComponent(
    owner,
  )}/${encodeURIComponent(repository)}/rulesets`;
  let rulesetId = await findProductionLockRuleset({
    fetchImplementation,
    headers,
    name,
    rulesetsUrl,
  });
  if (rulesetId === null) {
    let createFailed = false;
    try {
      const createResponse = await fetchImplementation(rulesetsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          target: "branch",
          enforcement: "active",
          bypass_actors: [],
          conditions: {
            ref_name: {
              include: [qualifiedName],
              exclude: [],
            },
          },
          rules: [{ type: "update" }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const created = await createResponse.json().catch(() => null);
      if (
        createResponse.status === 201 &&
        typeof created === "object" &&
        created !== null &&
        Number.isSafeInteger(created.id) &&
        created.id > 0
      ) {
        rulesetId = created.id;
      } else {
        createFailed = true;
      }
    } catch {
      createFailed = true;
    }
    if (createFailed) {
      rulesetId = await findProductionLockRuleset({
        fetchImplementation,
        headers,
        name,
        rulesetsUrl,
      });
    }
    if (rulesetId === null) {
      throw new Error("production_baseline_branch_lock_unavailable");
    }
  }
  const rulesetUrl = `${rulesetsUrl}/${rulesetId}`;
  const verifyResponse = await fetchImplementation(rulesetUrl, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const verified = await verifyResponse.json().catch(() => null);
  if (
    !verifyResponse.ok ||
    !isExactProductionLockRuleset(verified, { name, qualifiedName }) ||
    verified.id !== rulesetId
  ) {
    throw new Error("production_baseline_branch_lock_failed");
  }

  return async function releaseBranchLock() {
    let deleteWasAccepted = false;
    try {
      const deleteResponse = await fetchImplementation(rulesetUrl, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      deleteWasAccepted = deleteResponse.status === 204;
    } catch {
      // A lost response can still mean GitHub deleted the ruleset.
    }
    let absentResponse;
    try {
      absentResponse = await fetchImplementation(rulesetUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error("production_baseline_branch_unlock_unverified", {
        cause: error,
      });
    }
    if (absentResponse.status === 404) {
      return;
    }
    if (deleteWasAccepted && absentResponse.ok) {
      throw new Error("production_baseline_branch_unlock_failed");
    }
    throw new Error("production_baseline_branch_unlock_unverified");
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

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const branchPattern = /^[A-Za-z0-9._/-]+$/u;

export function assertExactProductionHead({
  environment = process.env,
  readLocalHead = () =>
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
  readRemoteHead = (reference) =>
    execFileSync("git", ["ls-remote", "--exit-code", "origin", reference], {
      encoding: "utf8",
    }),
} = {}) {
  const expectedCommit = environment.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  const productionBranch =
    environment.FOUNDRY_PRODUCTION_BRANCH?.trim() || "main";
  if (
    expectedCommit === undefined ||
    !objectIdPattern.test(expectedCommit) ||
    !branchPattern.test(productionBranch)
  ) {
    throw new Error("exact_production_head_configuration_invalid");
  }
  const localCommit = readLocalHead().trim().toLowerCase();
  if (
    !objectIdPattern.test(localCommit) ||
    localCommit !== expectedCommit
  ) {
    throw new Error("exact_build_commit_mismatch");
  }
  const reference = `refs/heads/${productionBranch}`;
  const fields = readRemoteHead(reference).trim().split(/\s+/u);
  if (
    fields.length !== 2 ||
    fields[1] !== reference ||
    !objectIdPattern.test(fields[0])
  ) {
    throw new Error("exact_production_head_unavailable");
  }
  if (fields[0].toLowerCase() !== expectedCommit) {
    throw new Error("exact_production_head_moved");
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    assertExactProductionHead();
    console.log("Exact production head confirmed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

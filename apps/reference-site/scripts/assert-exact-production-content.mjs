#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const contentHashPattern = /^[a-f0-9]{64}$/u;
const publishedContentPath =
  "packages/site-definition/src/published-site.json";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(bytes) {
  return createHash("sha256")
    .update(canonicalJson(JSON.parse(bytes)))
    .digest("hex");
}

async function fetchLiveMarker(environment) {
  const publicOrigin = environment.FOUNDRY_PUBLIC_ORIGIN?.trim();
  if (publicOrigin === undefined) {
    throw new Error("exact_live_marker_configuration_invalid");
  }
  const url = new URL("/.well-known/foundry-release.json", publicOrigin);
  if (url.protocol !== "https:") {
    throw new Error("exact_live_marker_configuration_invalid");
  }
  url.searchParams.set("foundry_deploy_probe", crypto.randomUUID());
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error("exact_live_marker_unavailable");
  }
  return response.json();
}

export async function assertExactProductionContent({
  environment = process.env,
  readLiveMarker = () => fetchLiveMarker(environment),
  readCommitParents = (commit) =>
    execFileSync("git", ["rev-list", "--parents", "-n", "1", commit], {
      encoding: "utf8",
    }),
  readChangedPaths = (from, to) =>
    execFileSync("git", ["diff", "--name-only", from, to], {
      encoding: "utf8",
    }),
  readCommitMessage = (commit) =>
    execFileSync("git", ["show", "-s", "--format=%B", commit], {
      encoding: "utf8",
    }),
  readPublishedContent = (commit) =>
    execFileSync("git", ["show", `${commit}:${publishedContentPath}`], {
      encoding: "utf8",
    }),
} = {}) {
  const expectedCommit =
    environment.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  const initialReleaseCommit =
    environment.FOUNDRY_INITIAL_RELEASE_COMMIT_SHA?.trim().toLowerCase();
  if (
    expectedCommit === undefined ||
    !objectIdPattern.test(expectedCommit) ||
    (initialReleaseCommit !== undefined &&
      !objectIdPattern.test(initialReleaseCommit))
  ) {
    throw new Error("exact_content_authorization_configuration_invalid");
  }

  let marker;
  try {
    marker = await readLiveMarker();
  } catch (error) {
    if (initialReleaseCommit === expectedCommit) {
      return;
    }
    throw error;
  }
  if (
    typeof marker !== "object" ||
    marker === null ||
    typeof marker.commitSha !== "string" ||
    !objectIdPattern.test(marker.commitSha) ||
    typeof marker.contentHash !== "string" ||
    !contentHashPattern.test(marker.contentHash)
  ) {
    throw new Error("exact_live_marker_invalid");
  }
  const liveCommit = marker.commitSha.toLowerCase();
  const expectedContentHash = contentHash(
    readPublishedContent(expectedCommit),
  );
  if (marker.contentHash === expectedContentHash) {
    return;
  }

  const parents = readCommitParents(expectedCommit).trim().split(/\s+/u);
  const changedPaths = readChangedPaths(liveCommit, expectedCommit)
    .trim()
    .split("\n")
    .filter((path) => path.length > 0);
  const message = readCommitMessage(expectedCommit);
  const hashTrailer = message.match(
    /^Foundry-Content-Hash: ([a-f0-9]{64})$/mu,
  );
  if (
    parents.length !== 2 ||
    parents[0] !== expectedCommit ||
    parents[1] !== liveCommit ||
    changedPaths.length !== 1 ||
    changedPaths[0] !== publishedContentPath ||
    !/^Foundry-Publish-Id: publish_[a-f0-9]{32}$/mu.test(message) ||
    hashTrailer === null ||
    expectedContentHash !== hashTrailer[1]
  ) {
    throw new Error("exact_content_release_not_authorized");
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assertExactProductionContent()
    .then(() => {
      console.log("Exact production content authorization confirmed.");
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

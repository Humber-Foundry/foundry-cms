#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  projectPublishedSiteDefinition,
} from "../../../packages/site-definition/src/site-definition-projection.mjs";

const objectIdPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const contentHashPattern = /^[a-f0-9]{64}$/u;
const publishedContentPath =
  "packages/site-definition/src/published-site.json";
const managedRichTextPathPattern =
  /^content\/rich-text\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.md$/u;

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
    .update(
      canonicalJson(
        projectPublishedSiteDefinition(JSON.parse(bytes)),
      ),
    )
    .digest("hex");
}

function storedContentHash(bytes) {
  return createHash("sha256")
    .update(canonicalJson(JSON.parse(bytes)))
    .digest("hex");
}

function fixedBaseRuntimeContentHash(bytes) {
  const definition = JSON.parse(bytes);
  return createHash("sha256")
    .update(
      canonicalJson({
        ...definition,
        home: {
          ...definition.home,
          media: definition.home.media ?? [],
        },
      }),
    )
    .digest("hex");
}

function previousProjectedContentHash(bytes) {
  const stored = JSON.parse(bytes);
  if (
    stored.schemaVersion === "1.3.0" ||
    stored.definitionVersion === "1.3.0"
  ) {
    return null;
  }
  const projected = projectPublishedSiteDefinition(stored);
  const { blog: _blog, ...previous } = projected;
  return createHash("sha256")
    .update(
      canonicalJson({
        ...previous,
        definitionVersion: "1.2.0",
        schemaVersion: "1.2.0",
      }),
    )
    .digest("hex");
}

function publicationArtifactHash(artifacts) {
  const manifest = [...artifacts]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, bytes }) => ({
      byteLength: Buffer.byteLength(bytes),
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
  return createHash("sha256")
    .update(canonicalJson(manifest))
    .digest("hex");
}

function publicationSignaturePayload(input) {
  return [
    "foundry-publication-signature-v2",
    input.expectedHead,
    input.artifactHash,
    input.contentHash,
    input.message,
  ].join("\0");
}

function signatureIsValid({
  contentHash: expectedContentHash,
  expectedHead,
  artifactHash,
  message,
  secret,
}) {
  const normalizedMessage = message.replace(/(?:\r?\n)+$/u, "");
  const matches = [
    ...normalizedMessage.matchAll(
      /^Foundry-Publication-Signature: v2=([a-f0-9]{64})$/gmu,
    ),
  ];
  if (matches.length !== 1) {
    return false;
  }
  const trailer =
    `\nFoundry-Publication-Signature: v2=${matches[0][1]}`;
  if (!normalizedMessage.endsWith(trailer)) {
    return false;
  }
  const unsignedMessage = normalizedMessage.slice(0, -trailer.length);
  const expected = createHmac("sha256", secret)
    .update(
      publicationSignaturePayload({
        expectedHead,
        artifactHash,
        contentHash: expectedContentHash,
        message: unsignedMessage,
      }),
    )
    .digest();
  return timingSafeEqual(
    expected,
    Buffer.from(matches[0][1], "hex"),
  );
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
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error("exact_live_marker_unavailable");
  }
  return response.json();
}

function validLiveMarker(marker) {
  return (
    typeof marker === "object" &&
    marker !== null &&
    typeof marker.commitSha === "string" &&
    objectIdPattern.test(marker.commitSha) &&
    typeof marker.contentHash === "string" &&
    contentHashPattern.test(marker.contentHash)
  );
}

export async function assertExactProductionRelease({
  environment = process.env,
  readLiveMarker = () => fetchLiveMarker(environment),
} = {}) {
  const expectedCommit =
    environment.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  if (
    expectedCommit === undefined ||
    !objectIdPattern.test(expectedCommit)
  ) {
    throw new Error("exact_release_verification_configuration_invalid");
  }
  const marker = await readLiveMarker();
  if (!validLiveMarker(marker)) {
    throw new Error("exact_live_marker_invalid");
  }
  if (marker.commitSha.toLowerCase() !== expectedCommit) {
    throw new Error("exact_release_commit_not_live");
  }
}

export async function assertExactProductionContent({
  environment = process.env,
  readLiveMarker = () => fetchLiveMarker(environment),
  readCommitParents = (commit) =>
    execFileSync("git", ["rev-list", "--parents", "-n", "1", commit], {
      encoding: "utf8",
    }),
  readChangedPaths = (from, to) =>
    execFileSync(
      "git",
      ["diff", "--no-renames", "--name-only", from, to],
      {
        encoding: "utf8",
      },
    ),
  readCommitMessage = (commit) =>
    execFileSync("git", ["show", "-s", "--format=%B", commit], {
      encoding: "utf8",
    }),
  readPublishedContent = (commit) =>
    execFileSync("git", ["show", `${commit}:${publishedContentPath}`], {
      encoding: "utf8",
    }),
  readManagedRichTextPaths = (commit) =>
    execFileSync(
      "git",
      [
        "ls-tree",
        "-r",
        "--name-only",
        commit,
        "--",
        "content/rich-text",
      ],
      { encoding: "utf8" },
    ),
  readArtifact = (commit, path) =>
    execFileSync("git", ["show", `${commit}:${path}`], {
      encoding: "utf8",
    }),
} = {}) {
  const expectedCommit =
    environment.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  const publicationSigningSecret =
    environment.FOUNDRY_PUBLICATION_SIGNING_SECRET?.trim();
  if (
    expectedCommit === undefined ||
    !objectIdPattern.test(expectedCommit) ||
    publicationSigningSecret === undefined ||
    Buffer.byteLength(publicationSigningSecret) < 32
  ) {
    throw new Error("exact_content_authorization_configuration_invalid");
  }

  const marker = await readLiveMarker();
  if (!validLiveMarker(marker)) {
    throw new Error("exact_live_marker_invalid");
  }
  const liveCommit = marker.commitSha.toLowerCase();
  const expectedPublishedContent = readPublishedContent(expectedCommit);
  const expectedContentHash = contentHash(expectedPublishedContent);
  const compatibleExpectedContentHashes = new Set([
    expectedContentHash,
    storedContentHash(expectedPublishedContent),
    fixedBaseRuntimeContentHash(expectedPublishedContent),
    previousProjectedContentHash(expectedPublishedContent),
  ]);
  const changedPaths = readChangedPaths(liveCommit, expectedCommit)
    .trim()
    .split("\n")
    .filter((path) => path.length > 0);
  const hasPublishedArtifactDelta = changedPaths.some(
    (path) =>
      path === publishedContentPath ||
      managedRichTextPathPattern.test(path),
  );
  if (
    compatibleExpectedContentHashes.has(marker.contentHash) &&
    !hasPublishedArtifactDelta
  ) {
    return;
  }

  const parents = readCommitParents(expectedCommit).trim().split(/\s+/u);
  const managedRichTextPaths = readManagedRichTextPaths(expectedCommit)
    .trim()
    .split("\n")
    .filter((path) => path.length > 0)
    .sort();
  const managedPathSet = new Set(managedRichTextPaths);
  const changedPathSet = new Set(changedPaths);
  const pathsAreValid =
    managedPathSet.size === managedRichTextPaths.length &&
    managedRichTextPaths.every((path) =>
      managedRichTextPathPattern.test(path),
    ) &&
    changedPathSet.size === changedPaths.length &&
    changedPaths.includes(publishedContentPath) &&
    changedPaths.every(
      (path) =>
        path === publishedContentPath ||
        managedRichTextPathPattern.test(path),
    );
  const expectedArtifactHash = pathsAreValid
    ? publicationArtifactHash([
        {
          path: publishedContentPath,
          bytes: expectedPublishedContent,
        },
        ...managedRichTextPaths.map((path) => ({
          path,
          bytes: readArtifact(expectedCommit, path),
        })),
      ])
    : null;
  const message = readCommitMessage(expectedCommit);
  const hashTrailer = message.match(
    /^Foundry-Content-Hash: ([a-f0-9]{64})$/mu,
  );
  if (
    parents.length !== 2 ||
    parents[0] !== expectedCommit ||
    parents[1] !== liveCommit ||
    expectedArtifactHash === null ||
    !/^Foundry-Publish-Id: publish_[a-f0-9]{32}$/mu.test(message) ||
    hashTrailer === null ||
    expectedContentHash !== hashTrailer[1] ||
    !signatureIsValid({
      contentHash: expectedContentHash,
      expectedHead: liveCommit,
      artifactHash: expectedArtifactHash,
      message,
      secret: publicationSigningSecret,
    })
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

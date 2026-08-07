#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = process.cwd();
const manifestPath = "docs/mcp/evidence/conformance-manifest.json";
const manifestText = readFileSync(resolve(root, manifestPath), "utf8");
const manifest = JSON.parse(manifestText);
const reportPath = process.argv[2];
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const failures = [];

function fail(message) {
  failures.push(message);
}

function references(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(references);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(references);
  }
  return [];
}

if (manifest.artifactVersion !== 2) fail("unsupported artifact version");
if (manifest.contractVersion !== "foundry.mcp.v1")
  fail("unexpected MCP contract version");
if (manifest.protocolVersion !== "2025-11-25")
  fail("unexpected MCP protocol version");
if (
  packageJson.devDependencies?.[manifest.inspector?.package] !==
  manifest.inspector?.version
) {
  fail("official Inspector dependency is not pinned to the manifest version");
}

for (const criterion of [
  "protocolAndSchemas",
  "authorizationAndParity",
  "adversarial",
  "sanitization",
]) {
  if (manifest.criteria?.[criterion] === undefined)
    fail(`missing acceptance criterion ${criterion}`);
}
for (const threat of [
  "confusedDeputy",
  "tokenPassthrough",
  "injection",
  "replay",
  "staleWrites",
  "approvalSubstitution",
  "exfiltration",
  "ssrf",
  "exhaustion",
  "repudiation",
  "schemaDrift",
]) {
  if (references(manifest.criteria?.adversarial?.[threat]).length === 0) {
    fail(`missing adversarial evidence for ${threat}`);
  }
}

const passedTests = new Set();
if (typeof reportPath !== "string") {
  fail("a structured Vitest JSON report is required");
} else {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const file of report.testResults ?? []) {
      const path = relative(root, file.name).replaceAll("\\", "/");
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === "passed") {
          passedTests.add(`${path}::${assertion.title}`);
        }
      }
    }
  } catch {
    fail("the structured Vitest JSON report could not be read");
  }
}

for (const reference of references(manifest.criteria)) {
  if (!passedTests.has(reference)) {
    fail(`evidence test did not execute and pass: ${reference}`);
  }
}

const evidenceTexts = [manifestText];
for (const snapshot of manifest.snapshots ?? []) {
  const path = resolve(root, snapshot);
  let snapshotText;
  try {
    snapshotText = readFileSync(path, "utf8");
  } catch {
    fail(`missing generated snapshot ${snapshot}`);
    continue;
  }
  if (statSync(path).size > 128 * 1024)
    fail(`generated snapshot is unexpectedly large: ${snapshot}`);
  evidenceTexts.push(snapshotText);
}

const evidence = evidenceTexts.join("\n");
// rejects credential-shaped values, personal email addresses, private draft fields, provider payload fields, and realistic subscriber fixtures
for (const [label, pattern] of [
  ["bearer material", /Bearer\s+[A-Za-z0-9._~-]{16,}/u],
  ["JWT material", /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\./u],
  [
    "OAuth code or token value",
    /"(?:access_token|refresh_token|authorization_code)"\s*:/iu,
  ],
  ["personal email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ["private draft field", /"(?:privateDraft|draftBody|unpublishedBody)"\s*:/iu],
  [
    "provider payload field",
    /"(?:providerPayload|rawProviderResponse|providerToken)"\s*:/iu,
  ],
  ["subscriber fixture", /subscriber[_-](?:email|address|fixture)/iu],
]) {
  if (pattern.test(evidence)) fail(`sanitized evidence contains ${label}`);
}

const schemaSnapshot = evidenceTexts
  .slice(1)
  .find((text) => text.includes("complete MCP tool-schema snapshot"));
if (
  schemaSnapshot === undefined ||
  (schemaSnapshot.match(/[a-f0-9]{64}/gu) ?? []).length < 20
) {
  fail("complete schema snapshot does not contain reviewed schema digests");
}
const protocolSnapshot = evidenceTexts
  .slice(1)
  .find((text) => text.includes("sanitized protocol transcript snapshot"));
for (const marker of [
  "protocolVersion",
  "resources",
  "prompts",
  "nextCursor",
  "cancellation",
  "Method not found",
]) {
  if (protocolSnapshot === undefined || !protocolSnapshot.includes(marker)) {
    fail(`protocol snapshot is missing ${marker}`);
  }
}

if (failures.length > 0) {
  console.error(
    `MCP conformance evidence failed with ${failures.length} error(s):`,
  );
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  "MCP conformance evidence passed: protocol, schemas, security traceability, Inspector pin, and sanitization are current.",
);

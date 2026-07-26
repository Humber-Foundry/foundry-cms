#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const repository =
  args.repo ??
  process.env.GITHUB_REPOSITORY ??
  "Galen-Humber-Foundry/foundry-cms";
const issueNumber = requiredInteger(args.issue, "--issue");
const mapNumber = requiredInteger(args.map, "--map");
const reason = args.reason ?? "completed";
const dryRun = Boolean(args["dry-run"]);
const outcome = readRequiredFile(args["outcome-file"], "--outcome-file");
const mapEntry = readRequiredFile(args["map-entry-file"], "--map-entry-file");
const resolutionMarker = `<!-- wayfinder-resolution:${issueNumber} -->`;

if (!["completed", "not planned"].includes(reason)) {
  fail('--reason must be "completed" or "not planned".');
}
if (!hasOutcomeMarker(outcome)) {
  fail(
    "The outcome file must contain a recognizable Resolution, Research complete, Resolved, Scope correction, or Wayfinder audit correction heading.",
  );
}
if (mapEntry.includes("\n")) {
  fail("The map entry must be exactly one Markdown list line.");
}

const issue = ghJson([
  "api",
  `repos/${repository}/issues/${issueNumber}`,
]);
const map = ghJson(["api", `repos/${repository}/issues/${mapNumber}`]);
const children = ghJson([
  "api",
  "--paginate",
  "--slurp",
  `repos/${repository}/issues/${mapNumber}/sub_issues?per_page=100`,
]).flat();

if (!children.some((child) => child.number === issueNumber)) {
  fail(`${issue.html_url} is not a native child of ${map.html_url}.`);
}
if (!mapEntry.includes(issue.html_url)) {
  fail(`The map entry must contain the canonical ticket URL: ${issue.html_url}`);
}

const comments = ghJson([
  "api",
  "--paginate",
  "--slurp",
  `repos/${repository}/issues/${issueNumber}/comments?per_page=100`,
]).flat();
const needsOutcome = !comments.some(
  (comment) =>
    comment.body?.includes(resolutionMarker) || hasOutcomeMarker(comment.body ?? ""),
);
const needsMapEntry = !mapContainsTicket(map.body ?? "", issue);
const needsClose =
  issue.state !== "closed" ||
  issue.state_reason !== reason.replace(" ", "_");

const plan = [
  needsOutcome ? "record outcome comment" : "outcome already recorded",
  needsMapEntry ? "insert decision pointer" : "decision pointer already present",
  needsClose ? `close as ${reason}` : `already closed as ${reason}`,
];
console.log(`${dryRun ? "Dry run" : "Resolution plan"} for ${issue.html_url}:`);
for (const step of plan) console.log(`- ${step}`);

if (dryRun) process.exit(0);

const tempDirectory = mkdtempSync(join(tmpdir(), "wayfinder-resolve-"));
try {
  if (needsOutcome) {
    const commentPath = join(tempDirectory, "outcome.md");
    writeFileSync(commentPath, `${resolutionMarker}\n${outcome.trim()}\n`);
    gh([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repository,
      "--body-file",
      commentPath,
    ]);
  }

  if (needsMapEntry) {
    const nextBody = insertDecisionPointer(map.body ?? "", mapEntry);
    const mapPath = join(tempDirectory, "map.md");
    writeFileSync(mapPath, nextBody);
    gh([
      "issue",
      "edit",
      String(mapNumber),
      "--repo",
      repository,
      "--body-file",
      mapPath,
    ]);
  }

  if (needsClose) {
    gh([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repository,
      "--reason",
      reason,
    ]);
  }
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

verifyResolution();
console.log(`Verified atomic Wayfinder resolution for ${issue.html_url}.`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) fail(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (key === "dry-run") {
      parsed[key] = true;
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) fail(`Missing value for ${value}.`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function requiredInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    fail(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function readRequiredFile(path, flag) {
  if (!path) fail(`${flag} is required.`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) fail(`${flag} must not be empty.`);
  return value;
}

function hasOutcomeMarker(value) {
  return /(^|\n)\s*(?:#{1,3}\s*)?\*{0,2}(?:resolution|research complete|resolved\b|scope correction|wayfinder audit correction)\b/iu.test(
    value,
  );
}

function mapContainsTicket(mapBody, ticket) {
  return (
    mapBody.includes(ticket.html_url) ||
    mapBody.includes(`/issues/${ticket.number})`) ||
    mapBody.includes(`/issues/${ticket.number}\n`)
  );
}

function insertDecisionPointer(mapBody, entry) {
  const markerPattern =
    /<!-- one line per closed ticket(?::[^>]*)? -->/iu;
  const marker = mapBody.match(markerPattern)?.[0];
  if (!marker) {
    fail(
      'The map is missing its "<!-- one line per closed ticket -->" insertion marker.',
    );
  }
  return mapBody.replace(marker, `${marker}\n\n${entry}`);
}

function verifyResolution() {
  const verifiedIssue = ghJson([
    "api",
    `repos/${repository}/issues/${issueNumber}`,
  ]);
  const verifiedMap = ghJson([
    "api",
    `repos/${repository}/issues/${mapNumber}`,
  ]);
  const verifiedComments = ghJson([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues/${issueNumber}/comments?per_page=100`,
  ]).flat();

  const expectedReason = reason.replace(" ", "_");
  if (
    verifiedIssue.state !== "closed" ||
    verifiedIssue.state_reason !== expectedReason
  ) {
    fail(`Verification failed: ${verifiedIssue.html_url} is not ${reason}.`);
  }
  if (!verifiedComments.some((comment) => hasOutcomeMarker(comment.body ?? ""))) {
    fail(
      `Verification failed: ${verifiedIssue.html_url} has no recognizable outcome comment.`,
    );
  }
  if (!mapContainsTicket(verifiedMap.body ?? "", verifiedIssue)) {
    fail(
      `Verification failed: ${verifiedMap.html_url} has no pointer to ${verifiedIssue.html_url}.`,
    );
  }
}

function gh(parameters) {
  return execFileSync("gh", parameters, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function ghJson(parameters) {
  return JSON.parse(gh(parameters));
}

function fail(message) {
  console.error(`Wayfinder resolution failed: ${message}`);
  process.exit(1);
}

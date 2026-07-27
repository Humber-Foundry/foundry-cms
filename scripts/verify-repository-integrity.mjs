#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repository =
  process.env.GITHUB_REPOSITORY ?? "Humber-Foundry/foundry-cms";
const eventName = process.env.GITHUB_EVENT_NAME ?? "";
const eventPath = process.env.GITHUB_EVENT_PATH;
const workspace = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const mapLabel = process.env.WAYFINDER_MAP_LABEL ?? "wayfinder:map";
const secretManagerScheme = ["op", "://"].join("");
const failures = [];
const notices = [];
const forbiddenTerms = parseForbiddenTerms(
  process.env.WAYFINDER_FORBIDDEN_TERMS,
);

function parseForbiddenTerms(raw) {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }
    return parsed
      .filter((value) => typeof value === "string")
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean);
  } catch (error) {
    failures.push(
      `WAYFINDER_FORBIDDEN_TERMS is invalid: ${error.message}. Store it as a JSON array in a repository secret.`,
    );
    return [];
  }
}

function ghJson(path) {
  const output = execFileSync("gh", ["api", "--paginate", "--slurp", path], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(output).flat();
}

function recordFailure(message) {
  failures.push(message);
}

function containsForbiddenTerm(value) {
  if (!forbiddenTerms.length || typeof value !== "string") return false;
  const normalized = value.toLocaleLowerCase();
  return forbiddenTerms.some((term) => normalized.includes(term));
}

function scanText(location, value) {
  if (containsForbiddenTerm(value)) {
    recordFailure(`${location} contains a forbidden client-specific term.`);
  }
  if (typeof value === "string" && value.includes(secretManagerScheme)) {
    recordFailure(`${location} exposes a secret-manager reference.`);
  }
}

function scanObject(kind, row, fields) {
  for (const field of fields) {
    scanText(
      `${kind} ${row.html_url ?? row.url ?? row.number ?? row.id} field ${field}`,
      row[field],
    );
  }
}

function hasOutcomeMarker(comments) {
  return comments.some((comment) =>
    /(^|\n)\s*(?:#{1,3}\s*)?\*{0,2}(?:resolution|research complete|resolved\b|scope correction|wayfinder audit correction)\b/iu.test(
      comment.body ?? "",
    ),
  );
}

function mapContainsTicket(mapBody, issue) {
  return (
    mapBody.includes(issue.html_url) ||
    mapBody.includes(`/issues/${issue.number})`) ||
    mapBody.includes(`/issues/${issue.number}\n`)
  );
}

function auditWayfinder() {
  const issues = ghJson(`repos/${repository}/issues?state=all&per_page=100`);
  const maps = issues.filter((issue) =>
    issue.labels?.some((label) => label.name === mapLabel),
  );

  if (!maps.length) {
    recordFailure(`No issue with the ${mapLabel} label exists.`);
    return;
  }

  for (const map of maps) {
    const mapBody = map.body ?? "";
    for (const heading of [
      "## Destination",
      "## Decisions so far",
      "## Not yet specified",
      "## Out of scope",
    ]) {
      if (!mapBody.includes(heading)) {
        recordFailure(`${map.html_url} is missing required heading: ${heading}`);
      }
    }

    scanText(`map ${map.html_url}`, mapBody);
    const children = ghJson(
      `repos/${repository}/issues/${map.number}/sub_issues?per_page=100`,
    );

    if (map.state === "closed") {
      for (const child of children.filter((issue) => issue.state === "open")) {
        recordFailure(
          `Closed map ${map.html_url} still owns open child ${child.html_url}.`,
        );
      }
    }

    for (const child of children) {
      const comments = ghJson(
        `repos/${repository}/issues/${child.number}/comments?per_page=100`,
      );
      scanObject("ticket", child, ["title", "body"]);
      for (const comment of comments) {
        scanObject("ticket comment", comment, ["body"]);
      }

      if (child.state === "closed") {
        if (!comments.length) {
          recordFailure(
            `Closed child ${child.html_url} has no recorded outcome comment.`,
          );
        }
        if (!hasOutcomeMarker(comments)) {
          recordFailure(
            `Closed child ${child.html_url} has no recognizable resolution/research/scope outcome marker.`,
          );
        }
        if (!mapContainsTicket(mapBody, child)) {
          recordFailure(
            `Closed child ${child.html_url} has no decision pointer in ${map.html_url}.`,
          );
        }
      } else if (hasOutcomeMarker(comments)) {
        recordFailure(
          `Open child ${child.html_url} already has an explicit outcome marker; close it or clarify that the outcome is provisional.`,
        );
      }
    }
  }
}

function auditRepositoryMetadata() {
  const issues = ghJson(`repos/${repository}/issues?state=all&per_page=100`);
  const issueComments = ghJson(
    `repos/${repository}/issues/comments?per_page=100`,
  );
  const pulls = ghJson(`repos/${repository}/pulls?state=all&per_page=100`);
  const pullComments = ghJson(
    `repos/${repository}/pulls/comments?per_page=100`,
  );
  const labels = ghJson(`repos/${repository}/labels?per_page=100`);
  const milestones = ghJson(
    `repos/${repository}/milestones?state=all&per_page=100`,
  );
  const releases = ghJson(`repos/${repository}/releases?per_page=100`);

  for (const row of issues) scanObject("issue or pull", row, ["title", "body"]);
  for (const row of issueComments) scanObject("issue comment", row, ["body"]);
  for (const row of pulls) scanObject("pull request", row, ["title", "body"]);
  for (const row of pullComments) {
    scanObject("pull review comment", row, ["body", "path"]);
  }
  for (const row of labels) scanObject("label", row, ["name", "description"]);
  for (const row of milestones) {
    scanObject("milestone", row, ["title", "description"]);
  }
  for (const row of releases) {
    scanObject("release", row, ["name", "tag_name", "body"]);
  }

  for (const pull of pulls) {
    const reviews = ghJson(
      `repos/${repository}/pulls/${pull.number}/reviews?per_page=100`,
    );
    for (const review of reviews) scanObject("pull review", review, ["body"]);
  }
}

function auditCheckedOutFiles() {
  const names = execFileSync("git", ["ls-files", "-z"], {
    cwd: workspace,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

  for (const name of names) {
    const path = resolve(workspace, name);
    const buffer = readFileSync(path);
    if (buffer.includes(0)) continue;
    scanText(`tracked file ${relative(workspace, path)}`, buffer.toString("utf8"));
  }
}

function auditPullRequestFiles() {
  if (eventName !== "pull_request_target" || !eventPath) return;
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const pullNumber = event.pull_request?.number;
  if (!pullNumber) return;

  const files = ghJson(
    `repos/${repository}/pulls/${pullNumber}/files?per_page=100`,
  );
  for (const file of files) {
    scanText(`pull request file path ${file.filename}`, file.filename);
    scanText(`pull request patch ${file.filename}`, file.patch);
  }
}

auditWayfinder();
auditRepositoryMetadata();
auditCheckedOutFiles();
auditPullRequestFiles();

if (!forbiddenTerms.length) {
  notices.push(
    "Client-boundary term scanning was skipped because WAYFINDER_FORBIDDEN_TERMS is not configured.",
  );
}

for (const notice of notices) {
  console.log(`NOTICE: ${notice}`);
}

if (failures.length) {
  console.error(`Repository integrity check failed with ${failures.length} error(s):`);
  for (const failure of [...new Set(failures)]) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Repository integrity check passed for ${repository}: Wayfinder state, public metadata, and tracked content are consistent.`,
);

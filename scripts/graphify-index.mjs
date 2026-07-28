#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

const schemaVersion = "foundry.graphify-index/v1";
const maximumQueryBudget = 3_000;
const defaultQueryBudget = 1_200;

function fail(message) {
  throw new Error(message);
}

function runGit(repositoryRoot, arguments_, options = {}) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: options.binary ? null : "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitText(repositoryRoot, ...arguments_) {
  return runGit(repositoryRoot, arguments_).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryContext() {
  const repositoryRoot = gitText(process.cwd(), "rev-parse", "--show-toplevel");
  const commonGitDirectory = gitText(
    repositoryRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const cacheRoot = process.env.GRAPHIFY_INDEX_CACHE_DIR
    ? resolve(process.env.GRAPHIFY_INDEX_CACHE_DIR)
    : join(commonGitDirectory, "graphify-index");
  return {
    repositoryRoot,
    cacheRoot,
    repository: gitText(repositoryRoot, "remote", "get-url", "origin"),
    head: gitText(repositoryRoot, "rev-parse", "HEAD"),
    originMain: gitText(
      repositoryRoot,
      "rev-parse",
      "refs/remotes/origin/main",
    ),
  };
}

function snapshotDirectory(cacheRoot, commitSha) {
  return join(cacheRoot, "snapshots", commitSha);
}

function graphPath(snapshotRoot) {
  return join(snapshotRoot, "graphify-out", "graph.json");
}

function manifestHash(repositoryRoot, commitSha) {
  return sha256(
    runGit(
      repositoryRoot,
      ["ls-tree", "-r", "-z", "--full-tree", commitSha],
      { binary: true },
    ),
  );
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is missing or invalid: ${path}`);
  }
}

function validateGraph(graph, path) {
  if (
    typeof graph !== "object" ||
    graph === null ||
    !Array.isArray(graph.nodes) ||
    graph.nodes.length === 0 ||
    (!Array.isArray(graph.links) && !Array.isArray(graph.edges))
  ) {
    fail(
      `Graphify produced an invalid or empty graph: ${path}. ` +
        "If AST extraction reported a permission error, rerun the refresh outside the sandbox.",
    );
  }
}

function verifySnapshot(context, commitSha) {
  const root = snapshotDirectory(context.cacheRoot, commitSha);
  const metadata = readJson(join(root, "metadata.json"), "Graph metadata");
  const graphFile = graphPath(root);
  const graphBytes = readFileSync(graphFile);
  const graph = readJson(graphFile, "Graph snapshot");

  if (
    metadata.schemaVersion !== schemaVersion ||
    metadata.commitSha !== commitSha ||
    metadata.treeSha !==
      gitText(context.repositoryRoot, "rev-parse", `${commitSha}^{tree}`) ||
    metadata.repository !== context.repository ||
    metadata.sourceManifestSha256 !==
      manifestHash(context.repositoryRoot, commitSha) ||
    metadata.graphSha256 !== sha256(graphBytes)
  ) {
    fail(`Graph snapshot integrity check failed for ${commitSha}`);
  }
  validateGraph(graph, graphFile);
  return { root, metadata, graph };
}

function acquireRefreshLock(cacheRoot) {
  const lock = join(cacheRoot, "refresh.lock");
  mkdirSync(cacheRoot, { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("Another Graphify refresh is already running.");
    }
    throw error;
  }
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  return () => rmSync(lock, { recursive: true, force: true });
}

function graphifyExecutable() {
  return process.env.GRAPHIFY_BIN || "graphify";
}

function runGraphify(arguments_, options = {}) {
  const result = spawnSync(graphifyExecutable(), arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    fail(`Graphify could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      [
        `Graphify exited with status ${result.status}.`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout ?? "";
}

function graphifyVersion(context) {
  const result = spawnSync(graphifyExecutable(), ["--version"], {
    cwd: context.repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    fail("Graphify is not installed or did not report its version.");
  }
  return result.stdout.trim();
}

function refresh() {
  const context = repositoryContext();
  if (context.head !== context.originMain) {
    fail(
      "Graph snapshots can only be refreshed at the exact origin/main commit.",
    );
  }
  if (
    gitText(
      context.repositoryRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ) !== ""
  ) {
    fail("Graph snapshots require a clean main worktree.");
  }

  const existing = snapshotDirectory(context.cacheRoot, context.head);
  if (existsSync(existing)) {
    verifySnapshot(context, context.head);
    console.log(`Graph snapshot already exists: ${context.head}`);
    return;
  }

  const releaseLock = acquireRefreshLock(context.cacheRoot);
  const staging = join(
    context.cacheRoot,
    "staging",
    `${context.head}-${process.pid}-${randomUUID()}`,
  );
  try {
    if (existsSync(existing)) {
      verifySnapshot(context, context.head);
      console.log(`Graph snapshot already exists: ${context.head}`);
      return;
    }
    mkdirSync(dirname(staging), { recursive: true });
    runGraphify(
      [
        "extract",
        context.repositoryRoot,
        "--code-only",
        "--no-cluster",
        "--out",
        staging,
      ],
      { cwd: context.repositoryRoot },
    );
    const stagedGraphPath = graphPath(staging);
    const graphBytes = readFileSync(stagedGraphPath);
    validateGraph(
      JSON.parse(graphBytes.toString("utf8")),
      stagedGraphPath,
    );
    const metadata = {
      schemaVersion,
      repository: context.repository,
      ref: "refs/remotes/origin/main",
      commitSha: context.head,
      treeSha: gitText(
        context.repositoryRoot,
        "rev-parse",
        `${context.head}^{tree}`,
      ),
      graphifyVersion: graphifyVersion(context),
      generatedAt: new Date().toISOString(),
      sourceRoot: context.repositoryRoot,
      sourceManifestSha256: manifestHash(
        context.repositoryRoot,
        context.head,
      ),
      graphSha256: sha256(graphBytes),
      scope: "code",
    };
    writeFileSync(
      join(staging, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    mkdirSync(dirname(existing), { recursive: true });
    renameSync(staging, existing);

    const pointer = join(context.cacheRoot, "current.json");
    const pointerStaging = `${pointer}.${process.pid}.${randomUUID()}`;
    writeFileSync(
      pointerStaging,
      `${JSON.stringify(
        { commitSha: context.head, generatedAt: metadata.generatedAt },
        null,
        2,
      )}\n`,
    );
    renameSync(pointerStaging, pointer);
    console.log(`Published immutable Graphify snapshot: ${context.head}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    releaseLock();
  }
}

function splitNullDelimited(value) {
  return value.split("\0").filter(Boolean);
}

function changedPaths(context, baseSha) {
  const commands = [
    ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", `${baseSha}...HEAD`],
    ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"],
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  return new Set(
    commands.flatMap((arguments_) =>
      splitNullDelimited(runGit(context.repositoryRoot, arguments_)),
    ),
  );
}

function portablePath(path) {
  return normalize(path).split(sep).join("/");
}

function repositoryRelativeSource(sourceFile, sourceRoot) {
  if (typeof sourceFile !== "string" || sourceFile === "") return null;
  if (!isAbsolute(sourceFile)) {
    const normalized = portablePath(sourceFile).replace(/^\.\//u, "");
    return normalized.startsWith("../") ? null : normalized;
  }
  const candidate = portablePath(relative(sourceRoot, sourceFile));
  return candidate === ".." || candidate.startsWith("../") ? null : candidate;
}

function edgeEndpointId(endpoint) {
  return typeof endpoint === "object" && endpoint !== null
    ? endpoint.id
    : endpoint;
}

function filterGraph(graph, metadata, changed) {
  const removed = new Set();
  const nodes = graph.nodes.filter((node) => {
    if (!node.source_file) return true;
    const source = repositoryRelativeSource(
      node.source_file,
      metadata.sourceRoot,
    );
    const keep = source !== null && !changed.has(source);
    if (!keep) removed.add(node.id);
    return keep;
  });
  const edgeKey = Array.isArray(graph.links) ? "links" : "edges";
  const edges = graph[edgeKey].filter((edge) => {
    const sourceFile = edge.source_file
      ? repositoryRelativeSource(edge.source_file, metadata.sourceRoot)
      : null;
    return (
      (!edge.source_file ||
        (sourceFile !== null && !changed.has(sourceFile))) &&
      !removed.has(edgeEndpointId(edge.source)) &&
      !removed.has(edgeEndpointId(edge.target))
    );
  });
  return { ...graph, nodes, [edgeKey]: edges };
}

function parseQuery(arguments_) {
  const question = arguments_[0];
  if (!question || question.startsWith("--")) {
    fail(
      'Usage: npm run graphify:query -- "question" [--dfs] [--budget N]',
    );
  }
  let budget = defaultQueryBudget;
  let useDfs = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dfs") {
      useDfs = true;
    } else if (argument === "--budget") {
      budget = Number.parseInt(arguments_[index + 1] ?? "", 10);
      index += 1;
    } else {
      fail(`Unknown graph query option: ${argument}`);
    }
  }
  if (
    !Number.isInteger(budget) ||
    budget < 100 ||
    budget > maximumQueryBudget
  ) {
    fail(`Graph query budget must be between 100 and ${maximumQueryBudget}.`);
  }
  return { question, budget, useDfs };
}

function branchSnapshot(context) {
  const baseSha = gitText(
    context.repositoryRoot,
    "merge-base",
    "HEAD",
    "refs/remotes/origin/main",
  );
  const root = snapshotDirectory(context.cacheRoot, baseSha);
  if (!existsSync(root)) {
    fail(
      `No immutable Graphify snapshot exists for branch base ${baseSha}. ` +
        "Inspect source directly until Foreman publishes that exact snapshot.",
    );
  }
  return { baseSha, ...verifySnapshot(context, baseSha) };
}

function query(arguments_) {
  const parsed = parseQuery(arguments_);
  const context = repositoryContext();
  const snapshot = branchSnapshot(context);
  const changed = changedPaths(context, snapshot.baseSha);
  const filtered = filterGraph(
    snapshot.graph,
    snapshot.metadata,
    changed,
  );
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "foundry-graphify-query-"),
  );
  const filteredGraphPath = join(temporaryDirectory, "graph.json");
  try {
    writeFileSync(filteredGraphPath, JSON.stringify(filtered));
    console.log(`Graph base: ${snapshot.baseSha}`);
    console.log(`Branch head: ${context.head}`);
    console.log(`Graph scope: ${snapshot.metadata.scope}`);
    console.log(`Branch-modified files excluded: ${changed.size}`);
    for (const path of [...changed].sort().slice(0, 20)) {
      console.log(`  ${path}`);
    }
    if (changed.size > 20) {
      console.log(`  ... ${changed.size - 20} more`);
    }
    const graphifyArguments = [
      "query",
      parsed.question,
      "--budget",
      String(parsed.budget),
      "--graph",
      filteredGraphPath,
    ];
    if (parsed.useDfs) graphifyArguments.push("--dfs");
    process.stdout.write(
      runGraphify(graphifyArguments, { cwd: context.repositoryRoot }),
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function status() {
  const context = repositoryContext();
  const baseSha = gitText(
    context.repositoryRoot,
    "merge-base",
    "HEAD",
    "refs/remotes/origin/main",
  );
  console.log(`Branch head: ${context.head}`);
  console.log(`Origin main: ${context.originMain}`);
  console.log(`Graph base: ${baseSha}`);
  const root = snapshotDirectory(context.cacheRoot, baseSha);
  if (!existsSync(root)) {
    console.log("Graph snapshot: unavailable; inspect source directly.");
    process.exitCode = 2;
    return;
  }
  const snapshot = verifySnapshot(context, baseSha);
  console.log(`Graph snapshot: verified (${snapshot.metadata.scope})`);
  console.log(
    `Branch-modified files excluded on query: ${
      changedPaths(context, baseSha).size
    }`,
  );
}

function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "refresh") {
    refresh();
  } else if (command === "query") {
    query(arguments_);
  } else if (command === "status") {
    status();
  } else {
    fail(
      "Usage: node scripts/graphify-index.mjs <refresh|status|query> [...args]",
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

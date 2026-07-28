#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
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
const remoteRefreshLeaseMs = 4 * 60 * 60 * 1_000;

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

function trackedPaths(repositoryRoot, commitSha) {
  return new Set(
    splitNullDelimited(
      runGit(repositoryRoot, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "--full-tree",
        commitSha,
      ]),
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

function validateSnapshot(
  context,
  commitSha,
  metadata,
  graphBytes,
  graph,
  graphFile,
) {
  if (
    metadata.schemaVersion !== schemaVersion ||
    metadata.ref !== "refs/remotes/origin/main" ||
    metadata.scope !== "code" ||
    metadata.sourcePathFormat !== "repository-relative" ||
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
  const tracked = trackedPaths(context.repositoryRoot, commitSha);
  for (const item of [
    ...graph.nodes,
    ...(graph.links ?? graph.edges),
  ]) {
    if (!item.source_file) continue;
    const source = repositoryRelativeSource(item.source_file);
    if (source === null || !tracked.has(source)) {
      fail(
        `Graph snapshot source path does not match ${commitSha}: ` +
          item.source_file,
      );
    }
  }
}

function verifySnapshot(context, commitSha) {
  const root = snapshotDirectory(context.cacheRoot, commitSha);
  const metadata = readJson(join(root, "metadata.json"), "Graph metadata");
  const graphFile = graphPath(root);
  const graphBytes = readFileSync(graphFile);
  const graph = readJson(graphFile, "Graph snapshot");
  validateSnapshot(
    context,
    commitSha,
    metadata,
    graphBytes,
    graph,
    graphFile,
  );
  return { root, metadata, graph };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireRefreshLock(cacheRoot) {
  const lock = join(cacheRoot, "refresh.lock");
  const ownerToken = randomUUID();
  mkdirSync(cacheRoot, { recursive: true });
  while (true) {
    const candidate = join(
      cacheRoot,
      `refresh.lock.candidate-${process.pid}-${randomUUID()}`,
    );
    mkdirSync(candidate);
    writeFileSync(
      join(candidate, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        token: ownerToken,
        startedAt: new Date().toISOString(),
      }),
    );
    try {
      renameSync(candidate, lock);
      break;
    } catch (error) {
      rmSync(candidate, { recursive: true, force: true });
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") {
        throw error;
      }
      const owner = readJson(
        join(lock, "owner.json"),
        "Graphify refresh lock owner",
      );
      const sameHost = owner.hostname === hostname();
      const age = Date.now() - Date.parse(owner.startedAt);
      const remoteLeaseActive =
        Number.isFinite(age) &&
        age >= -60_000 &&
        age < remoteRefreshLeaseMs;
      const active = sameHost
        ? processIsAlive(owner.pid)
        : remoteLeaseActive;
      if (active) {
        fail("Another Graphify refresh is already running.");
      }
      const stale = join(
        cacheRoot,
        `refresh.lock.stale-${process.pid}-${randomUUID()}`,
      );
      try {
        renameSync(lock, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (reclaimError) {
        if (
          reclaimError?.code !== "ENOENT" &&
          reclaimError?.code !== "EEXIST" &&
          reclaimError?.code !== "ENOTEMPTY"
        ) {
          throw reclaimError;
        }
      }
    }
  }
  return () => {
    try {
      const owner = readJson(
        join(lock, "owner.json"),
        "Graphify refresh lock owner",
      );
      if (owner.token === ownerToken) {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  };
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

function assertRefreshWorktree(context) {
  const head = gitText(context.repositoryRoot, "rev-parse", "HEAD");
  const originMain = gitText(
    context.repositoryRoot,
    "rev-parse",
    "refs/remotes/origin/main",
  );
  if (head !== context.head || originMain !== context.head) {
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
}

function archiveCommit(context, destination) {
  mkdirSync(destination, { recursive: true });
  const archive = runGit(
    context.repositoryRoot,
    ["archive", "--format=tar", context.head],
    { binary: true },
  );
  const result = spawnSync("tar", ["-xf", "-", "-C", destination], {
    input: archive,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    fail(
      `Could not unpack immutable source archive: ${
        result.error?.message ?? result.stderr?.trim() ?? result.status
      }`,
    );
  }
}

function normalizeGraphSources(graph, sourceRoot, tracked) {
  for (const item of [
    ...graph.nodes,
    ...(graph.links ?? graph.edges),
  ]) {
    if (!item.source_file) continue;
    const source = repositoryRelativeSource(item.source_file, sourceRoot);
    if (source === null || !tracked.has(source)) {
      fail(
        `Graphify emitted a source path outside the pinned tree: ` +
          item.source_file,
      );
    }
    item.source_file = source;
  }
}

function refresh() {
  const context = repositoryContext();
  assertRefreshWorktree(context);

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
  const sourceRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "foundry-graphify-source-")),
  );
  try {
    if (existsSync(existing)) {
      verifySnapshot(context, context.head);
      console.log(`Graph snapshot already exists: ${context.head}`);
      return;
    }
    mkdirSync(dirname(staging), { recursive: true });
    archiveCommit(context, sourceRoot);
    runGraphify(
      [
        "extract",
        sourceRoot,
        "--code-only",
        "--no-cluster",
        "--out",
        staging,
      ],
      { cwd: sourceRoot },
    );
    const stagedGraphPath = graphPath(staging);
    const graph = readJson(stagedGraphPath, "Staged Graphify graph");
    validateGraph(graph, stagedGraphPath);
    normalizeGraphSources(
      graph,
      sourceRoot,
      trackedPaths(context.repositoryRoot, context.head),
    );
    const graphBytes = Buffer.from(`${JSON.stringify(graph)}\n`);
    writeFileSync(stagedGraphPath, graphBytes);
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
      sourcePathFormat: "repository-relative",
      sourceManifestSha256: manifestHash(
        context.repositoryRoot,
        context.head,
      ),
      graphSha256: sha256(graphBytes),
      scope: "code",
    };
    assertRefreshWorktree(context);
    validateSnapshot(
      context,
      context.head,
      metadata,
      graphBytes,
      graph,
      stagedGraphPath,
    );
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
    rmSync(sourceRoot, { recursive: true, force: true });
    releaseLock();
  }
}

function splitNullDelimited(value) {
  return value.split("\0").filter(Boolean);
}

function changedPaths(context, baseSha) {
  const commands = [
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
      `${baseSha}...HEAD`,
    ],
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
    ],
    [
      "diff",
      "--cached",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACDMRTUXB",
    ],
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

function repositoryRelativeSource(sourceFile, sourceRoot = null) {
  if (typeof sourceFile !== "string" || sourceFile === "") return null;
  if (!isAbsolute(sourceFile)) {
    const normalized = portablePath(sourceFile).replace(/^\.\//u, "");
    return normalized.startsWith("../") ? null : normalized;
  }
  if (sourceRoot === null) return null;
  const candidate = portablePath(relative(sourceRoot, sourceFile));
  return candidate === ".." || candidate.startsWith("../") ? null : candidate;
}

function edgeEndpointId(endpoint) {
  return typeof endpoint === "object" && endpoint !== null
    ? endpoint.id
    : endpoint;
}

function filterGraph(graph, changed) {
  const removed = new Set();
  const nodes = graph.nodes.filter((node) => {
    if (!node.source_file) return true;
    const source = repositoryRelativeSource(node.source_file);
    const keep = source !== null && !changed.has(source);
    if (!keep) removed.add(node.id);
    return keep;
  });
  const edgeKey = Array.isArray(graph.links) ? "links" : "edges";
  const edges = graph[edgeKey].filter((edge) => {
    const sourceFile = edge.source_file
      ? repositoryRelativeSource(edge.source_file)
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
  const filtered = filterGraph(snapshot.graph, changed);
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

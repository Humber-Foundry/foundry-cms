import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const graphifyIndexScript = join(
  repositoryRoot,
  "scripts",
  "graphify-index.mjs",
);

function git(repository, ...arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
  }).trim();
}

function commitAll(repository, message) {
  git(repository, "add", ".");
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "foundry-graphify-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "stable.ts"), "export const stable = true;\n");
  writeFileSync(join(root, "src", "changed.ts"), "export const changed = 1;\n");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Graphify Test");
  git(root, "config", "user.email", "graphify@example.test");
  git(root, "remote", "add", "origin", ".");
  const main = commitAll(root, "initial");
  git(root, "update-ref", "refs/remotes/origin/main", main);
  return { root, main };
}

function createFakeGraphify() {
  const executable = join(
    mkdtempSync(join(tmpdir(), "foundry-fake-graphify-")),
    "fake-graphify.mjs",
  );
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("graphify 9.9.9-test");
  process.exit(0);
}
if (args[0] === "extract") {
  const output = args[args.indexOf("--out") + 1];
  const graphDirectory = join(output, "graphify-out");
  mkdirSync(graphDirectory, { recursive: true });
  writeFileSync(
    join(graphDirectory, "graph.json"),
    readFileSync(process.env.GRAPHIFY_FAKE_GRAPH, "utf8"),
  );
  process.exit(0);
}
if (args[0] === "query") {
  const graph = JSON.parse(
    readFileSync(args[args.indexOf("--graph") + 1], "utf8"),
  );
  for (const node of graph.nodes ?? []) {
    console.log(\`NODE \${node.label} [src=\${node.source_file ?? ""}]\`);
  }
  process.exit(0);
}
console.error("unexpected fake graphify invocation", args);
process.exit(2);
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

function writeFakeGraph(repository) {
  const canonicalRepository = git(repository, "rev-parse", "--show-toplevel");
  const graph = join(
    mkdtempSync(join(tmpdir(), "foundry-fake-graph-")),
    "graph.json",
  );
  writeFileSync(
    graph,
    JSON.stringify({
      directed: true,
      multigraph: false,
      graph: {},
      nodes: [
        {
          id: "stable",
          label: "Stable",
          source_file: join(canonicalRepository, "src", "stable.ts"),
          source_location: "L1",
        },
        {
          id: "changed",
          label: "Changed",
          source_file: join(canonicalRepository, "src", "changed.ts"),
          source_location: "L1",
        },
      ],
      links: [
        {
          source: "stable",
          target: "changed",
          relation: "imports",
          source_file: join(canonicalRepository, "src", "stable.ts"),
        },
      ],
    }),
  );
  return graph;
}

function runIndex(repository, arguments_, options = {}) {
  const cache =
    options.cache ?? mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
  const graphify = options.graphify ?? createFakeGraphify();
  const graph = options.graph ?? writeFakeGraph(repository);
  try {
    return {
      status: 0,
      output: execFileSync(
        process.execPath,
        [graphifyIndexScript, ...arguments_],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            GRAPHIFY_BIN: graphify,
            GRAPHIFY_FAKE_GRAPH: graph,
            GRAPHIFY_INDEX_CACHE_DIR: cache,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      cache,
    };
  } catch (error) {
    return {
      status: error.status,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      cache,
    };
  }
}

describe("commit-pinned Graphify index", () => {
  it("publishes an immutable snapshot for the exact current main commit", () => {
    const { root, main } = createRepository();
    const result = runIndex(root, ["refresh"]);

    expect(result.status, result.output).toBe(0);
    const metadataPath = join(
      result.cache,
      "snapshots",
      main,
      "metadata.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    expect(metadata).toMatchObject({
      schemaVersion: "foundry.graphify-index/v1",
      commitSha: main,
      graphifyVersion: "graphify 9.9.9-test",
      scope: "code",
    });
    expect(
      readFileSync(
        join(result.cache, "snapshots", main, "graphify-out", "graph.json"),
        "utf8",
      ),
    ).toContain('"stable"');
  });

  it("uses the branch merge-base snapshot and excludes branch-modified files", () => {
    const { root, main } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    writeFileSync(join(root, "src", "changed.ts"), "export const changed = 2;\n");
    commitAll(root, "change indexed source");

    const result = runIndex(root, ["query", "stable changed"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`Graph base: ${main}`);
    expect(result.output).toContain("Branch-modified files excluded: 1");
    expect(result.output).toContain("NODE Stable");
    expect(result.output).not.toContain("NODE Changed");
  });

  it("excludes staged and unstaged files before querying", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    writeFileSync(join(root, "src", "stable.ts"), "export const stable = false;\n");
    writeFileSync(join(root, "src", "changed.ts"), "export const changed = 2;\n");
    git(root, "add", "src/changed.ts");

    const result = runIndex(root, ["query", "stable changed"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Branch-modified files excluded: 2");
    expect(result.output).not.toContain("NODE Stable");
    expect(result.output).not.toContain("NODE Changed");
  });

  it("fails closed when a branch has integrated main without a matching snapshot", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    git(root, "checkout", "main");
    writeFileSync(join(root, "src", "new-main.ts"), "export const main = 2;\n");
    const newMain = commitAll(root, "advance main");
    git(root, "update-ref", "refs/remotes/origin/main", newMain);
    git(root, "checkout", "feature");
    git(root, "merge", "--no-edit", "main");

    const result = runIndex(root, ["query", "stable"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      `No immutable Graphify snapshot exists for branch base ${newMain}`,
    );
  });

  it("rejects a snapshot whose graph no longer matches its metadata hash", () => {
    const { root, main } = createRepository();
    const result = runIndex(root, ["refresh"]);
    expect(result.status, result.output).toBe(0);
    writeFileSync(
      join(
        result.cache,
        "snapshots",
        main,
        "graphify-out",
        "graph.json",
      ),
      '{"nodes":[],"links":[]}',
    );

    const query = runIndex(root, ["query", "stable"], {
      cache: result.cache,
    });

    expect(query.status).not.toBe(0);
    expect(query.output).toContain("Graph snapshot integrity check failed");
  });

  it("rejects a successful extractor process that emits an empty graph", () => {
    const { root } = createRepository();
    const emptyGraph = join(
      mkdtempSync(join(tmpdir(), "foundry-empty-graph-")),
      "graph.json",
    );
    writeFileSync(
      emptyGraph,
      JSON.stringify({
        directed: true,
        multigraph: false,
        graph: {},
        nodes: [],
        links: [],
      }),
    );

    const result = runIndex(root, ["refresh"], { graph: emptyGraph });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Graphify produced an invalid or empty graph",
    );
  });

  it("refuses to refresh from a feature branch or a dirty main worktree", () => {
    const { root } = createRepository();
    git(root, "checkout", "-b", "feature");
    writeFileSync(join(root, "src", "feature.ts"), "export const feature = true;\n");
    commitAll(root, "advance feature");
    const featureResult = runIndex(root, ["refresh"]);
    expect(featureResult.status).not.toBe(0);
    expect(featureResult.output).toContain(
      "Graph snapshots can only be refreshed at the exact origin/main commit",
    );

    git(root, "checkout", "main");
    writeFileSync(join(root, "src", "stable.ts"), "export const stable = false;\n");
    const dirtyResult = runIndex(root, ["refresh"]);
    expect(dirtyResult.status).not.toBe(0);
    expect(dirtyResult.output).toContain(
      "Graph snapshots require a clean main worktree",
    );
  });
});

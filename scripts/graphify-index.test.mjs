import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const graphifyIndexScript = join(
  repositoryRoot,
  "scripts",
  "graphify-index.mjs",
);
const refreshLockRef = "refs/graphify/refresh-lock";

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

function setRefreshLock(repository, owner) {
  const oid = execFileSync(
    "git",
    ["hash-object", "-w", "--stdin"],
    {
      cwd: repository,
      encoding: "utf8",
      input: JSON.stringify(owner),
    },
  ).trim();
  git(repository, "update-ref", refreshLockRef, oid);
  return oid;
}

function getRefreshLock(repository) {
  try {
    return git(repository, "rev-parse", "--verify", "--quiet", refreshLockRef);
  } catch {
    return null;
  }
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
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("graphify 9.9.9-test");
  process.exit(0);
}
if (args[0] === "extract") {
  const delay = Number(process.env.GRAPHIFY_FAKE_DELAY_MS ?? "0");
  if (delay > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  if (process.env.GRAPHIFY_FAKE_REPLACE_LOCK === "1") {
    const replacement = execFileSync(
      "git",
      ["hash-object", "-w", "--stdin"],
      {
        cwd: process.env.GRAPHIFY_FAKE_REPOSITORY_ROOT,
        encoding: "utf8",
        input: JSON.stringify({
          pid: process.pid,
          hostname: "replacement-owner",
          token: "replacement-owner",
          startedAt: new Date().toISOString(),
        }),
      },
    ).trim();
    execFileSync(
      "git",
      ["update-ref", "${refreshLockRef}", replacement],
      { cwd: process.env.GRAPHIFY_FAKE_REPOSITORY_ROOT },
    );
  }
  const sourceRoot = args[1];
  const output = args[args.indexOf("--out") + 1];
  const graphDirectory = join(output, "graphify-out");
  mkdirSync(graphDirectory, { recursive: true });
  const graph = JSON.parse(
    readFileSync(process.env.GRAPHIFY_FAKE_GRAPH, "utf8"),
  );
  for (const item of [
    ...(graph.nodes ?? []),
    ...(graph.links ?? graph.edges ?? []),
  ]) {
    if (item.source_file?.startsWith(process.env.GRAPHIFY_FAKE_REPOSITORY_ROOT)) {
      item.source_file =
        sourceRoot +
        item.source_file.slice(
          process.env.GRAPHIFY_FAKE_REPOSITORY_ROOT.length,
        );
    }
  }
  writeFileSync(
    join(graphDirectory, "graph.json"),
    JSON.stringify(graph),
  );
  if (process.env.GRAPHIFY_FAKE_WARNING === "1") {
    console.error("  warning: worker failed for src/changed.ts: simulated failure");
  }
  if (process.env.GRAPHIFY_FAKE_WARNING === "zero-nodes") {
    console.error(
      "  warning: 1 source file(s) produced zero nodes and are absent from the graph: changed.ts.",
    );
  }
  if (process.env.GRAPHIFY_FAKE_WARNING === "scan-failure") {
    console.error(
      "[graphify] WARNING: could not scan src/private (permission denied); its files are missing from this run's enumeration.",
    );
  }
  if (process.env.GRAPHIFY_FAKE_WARNING === "resolver-failure") {
    console.error(
      "typescript_member_calls resolution failed, skipping: simulated failure",
    );
  }
  if (process.env.GRAPHIFY_FAKE_WARNING === "non-warning-resolution") {
    console.error(
      "Graphify status: resolution failed during an earlier attempt; recovered.",
    );
  }
  if (process.env.GRAPHIFY_FAKE_MUTATE_REPOSITORY === "1") {
    writeFileSync(
      join(
        process.env.GRAPHIFY_FAKE_REPOSITORY_ROOT,
        "src",
        "stable.ts",
      ),
      "export const stable = false;\\n",
    );
  }
  process.exit(0);
}
if (args[0] === "query") {
  const graph = JSON.parse(
    readFileSync(args[args.indexOf("--graph") + 1], "utf8"),
  );
  for (const node of graph.nodes ?? []) {
    console.log(\`NODE \${node.label} [src=\${node.source_file ?? ""}]\`);
  }
  for (const edge of graph.links ?? graph.edges ?? []) {
    console.log(\`EDGE \${edge.source} -> \${edge.target}\`);
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
        {
          source: "stable",
          target: "external",
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
            GRAPHIFY_FAKE_REPOSITORY_ROOT: git(
              repository,
              "rev-parse",
              "--show-toplevel",
            ),
            GRAPHIFY_FAKE_MUTATE_REPOSITORY: options.mutateRepository
              ? "1"
              : "0",
            GRAPHIFY_FAKE_WARNING:
              typeof options.warning === "string"
                ? options.warning
                : options.warning
                  ? "1"
                  : "0",
            GRAPHIFY_FAKE_DELAY_MS: String(options.delayMs ?? 0),
            GRAPHIFY_FAKE_REPLACE_LOCK: options.replaceLock ? "1" : "0",
            GRAPHIFY_INDEX_CACHE_DIR: cache,
            ...options.env,
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

function runIndexAsync(repository, arguments_, options) {
  return new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      [graphifyIndexScript, ...arguments_],
      {
        cwd: repository,
        env: {
          ...process.env,
          GRAPHIFY_BIN: options.graphify,
          GRAPHIFY_FAKE_GRAPH: options.graph,
          GRAPHIFY_FAKE_REPOSITORY_ROOT: git(
            repository,
            "rev-parse",
            "--show-toplevel",
          ),
          GRAPHIFY_FAKE_MUTATE_REPOSITORY: "0",
          GRAPHIFY_FAKE_WARNING: "0",
          GRAPHIFY_FAKE_DELAY_MS: String(options.delayMs ?? 0),
          GRAPHIFY_FAKE_REPLACE_LOCK: "0",
          GRAPHIFY_INDEX_CACHE_DIR: options.cache,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (status) => {
      resolveResult({ status, output });
    });
  });
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
    const graph = JSON.parse(
      readFileSync(
        join(result.cache, "snapshots", main, "graphify-out", "graph.json"),
        "utf8",
      ),
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "stable",
        source_file: "src/stable.ts",
      }),
    );
  });

  it("stores a credential-free repository identity across remote credential rotation", () => {
    const { root, main } = createRepository();
    git(
      root,
      "remote",
      "set-url",
      "origin",
      "https://automation:initial-secret@example.test/foundry/cms.git",
    );

    const result = runIndex(root, ["refresh"]);
    expect(result.status, result.output).toBe(0);
    const metadata = JSON.parse(
      readFileSync(
        join(result.cache, "snapshots", main, "metadata.json"),
        "utf8",
      ),
    );
    expect(metadata.repository).toBe(
      "remote:example.test/foundry/cms",
    );
    expect(JSON.stringify(metadata)).not.toContain("initial-secret");

    git(
      root,
      "remote",
      "set-url",
      "origin",
      "git@example.test:foundry/cms.git",
    );
    const scpStatus = runIndex(root, ["status"], { cache: result.cache });

    expect(scpStatus.status, scpStatus.output).toBe(0);
    expect(scpStatus.output).toContain("Graph snapshot: verified (code)");

    git(
      root,
      "remote",
      "set-url",
      "origin",
      "ssh://git@example.test/foundry/cms.git",
    );
    const sshStatus = runIndex(root, ["status"], { cache: result.cache });

    expect(sshStatus.status, sshStatus.output).toBe(0);
    expect(sshStatus.output).toContain("Graph snapshot: verified (code)");
  });

  it("treats local-path and file URL remotes as the same repository", () => {
    const { root } = createRepository();
    const result = runIndex(root, ["refresh"]);
    expect(result.status, result.output).toBe(0);

    git(
      root,
      "remote",
      "set-url",
      "origin",
      pathToFileURL(root).href,
    );
    const status = runIndex(root, ["status"], { cache: result.cache });

    expect(status.status, status.output).toBe(0);
    expect(status.output).toContain("Graph snapshot: verified (code)");
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

  it("excludes both sides of committed and staged renames", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    git(root, "mv", "src/stable.ts", "src/stable-renamed.ts");
    commitAll(root, "rename stable source");
    git(root, "mv", "src/changed.ts", "src/changed-renamed.ts");

    const result = runIndex(root, ["query", "stable changed"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Branch-modified files excluded: 4");
    expect(result.output).not.toContain("NODE Stable");
    expect(result.output).not.toContain("NODE Changed");
  });

  it("drops all relationships when branch changes can affect module resolution", () => {
    const { root } = createRepository();
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["src/*"] } } }),
    );
    const main = commitAll(root, "add resolver configuration");
    git(root, "update-ref", "refs/remotes/origin/main", main);
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["other/*"] } } }),
    );

    const result = runIndex(root, ["query", "stable"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Graph relationships excluded");
    expect(result.output).toContain("NODE Stable");
    expect(result.output).not.toContain("EDGE stable -> changed");
  });

  it.each([".graphifyignore", "src/.gitignore"])(
    "fails closed when branch ignore rules differ at %s",
    (ignorePath) => {
      const { root } = createRepository();
      const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
      const graphify = createFakeGraphify();
      const graph = writeFakeGraph(root);
      expect(
        runIndex(root, ["refresh"], { cache, graphify, graph }).status,
      ).toBe(0);

      git(root, "checkout", "-b", "feature");
      writeFileSync(join(root, ignorePath), "/stable.ts\n");

      const query = runIndex(root, ["query", "stable"], {
        cache,
        graphify,
        graph,
      });
      const status = runIndex(root, ["status"], {
        cache,
        graphify,
        graph,
      });

      expect(query.status).not.toBe(0);
      expect(query.output).toContain(
        "Graph snapshot is unavailable because branch ignore rules changed",
      );
      expect(status.status).not.toBe(0);
      expect(status.output).toContain(
        "Graph snapshot is unavailable because branch ignore rules changed",
      );
    },
  );

  it("fails closed when an untracked ignore file hides itself", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    writeFileSync(
      join(root, ".gitignore"),
      ".gitignore\n.graphifyignore\n",
    );
    writeFileSync(join(root, ".graphifyignore"), "/src/stable.ts\n");
    expect(git(root, "status", "--porcelain")).toBe("");

    const query = runIndex(root, ["query", "stable"], {
      cache,
      graphify,
      graph,
    });
    const status = runIndex(root, ["status"], {
      cache,
      graphify,
      graph,
    });

    expect(query.status).not.toBe(0);
    expect(query.output).toContain(".gitignore");
    expect(query.output).toContain(".graphifyignore");
    expect(status.status).not.toBe(0);
    expect(status.output).toContain(
      "Graph snapshot is unavailable because branch ignore rules changed",
    );
  });

  it("reports status unavailable when the Graphify executable cannot start", () => {
    const { root } = createRepository();
    const result = runIndex(root, ["refresh"]);
    expect(result.status, result.output).toBe(0);

    const status = runIndex(root, ["status"], {
      cache: result.cache,
      env: { GRAPHIFY_BIN: "/definitely/missing/graphify" },
    });

    expect(status.status).not.toBe(0);
    expect(status.output).toContain(
      "Graphify is not installed or did not report its version",
    );
    expect(status.output).not.toContain("Graph snapshot: verified");
  });

  it("drops all relationships when an added file can become a resolution target", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    writeFileSync(join(root, "src", "new-target.ts"), "export const target = 1;\n");

    const result = runIndex(root, ["query", "stable"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Graph relationships excluded");
    expect(result.output).toContain("src/new-target.ts");
    expect(result.output).not.toContain("EDGE stable -> changed");
  });

  it("drops all relationships when an extended JSON config changes", () => {
    const { root } = createRepository();
    mkdirSync(join(root, "config"));
    writeFileSync(
      join(root, "config", "aliases.json"),
      JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["src/*"] } } }),
    );
    const main = commitAll(root, "add extended resolver config");
    git(root, "update-ref", "refs/remotes/origin/main", main);
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    writeFileSync(
      join(root, "config", "aliases.json"),
      JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["other/*"] } } }),
    );

    const result = runIndex(root, ["query", "stable"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Graph relationships excluded");
    expect(result.output).toContain("config/aliases.json");
    expect(result.output).not.toContain("EDGE stable -> external");
  });

  it("drops unrelated relationships when only an indexed source changes", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    expect(
      runIndex(root, ["refresh"], { cache, graphify, graph }).status,
    ).toBe(0);

    git(root, "checkout", "-b", "feature");
    writeFileSync(join(root, "src", "changed.ts"), "export const changed = 2;\n");

    const result = runIndex(root, ["query", "stable"], {
      cache,
      graphify,
      graph,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Graph relationships excluded");
    expect(result.output).toContain("src/changed.ts");
    expect(result.output).not.toContain("EDGE stable -> external");
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

  it("rejects snapshot source-path metadata that is not repository-relative", () => {
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
    metadata.sourcePathFormat = "absolute";
    writeFileSync(metadataPath, JSON.stringify(metadata));

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

  it("rejects a successful extractor process that reports partial extraction", () => {
    const { root, main } = createRepository();
    const result = runIndex(root, ["refresh"], { warning: true });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Graphify extraction reported incomplete results",
    );
    expect(result.output).toContain("warning: worker failed");
    expect(
      existsSync(join(result.cache, "snapshots", main)),
    ).toBe(false);
  });

  it("rejects a successful extractor process that reports zero-node sources", () => {
    const { root, main } = createRepository();
    const result = runIndex(root, ["refresh"], {
      warning: "zero-nodes",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Graphify extraction reported incomplete results",
    );
    expect(result.output).toContain("produced zero nodes");
    expect(
      existsSync(join(result.cache, "snapshots", main)),
    ).toBe(false);
  });

  it.each([
    ["an incomplete directory scan", "scan-failure"],
    ["a failed registered resolver", "resolver-failure"],
  ])("rejects %s reported by Graphify", (_label, warning) => {
    const { root, main } = createRepository();

    const result = runIndex(root, ["refresh"], { warning });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Graphify extraction reported incomplete results",
    );
    expect(
      existsSync(join(result.cache, "snapshots", main)),
    ).toBe(false);
  });

  it("accepts non-warning stderr that describes a recovered resolution failure", () => {
    const { root } = createRepository();

    const result = runIndex(root, ["refresh"], {
      warning: "non-warning-resolution",
    });

    expect(result.status, result.output).toBe(0);
  });

  it("retains active and recent snapshots while pruning older cache entries", () => {
    const { root, main } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const snapshots = join(cache, "snapshots");
    mkdirSync(snapshots, { recursive: true });
    for (let index = 0; index < 24; index += 1) {
      const commitSha = index.toString(16).padStart(40, "0");
      const directory = join(snapshots, commitSha);
      mkdirSync(directory);
      writeFileSync(
        join(directory, "metadata.json"),
        JSON.stringify({
          generatedAt: new Date(index * 1_000).toISOString(),
        }),
      );
    }
    writeFileSync(
      join(cache, "gc-candidates.json"),
      JSON.stringify({
        schemaVersion: "foundry.graphify-index/v1",
        candidates: Object.fromEntries(
          Array.from({ length: 24 }, (_, index) => [
            index.toString(16).padStart(40, "0"),
            new Date(0).toISOString(),
          ]),
        ),
      }),
    );

    const result = runIndex(root, ["refresh"], { cache });

    expect(result.status, result.output).toBe(0);
    const retained = readdirSync(snapshots);
    expect(retained).toContain(main);
    expect(retained.length).toBe(20);
    expect(retained).not.toContain("0".repeat(40));
  });

  it("marks inactive overflow snapshots before deleting them on a later refresh", () => {
    const { root, main } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const snapshots = join(cache, "snapshots");
    mkdirSync(snapshots, { recursive: true });
    for (let index = 0; index < 24; index += 1) {
      const directory = join(
        snapshots,
        index.toString(16).padStart(40, "0"),
      );
      mkdirSync(directory);
      writeFileSync(
        join(directory, "metadata.json"),
        JSON.stringify({
          generatedAt: new Date(index * 1_000).toISOString(),
        }),
      );
    }

    const result = runIndex(root, ["refresh"], { cache });

    expect(result.status, result.output).toBe(0);
    expect(readdirSync(snapshots)).toHaveLength(25);
    expect(readdirSync(snapshots)).toContain(main);
    const gcState = JSON.parse(
      readFileSync(join(cache, "gc-candidates.json"), "utf8"),
    );
    expect(Object.keys(gcState.candidates)).toHaveLength(5);
  });

  it("preserves an older snapshot used as an active worktree merge base", () => {
    const { root, main: oldMain } = createRepository();
    const featureWorktree = mkdtempSync(
      join(tmpdir(), "foundry-graphify-worktree-"),
    );
    git(root, "worktree", "add", "-b", "feature", featureWorktree, oldMain);
    writeFileSync(join(root, "src", "main-only.ts"), "export const main = 2;\n");
    const newMain = commitAll(root, "advance main");
    git(root, "update-ref", "refs/remotes/origin/main", newMain);

    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const snapshots = join(cache, "snapshots");
    mkdirSync(snapshots, { recursive: true });
    const oldSnapshot = join(snapshots, oldMain);
    mkdirSync(oldSnapshot);
    writeFileSync(
      join(oldSnapshot, "metadata.json"),
      JSON.stringify({ generatedAt: new Date(0).toISOString() }),
    );
    for (let index = 1; index <= 24; index += 1) {
      const directory = join(
        snapshots,
        index.toString(16).padStart(40, "0"),
      );
      mkdirSync(directory);
      writeFileSync(
        join(directory, "metadata.json"),
        JSON.stringify({
          generatedAt: new Date(index * 1_000).toISOString(),
        }),
      );
    }
    writeFileSync(
      join(cache, "gc-candidates.json"),
      JSON.stringify({
        schemaVersion: "foundry.graphify-index/v1",
        candidates: {
          [oldMain]: new Date(0).toISOString(),
          ...Object.fromEntries(
            Array.from({ length: 24 }, (_, index) => [
              (index + 1).toString(16).padStart(40, "0"),
              new Date(0).toISOString(),
            ]),
          ),
        },
      }),
    );

    const result = runIndex(root, ["refresh"], { cache });

    expect(result.status, result.output).toBe(0);
    const retained = readdirSync(snapshots);
    expect(retained).toContain(newMain);
    expect(retained).toContain(oldMain);
    expect(retained.length).toBe(21);
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

  it("refuses publication if the main worktree changes during extraction", () => {
    const { root, main } = createRepository();
    const result = runIndex(root, ["refresh"], {
      mutateRepository: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Graph snapshots require a clean main worktree",
    );
    expect(
      existsSync(join(result.cache, "snapshots", main)),
    ).toBe(false);
  });

  it("reclaims a dead refresh lock but preserves a live owner's lock", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    setRefreshLock(root, {
      pid: 999_999,
      hostname: hostname(),
      startedAt: new Date(0).toISOString(),
    });

    const reclaimed = runIndex(root, ["refresh"], { cache });
    expect(reclaimed.status, reclaimed.output).toBe(0);
    expect(getRefreshLock(root)).toBeNull();

    const liveCache = mkdtempSync(
      join(tmpdir(), "foundry-graphify-cache-"),
    );
    const liveOid = setRefreshLock(root, {
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    });

    const blocked = runIndex(root, ["refresh"], { cache: liveCache });
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain(
      "Another Graphify refresh is already running",
    );
    expect(getRefreshLock(root)).toBe(liveOid);
  });

  it("releases the refresh lock when temporary source setup fails", () => {
    const { root } = createRepository();
    const invalidTemporaryDirectory = join(
      mkdtempSync(join(tmpdir(), "foundry-graphify-invalid-tmp-")),
      "not-a-directory",
    );
    writeFileSync(invalidTemporaryDirectory, "not a directory\n");

    const result = runIndex(root, ["refresh"], {
      env: { TMPDIR: invalidTemporaryDirectory },
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("ENOTDIR");
    expect(getRefreshLock(root)).toBeNull();
  });

  it("releases the refresh lock when temporary source cleanup fails", () => {
    const { root } = createRepository();
    const preload = join(
      mkdtempSync(join(tmpdir(), "foundry-graphify-fs-hook-")),
      "fail-source-cleanup.cjs",
    );
    writeFileSync(
      preload,
      `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalRmSync = fs.rmSync;
fs.rmSync = (path, options) => {
  if (String(path).includes("foundry-graphify-source-")) {
    throw new Error("simulated temporary source cleanup failure");
  }
  return originalRmSync(path, options);
};
syncBuiltinESMExports();
`,
    );

    const result = runIndex(root, ["refresh"], {
      env: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
          .filter(Boolean)
          .join(" "),
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "simulated temporary source cleanup failure",
    );
    expect(getRefreshLock(root)).toBeNull();
  });

  it("bounds locks owned by an unverifiable hostname", () => {
    const { root } = createRepository();
    const staleCache = mkdtempSync(
      join(tmpdir(), "foundry-graphify-cache-"),
    );
    setRefreshLock(root, {
      pid: process.pid,
      hostname: `${hostname()}-before-rename`,
      startedAt: new Date(0).toISOString(),
    });

    const reclaimed = runIndex(root, ["refresh"], {
      cache: staleCache,
    });
    expect(reclaimed.status, reclaimed.output).toBe(0);
    expect(getRefreshLock(root)).toBeNull();

    const recentCache = mkdtempSync(
      join(tmpdir(), "foundry-graphify-cache-"),
    );
    const recentOid = setRefreshLock(root, {
      pid: 999_999,
      hostname: `${hostname()}-other`,
      startedAt: new Date().toISOString(),
    });

    const blocked = runIndex(root, ["refresh"], {
      cache: recentCache,
    });
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain(
      "Another Graphify refresh is already running",
    );
    expect(getRefreshLock(root)).toBe(recentOid);
  });

  it("reclaims an expired same-host lock even when its PID exists", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    setRefreshLock(root, {
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date(0).toISOString(),
    });

    const result = runIndex(root, ["refresh"], { cache });

    expect(result.status, result.output).toBe(0);
    expect(getRefreshLock(root)).toBeNull();
  });

  it("fails closed when Git cannot update the refresh lock ref", () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const lockPath = resolve(
      root,
      git(root, "rev-parse", "--git-path", `${refreshLockRef}.lock`),
    );
    mkdirSync(resolve(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, "simulated stale Git ref lock\n");

    const result = runIndex(root, ["refresh"], { cache });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Could not atomically acquire the Graphify refresh lock",
    );
    expect(result.output).toContain("cannot lock ref");
  });

  it("fences a refresher that loses its lock during extraction", () => {
    const { root, main } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));

    const result = runIndex(root, ["refresh"], {
      cache,
      replaceLock: true,
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Graphify refresh lock ownership was lost before publication",
    );
    expect(
      existsSync(join(cache, "snapshots", main)),
    ).toBe(false);
    expect(getRefreshLock(root)).not.toBeNull();
  });

  it("atomically serializes concurrent stale-lock reclamation", async () => {
    const { root } = createRepository();
    const cache = mkdtempSync(join(tmpdir(), "foundry-graphify-cache-"));
    const graphify = createFakeGraphify();
    const graph = writeFakeGraph(root);
    setRefreshLock(root, {
      pid: 999_999,
      hostname: hostname(),
      startedAt: new Date(0).toISOString(),
    });

    const results = await Promise.all([
      runIndexAsync(root, ["refresh"], {
        cache,
        graphify,
        graph,
        delayMs: 500,
      }),
      runIndexAsync(root, ["refresh"], {
        cache,
        graphify,
        graph,
        delayMs: 500,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([0, 1]);
    expect(
      results.some((result) =>
        result.output.includes("Another Graphify refresh is already running"),
      ),
    ).toBe(true);
    expect(getRefreshLock(root)).toBeNull();
  });
});

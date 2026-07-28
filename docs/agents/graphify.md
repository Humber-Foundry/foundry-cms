# Commit-pinned Graphify navigation

Graphify provides a compact structural map for initial code navigation. It is
optional, code-only, and non-authoritative. Agents still read `CONTEXT.md`,
relevant ADRs, current source, generated artifacts, and executable tests.

## Why snapshots are immutable

Foundry work uses simultaneous Git worktrees. A single mutable "latest" graph
would let one branch silently change the context another branch consumes.
Instead, every graph is stored under the exact `main` commit it represents:

```text
<git-common-dir>/graphify-index/
├── current.json
└── snapshots/
    └── <40-character-main-sha>/
        ├── metadata.json
        └── graphify-out/
            └── graph.json
```

All worktrees share Git's common directory, but snapshot directories are
content-addressed and never updated in place. `current.json` is informational;
queries never trust it when selecting a graph.

Snapshot metadata binds the graph to:

- the repository remote;
- the exact commit and tree;
- the tracked-file manifest hash;
- the Graphify version;
- the graph content hash; and
- the repository-relative source-path format.

## Foreman refresh

After a verified merge:

1. Fetch `origin/main`.
2. Use a clean worktree whose `HEAD` exactly equals `origin/main`.
3. Run:

   ```bash
   npm run graphify:refresh
   ```

The refresh acquires an ownership-aware shared lock with Git's atomic
compare-and-swap ref update, archives the pinned commit to an immutable
temporary source tree, performs code-only extraction, validates the result,
rechecks the publishing worktree, and atomically publishes the commit-addressed
snapshot. Every indexed source path is checked against the pinned tree and
rewritten repository-relative, so query output remains usable after the
temporary archive is removed. It refuses feature commits and dirty worktrees.
If the same snapshot already exists, it verifies that snapshot while still
applying cache retention rather than rebuilding it. Each refresh retains the 20
most recent snapshots plus the merge-base snapshot of every active,
non-prunable worktree. Overflow snapshots must remain inactive across refreshes
and a 24-hour grace period, followed by a fresh active-worktree check, before
removal; this bounds the shared cache without deleting a base after one racy
observation. Every refresh owner receives a four-hour lock lease. Atomic
ownership swaps serialize simultaneous stale-lock reclaimers, while the bounded
lease prevents a crashed process, reused PID, renamed machine, or vanished
shared-storage host from blocking AFK refreshes forever.

Graphify's AST workers may be denied by an agent sandbox even when its process
exits successfully. The wrapper rejects an empty graph and rejects extraction
diagnostics that prove skipped files, failed workers, missing extractors or
dependencies, or incomplete relationship resolution. A source that legitimately
produces no graph nodes must be excluded explicitly in `.graphifyignore`;
Foundry's published Site Definition JSON is excluded there because it is data,
not code. If the refresh reports an AST permission error, incomplete result, or
empty graph, rerun the same command with approved local execution; never publish
or rely on the incomplete result.

Do not install Graphify's generic post-commit hook in this repository. It runs
independently in each worktree and does not enforce this commit-pinned
publication protocol.

## Agent queries

Check availability before broad exploration:

```bash
npm run graphify:status
```

Query through the repository wrapper:

```bash
npm run graphify:query -- "publication reconciliation" --budget 1200
npm run graphify:query -- "publication reconciliation" --dfs --budget 1200
```

The wrapper:

1. computes the worktree's merge base with local `origin/main`;
2. requires the immutable snapshot for that exact commit;
3. verifies every metadata and content hash;
4. finds committed, staged, unstaged, deleted, and untracked branch paths;
5. removes graph nodes and edges sourced from those paths;
6. removes all relationships when a new file, an indexed source change, or a
   resolver-consumed configuration change could invalidate relationships
   sourced from otherwise unchanged files; and
7. runs a budget-capped Graphify query against a temporary filtered graph.

Every result begins with the graph base, branch head, scope, and number of
branch-modified files excluded. When all relationships are excluded, the result
also identifies the invalidating paths. Inspect excluded files directly.

If a branch integrates a newer `main`, its merge base changes immediately.
Until Foreman publishes the matching snapshot, queries fail closed with a
source-inspection fallback. An older snapshot is never substituted.

## Operational boundary

- The wrapper does not fetch remotes. Foreman fetches before creating or
  updating worktrees.
- The graph indexes code only. Documentation remains a required direct read.
- Query output is a navigation hint, not proof that behavior is implemented.
- Never place credentials, environment files, generated secrets, or runtime
  data in the indexed corpus.
- Never copy snapshot data into a feature branch or commit it to the
  repository.

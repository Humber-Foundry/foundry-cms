# Repository agent instructions

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues. External contributor pull requests are also
a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, and `wontfix` workflow labels. See
`docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read the root `CONTEXT.md` and relevant
ADRs under `docs/decisions/`. See `docs/agents/domain.md`.

### Graphify navigation

Before broad code exploration, run `npm run graphify:status`. When an exact
snapshot is available, use
`npm run graphify:query -- "<question>" --budget 1200` for navigation. Use only
this repository wrapper—never a mutable `graphify-out/` directory or a direct
`graphify query` invocation.

The wrapper binds the graph to the branch's exact `origin/main` merge base,
checks its metadata and content hash, and removes every node and edge sourced
from a branch-modified or uncommitted file. If an exact snapshot is unavailable
or invalid, do not use another graph; inspect current source with `rg` and
targeted reads instead.

Graphify is navigation evidence, not current-state proof. Current source,
schemas, generated artifacts, executable tests, and runtime behavior remain
authoritative. The shared graph indexes code only, so agents must still read
`CONTEXT.md` and relevant ADRs. See `docs/agents/graphify.md`.

## Delivery policy

Implementation agents work on isolated branches and open pull requests
targeting `main`.

The Foreman is authorized to merge pull requests created by its delegated
ticket workers after all `/implement` gates pass, required CI and branch
protections are green, the final reviewed commit is current and mergeable, and
the pull request closes only its ticket—not the parent specification.

Foreman must use the repository's protected merge path or merge queue and may
not bypass protections. After merging, it must verify the exact commit landed
and the ticket closed before advancing dependent tickets.

After each verified merge, Foreman must fetch `main` and run
`npm run graphify:refresh` from a clean worktree at the exact `origin/main`
commit before advertising the new snapshot. A refresh failure makes Graphify
unavailable; it never permits an older snapshot to stand in for the new base.

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

# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Use the `gh` CLI for
all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: use `gh issue list` with the appropriate state and label
  filters and request structured JSON fields.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: use `gh issue edit` with `--add-label` or
  `--remove-label`.
- **Claim an issue**: `gh issue edit <number> --add-assignee @me`.
- **Close an issue**: prefer a pull request body containing
  `Closes #<ticket>` so GitHub closes the ticket only when the change lands.

Infer the repository from `git remote -v`; `gh` does this automatically when
run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: yes.**

External pull requests run through the same labels and states as incoming
issues:

- Read a pull request with `gh pr view <number> --comments` and inspect its
  change with `gh pr diff <number>`.
- List open pull requests with author association included, then triage only
  authors whose association is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or
  `NONE`. Leave `OWNER`, `MEMBER`, and `COLLABORATOR` work alone.
- Comment, label, or close with the corresponding `gh pr` command.

GitHub shares one number space across issues and pull requests. Resolve an
ambiguous `#<number>` as a pull request first, then fall back to an issue.

## Publishing and ticket lookup

- When a skill says "publish to the issue tracker", create a GitHub issue.
- When a skill says "fetch the relevant ticket", read the full issue and all
  comments from GitHub.
- `main` is the target branch for implementation pull requests.
- A ticket is delivered only after its exact reviewed commit lands on `main`
  and GitHub closes the ticket.

## Dependencies and the ready frontier

Use GitHub's native issue dependencies as the canonical, UI-visible blocking
graph. Add a blocking edge through GitHub's issue-dependencies API using the
blocker's numeric database ID, not its issue number or node ID. If native
dependencies are unavailable, use a `Blocked by: #<number>` line in the child
issue body.

A ticket is ready only when it is open, has the `ready-for-agent` label, has no
open blocker, has no active assignee or implementation pull request, and needs
no unresolved human decision.

## Wayfinding operations

The Wayfinder map is one issue labelled `wayfinder:map`, with investigation
tickets linked as sub-issues. Child tickets use the matching
`wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or
`wayfinder:task` label. If sub-issues are unavailable, keep the children in a
task list on the map and include `Part of #<map>` in each child.

Claim a ready child by assigning it to the current automation actor. Resolve it
by recording its answer and evidence on the ticket, closing it, and adding the
decision pointer to the map.

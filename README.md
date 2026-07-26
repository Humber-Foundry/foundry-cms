# foundry-cms
Open-source, self-hosted visual CMS for schema-bound websites on Cloudflare

## Product contracts

- [Production MCP contract](docs/mcp/README.md)
- [Guided per-client provisioning and operator CLI](docs/architecture/guided-client-provisioning.md)
- [Blog and newsletter publishing lifecycle](docs/domain/blog-newsletter-publishing-lifecycle.md)
- [Architecture decisions](docs/decisions/DECISION-LOG.md)

## Repository integrity

The repository runs an event-driven and daily integrity check over its Wayfinder
map, public GitHub metadata and tracked files.

The check enforces these invariants:

- every closed map child has a recognizable outcome comment and a decision
  pointer in its parent map;
- an open child with an explicit resolution is rejected as likely bookkeeping
  drift;
- a closed map cannot retain an open child;
- required map sections remain present;
- secret-manager references are rejected from public content; and
- optional client-specific terms are rejected without storing those terms in
  this public repository.

Configure the optional client boundary as a repository secret named
`WAYFINDER_FORBIDDEN_TERMS`. Its value is a JSON array of lowercase terms. The
workflow reports only the affected location, never the configured term.

Run the same check locally with:

```sh
node scripts/verify-repository-integrity.mjs
```

### Resolve a ticket atomically

Use the resolver instead of separately commenting, editing the map and closing a
ticket:

```sh
node scripts/resolve-wayfinder-ticket.mjs \
  --issue 42 \
  --map 1 \
  --outcome-file /path/to/outcome.md \
  --map-entry-file /path/to/map-entry.md \
  --reason completed \
  --dry-run
```

Remove `--dry-run` after reviewing the plan. The command validates the native
parent-child relationship, records one recognizable outcome, inserts one
decision pointer, closes the ticket with the requested reason, and then reads
everything back from GitHub. Re-running it is safe: completed steps are detected
and skipped.

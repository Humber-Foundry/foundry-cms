# foundry-cms
Open-source, self-hosted visual CMS for schema-bound websites on Cloudflare

## Executable reference installation

The repository is an npm workspace monorepo with three initial boundaries:

- `apps/reference-site` — the Next.js 16 App Router installation configured for
  Cloudflare Workers through OpenNext;
- `packages/site-definition` — the versioned, client-neutral Site Definition
  contract and representative published content; and
- `packages/application` — the site-scoped application query used by both the
  public renderer and `/dash`.

Install and run the local development surface:

```sh
npm install
npm run dev
```

The public site is available at `http://localhost:3000`. In local development,
`http://localhost:3000/dash` shows the read-only dashboard. Outside development,
the dashboard fails closed until the authentication adapter introduced by the
access-control work is configured.

Build and verify the Cloudflare Workers artifact:

```sh
npm run build
npm run build:worker
npm run verify:worker
```

`verify:worker` starts the built artifact in the local `workerd` runtime,
confirms the public page renders, and confirms an unconfigured production
dashboard returns a not-found response. No Cloudflare account or secret is
required.

Run the deterministic checks:

```sh
npm test
npm run typecheck
npm run verify:bundle
```

The bundle check reads the optimized build and proves that protected dashboard
client code is absent from the public route’s emitted scripts.

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

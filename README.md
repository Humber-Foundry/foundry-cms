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
`http://localhost:3000/dash` uses a local Owner identity. Outside development,
the dashboard validates Cloudflare Access and reloads the current D1 membership
on every protected request. It fails closed if the assertion, Access issuer,
application audience or database binding is absent or invalid.

Production installation supplies:

- a D1 database through the `FOUNDRY_DB` binding, after replacing the
  provisioning placeholder in `apps/reference-site/wrangler.jsonc`;
- `FOUNDRY_ACCESS_ISSUER`, set to the exact HTTPS Cloudflare Access team
  domain;
- `FOUNDRY_ACCESS_AUDIENCE`, set to the audience of the one Access application
  protecting `/dash`, `/api/foundry-cms` and preview paths; and
- `FOUNDRY_ACCESS_ACCOUNT_ID`, `FOUNDRY_ACCESS_APPLICATION_ID`,
  `FOUNDRY_ACCESS_POLICY_ID` and `FOUNDRY_ACCESS_LOGIN_METHOD_ID`, identifying
  the client-owned exact-email Allow policy and required OTP login method;
- `FOUNDRY_ACCESS_API_TOKEN`, a Worker secret restricted to Access Apps and
  Policies Write for that client account;
- `FOUNDRY_CANONICAL_ORIGIN` and a strong `FOUNDRY_CSRF_SECRET` Worker secret,
  used to bind every JSON mutation to the verified Access identity; and
- an initial Owner invitation created by guided provisioning before handoff.

Apply the checked-in D1 migration locally with:

```sh
npm run db:migrate:local --workspace @foundry/reference-site
```

Foundry stores no password or login session. Owners can invite Editors or other
Owners and activate, suspend or revoke memberships from `/dash`. Suspensions
and revocations take effect in D1 before the member's next protected request;
the database also prevents removal of the final active Owner. New invitations
remain unclaimable in `pending_access_sync` until the complete D1-derived
exact-email policy has been written to Cloudflare and read back successfully.
Failed policy work remains in a transactional outbox with bounded retry delays;
the custom Worker reconciles due work every five minutes, and Owners can also
retry immediately from the dashboard. Every member mutation carries an
idempotency key; D1 replays completed responses and blocks ambiguous duplicate
execution.

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

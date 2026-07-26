# foundry-cms
Open-source, self-hosted visual CMS for schema-bound websites on Cloudflare

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

# MCP conformance evidence

This directory indexes deterministic, sanitized release evidence for the
`foundry.mcp.v1` contract. Run `npm run verify:mcp:conformance` to execute the
raw protocol, application-security, independent-schema, snapshot-drift and
sanitization gates. Run `npm run verify:mcp:inspector` to add the pinned official
Inspector CLI check against the real production HTTP runtime through a
loopback-only fixture.

The pinned Inspector 2.1.0 requires Node 22.19 or newer; the repository engine
range is aligned with that conformance dependency and product CI runs Node 24.

The local conformance command runs the focused MCP suites and checks manifest
test IDs against an ephemeral structured Vitest report. Product CI instead
feeds the manifest gate the structured report from its single complete Vitest
run. Only exact tests reported as passed count as evidence. Temporary reports
are removed after verification; tracked evidence remains limited to this
manifest and sanitized snapshots.

The Inspector check proves initialization, session handling and discovery with
the pinned CLI version in `package.json`. It is not evidence from Claude,
ChatGPT, VS Code, Cursor, a live external account or a production installation.
Those clients and the real Cloudflare/GitHub release gate still require their
separately authorized acceptance environments; this repository does not invent
or retain transcripts for them.

The tracked Vitest snapshots contain public catalog metadata, stable safe test
identifiers, schema hashes and sanitized JSON-RPC examples. They intentionally
exclude bearer material, authorization codes, refresh values, private draft
bodies, personal data, provider responses and subscriber-like fixtures.

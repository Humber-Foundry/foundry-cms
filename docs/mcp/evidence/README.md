# MCP conformance evidence

This directory indexes deterministic, sanitized release evidence for the
`foundry.mcp.v1` contract. Run `npm run verify:mcp:conformance` to execute the
raw protocol, application-security, independent-schema, snapshot-drift and
sanitization gates. Run `npm run verify:mcp:inspector` to add the pinned official
Inspector CLI check against the real production HTTP runtime through a
loopback-only fixture.

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

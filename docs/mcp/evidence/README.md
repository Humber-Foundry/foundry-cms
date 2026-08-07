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

The evidence runner keeps Vitest's default reporter for actionable failures and
records exact statuses from Vitest's `TestModule`/`TestCase` API. It isolates
files into independently closed contexts because secondary structured reporters
and a shared multi-file programmatic context can retain a worker on Node 25.

The 18-descriptor emission matrix is a protocol-wrapper fixture: it proves that
the shipped registry and JSON-RPC runtime serialize representative success and
business-error envelopes against independently validated schemas. It does not
claim that its hand-authored application outcomes are production-application
emissions. Real application authorization, state, projection and parity are
covered by the separately named application-seam tests in the manifest.

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

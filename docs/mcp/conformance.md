# Conformance and integration-test plan

Return to the [contract index](README.md).

Production readiness requires executable evidence, not document review. Tests
run against the same MCP adapter and application layer shipped to clients, plus
at least one acceptance installation in a client-owned Cloudflare/GitHub test
account.

## Acceptance traceability

| Fixed product behavior | Protocol/application mechanism | Required evidence |
|---|---|---|
| Independently revocable, site-scoped identity | One D1 MCP actor/grant; exact resource audience; per-command grant lookup | Cross-site suite and next-call revocation test |
| Human and agent use one application/Git path | Thin adapters dispatch shared commands and publisher | Human/MCP byte, hash, commit and release-marker parity |
| Read/edit content and controlled design | Typed resources plus schema-bound patch tools | Schema, authorization and injection suites |
| Publication requires approved preview | Human-only immutable approval fingerprint; execution-time revalidation | Approval substitution and every-field invalidation tests |
| Aggregate analytics is read-only | One fixed-view read tool over D1 projection | Schema scan, suppression, quality and no-write tests |
| Subscriber-level data unavailable | No identity-bearing schema; projection allowlist; output canaries | Forbidden-output scan across success/error/export paths |
| Bulk-email sending unavailable | Only controlled test delivery; no bulk tool/parameter/application capability; campaign kind rejected by publisher/scheduler | Catalog scan, bounded test proof, direct bulk-command denial and zero bulk provider calls |
| Replayed and stale mutations are safe | Actor/site/tool-bound idempotency plus revision CAS | Retry, concurrent mutation and ambiguous-outcome fault tests |
| Publishing remains attributable | Joined actor/invocation/revision/approval/publish IDs and Git trailers | End-to-end audit-to-Git reconciliation |

## Test layers

| Layer | Evidence |
|---|---|
| Schema contract | Snapshots of MCP initialization, catalogs, JSON Schemas, annotations and representative results |
| Application parity | Human and MCP adapters dispatch identical command types and policy checks |
| Domain property tests | Revision, idempotency, approval and isolation invariants over generated command sequences |
| Protocol conformance | MCP Inspector plus raw JSON-RPC transport/auth cases |
| Security tests | OAuth, tenant isolation, injection, privacy, replay, stale-write and rate-limit suites |
| Adapter fault injection | D1, GitHub, Cloudflare and analytics delays, timeouts and ambiguous outcomes |
| Client compatibility | Current stable versions of major MCP clients using standard discovery, auth and tools |
| End-to-end acceptance | Draft → human preview/approval → Git commit → verified live release |

## Protocol and schema suite

- Negotiate MCP `2025-11-25`; reject unsupported versions with a clear protocol
  error and test explicitly supported older versions if any.
- Verify Streamable HTTP headers, Origin policy, content types, session
  lifecycle, cancellation, pagination, honest `listChanged` declarations and
  reinitialization with a replacement token after scope step-up.
- For both read-only and stepped-up tokens, require the initialized session ID
  on subsequent requests: missing is HTTP `400`, while unknown, stale or
  wrong-token is HTTP `404`.
- Validate every advertised input/output schema with the official MCP schema and
  an independent JSON Schema validator.
- Fuzz unknown fields, wrong types, excessive depth/size, Unicode, empty arrays,
  duplicate logical operations and malformed cursors.
- Confirm every tool returns schema-valid `structuredContent` and equivalent
  serialized text; execution errors use `isError: true`.
- Snapshot exact names, descriptions, required scopes, annotations and
  `taskSupport`. A review is required for drift.
- Confirm resource templates do not reveal inaccessible existence and all
  content carries correct MIME type and modification metadata.
- Confirm prompts are inert templates and cannot execute a tool during
  `prompts/get`.

## Authorization suite

- Discover RFC 9728 metadata from the `WWW-Authenticate` challenge and verify
  exact `resource`.
- Complete authorization code + PKCE S256 with client metadata, pre-registered
  client and any supported dynamic registration path.
- Reject missing PKCE support, wrong verifier, reused code, state mismatch,
  non-exact redirect URI, expired code and untrusted client metadata.
- Reject access tokens with wrong issuer, signature, algorithm, expiry,
  not-before, audience, resource, site, connection, client or token type.
- Prove tokens in URI, body or cookie are not accepted.
- Prove `site.read` is the minimal initial grant and each additional scope needs
  a fresh Owner step-up consent.
- Direct-call an omitted draft tool and prove its authenticated `403`
  `WWW-Authenticate` challenge contains `site.read` plus exactly the required
  incremental draft scope.
- Attempt step-up through another registered redirect URI for the same client
  and prove it is rejected before consent.
- Revoke an active connection and prove the next call fails despite an
  unexpired token and live MCP session.
- Rotate refresh tokens; reuse an old refresh token and verify family
  revocation.
- Capture downstream adapter requests and prove no MCP bearer reaches GitHub,
  Cloudflare or providers.

## Permission and privacy suite

Generate an allow/deny test for every cell in the
[permission matrix](permission-matrix.md), including direct calls to tools
omitted from discovery.

Seed two sites with overlapping UUID-shaped object names and distinct canary
strings. For every resource template, tool, cursor, workspace, preview,
approval and publication ID:

1. read/use it on the owning site and assert expected behavior;
2. use it with the other site's token;
3. assert a concealed denial, zero state change and no canary in body/error;
4. inspect audit for a safe denial with the correct caller site.

Seed subscriber emails, form respondent identity, recipient IDs, raw message
events, provider tokens and secret canaries. Run every tool/view/error/export
path and assert none appear. Inspect tool schemas to prove no field can request
them. Analytics tests verify fixed views, bounded ranges, small-cell
suppression, `unavailable` rather than zero and quality/freshness metadata.

An automated forbidden-capability test fails if any MCP tool name, description
or schema introduces:

```text
subscriber/contact/recipient address retrieval or recipient selection
raw event or arbitrary SQL
bulk send, email schedule or bulk-send authorization
arbitrary path/file/code/HTML/CSS/JavaScript
provider token/credential/secret
human role/membership mutation
```

Intentional descriptive denials in documentation are allowlisted separately;
runtime schemas have no such capability.

## Concurrency, replay and approval suite

- Send two patches at the same base revision. Exactly one succeeds; the other
  returns `STALE_REVISION`; no fields are silently lost.
- Replay each mutation with the same key/input before response, after response,
  after reconnect and after server restart. It returns the same result IDs and
  creates no extra revision/operation/commit.
- Reuse a key with changed input and receive `IDEMPOTENCY_KEY_REUSED`.
- Drop the response after D1 commit and after Git reference update. Retry with
  the same key and prove one revision, one commit and one build.
- Prepare preview at revision N, then mutate content, design, schema, renderer
  or production base independently. Each invalidates approval.
- Attempt publication with no approval, client-supplied approval flags, another
  site's approval, another revision's approval, revoked approval and approval
  made by a non-human actor. All fail before Git.
- Schedule an approved post, advance production base, then run scheduler. It
  blocks stale and makes no commit.
- Pass a campaign artifact to immediate and scheduled publication. Both return
  `WRONG_ARTIFACT_KIND`; no email/provider call occurs.
- Request a campaign test and prove it is bound to the exact revision, reaches
  only the configured verified test set (maximum five), returns no addresses,
  is idempotent and rate-limited, and creates no send authorization. Attempt to
  supply recipients, audience, segment or provider fields and fail schema
  validation before any provider call.
- Cancel before and after scheduler claim. Before is idempotently cancelled;
  after returns the current operation and cannot falsely report cancellation.

## Human/MCP parity and Git evidence

Create semantically identical workspaces through `/dash` and MCP. From the
shared command boundary onward, assert:

- same canonical revision and content hash;
- same validation and authorization decision types;
- same canonical preview renderer;
- same approval fingerprint fields;
- same deterministic file names and bytes;
- same one-tree/one-commit publisher path and non-force branch update;
- same release-marker verification and truthful live states; and
- same restoration path through a new draft and approval.

The Git commit is made by the installation GitHub App and contains the publish
ID, workspace, revision, approval actor reference and content hash required for
audit reconciliation. Public attribution does not expose email or impersonate a
human author.

## Injection and abuse suite

Place adversarial instructions, scripts, URLs, path traversal, CSS escapes,
oversized rich text, malformed canonical JSON and provider-shaped payloads in
every writable field. Assert:

- data cannot change tool catalog, scope, site, actor or command type;
- rich text/design serialization cannot emit executable script or
  schema-external code;
- no server-side fetch occurs for content URLs;
- output is contextually escaped in the dashboard and structured as data in
  MCP;
- rates, page sizes and patch limits activate without starving human commands;
  and
- denial/error output does not echo secrets or excessive attacker input.

## Client compatibility matrix

Test the current stable release of at least:

- Claude Desktop/Claude MCP client;
- ChatGPT connectors/custom MCP client;
- VS Code with GitHub Copilot MCP support;
- Cursor; and
- the official MCP Inspector and one direct SDK client.

For each client record:

```text
client/version
transport and negotiated protocol revision
authorization discovery/PKCE/result
structured output and execution-error rendering
resource/template/prompt discovery
tool annotation display
human-review URL handling or elicitation behavior
scope step-up behavior, including use of the token response's opaque
`connection_id` and signed `step_up_token`, exact-connection consent display,
and rejection of missing, stale or cross-connection step-up proof
reconnect/retry/idempotency behavior
known client UX limitation
```

The domain contract is not renamed, flattened or weakened for one client.
Compatibility adapters may translate transport or presentation only. A client
that cannot perform required OAuth or show safe tool confirmation is documented
as unsupported for mutation, though read-only compatibility may be offered with
a separately reviewed grant.

## Release gates

V1 cannot ship until:

- all fixed invariants in the [contract index](README.md) map to a passing
  automated test;
- every matrix denial is exercised;
- forbidden-capability and forbidden-output scans pass;
- replay/stale/fault-injection tests prove zero duplicate publications;
- human/MCP parity produces identical published bytes and Git path;
- one real Cloudflare/GitHub acceptance installation reaches a verified release
  marker;
- revocation works on the next call;
- the major-client matrix has no unresolved security-critical incompatibility;
  and
- threat-model controls have named test evidence and an owner.

CI stores sanitized protocol transcripts, schema snapshots, Git SHAs and test
IDs. It never stores tokens, authorization codes, PKCE verifiers, draft bodies,
subscriber fixtures resembling real data or provider credentials.

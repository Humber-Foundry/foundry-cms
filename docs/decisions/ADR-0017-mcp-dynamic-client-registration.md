# ADR-0017: Dynamic client registration, and consent is the only grant

- **Status:** Accepted
- **Date:** 2026-09-18

Amends the MCP contract recorded in
[authorization, approval and audit](../mcp/authorization-and-approval.md) and
issue #17. It does not change ADR-0005 (human authentication) or ADR-0007 (MCP
publication scope derivation).

## Context

A site Owner could not connect claude.ai, ChatGPT or Claude Code to their site.
The server required an operator to paste a client identifier and its exact
redirect URIs into `FOUNDRY_MCP_CLIENTS` before any client could start. A
non-technical Owner cannot do that, and a hosted client such as claude.ai will
not ask them to.

Five things blocked a real client:

1. No RFC 7591 dynamic client registration and no `registration_endpoint` in the
   authorization-server metadata.
2. The authorize endpoint refused any request that carried a parameter it did
   not know, so an ordinary OAuth parameter such as `prompt` or `nonce` failed
   the whole request.
3. A first authorization accepted exactly one scope, so a client that asked for
   read plus draft could never start.
4. Only the `2025-11-25` protocol revision was accepted, and a request with no
   `MCP-Protocol-Version` header was refused.
5. The paths a client must reach with no human present were not separated in
   writing from the paths that must stay behind Cloudflare Access.

### Sources read for this decision

Protocol and client behaviour were read from the primary sources on
2026-09-18, not from memory.

| Fact relied on | Source |
|---|---|
| Dynamic client registration is SHOULD in the `2025-06-18` revision | https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization |
| Dynamic client registration is MAY in the `2025-11-25` revision, kept for compatibility with earlier revisions | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization |
| Client ID Metadata Documents (CIMD) are SHOULD in `2025-11-25`; a server advertises support with `client_id_metadata_document_supported` | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization |
| Protected resource metadata (RFC 9728) is MUST from `2025-06-18` | https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization |
| Resource indicators (RFC 8707) are MUST from `2025-06-18`; the `2025-03-26` revision does not mention them | https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization and .../2025-06-18/basic/authorization |
| PKCE is REQUIRED in every revision; S256 where the client can do it | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization |
| On HTTP GET the server MUST return `text/event-stream` or HTTP 405 | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports |
| A client MUST send `MCP-Protocol-Version` after initialization; with the header absent the server SHOULD assume `2025-03-26`; an invalid or unsupported value MUST get 400 | https://modelcontextprotocol.io/specification/2025-06-18/basic/transports |
| Claude Code redirects to `http://localhost:PORT/callback` and performs dynamic client registration by default | https://code.claude.com/docs/en/mcp |
| Claude Code picks scopes from `WWW-Authenticate`, then protected resource metadata, then `scopes_supported`, and may send no `scope` parameter | https://code.claude.com/docs/en/mcp |
| ChatGPT supports CIMD with `none` or `private_key_jwt`, and dynamic client registration "remains supported when configured" | https://developers.openai.com/api/docs/mcp |
| RFC 7591 registration response fields, and the `invalid_redirect_uri` and `invalid_client_metadata` error codes with HTTP 400 | https://www.rfc-editor.org/rfc/rfc7591 |

The claude.ai and ChatGPT literal redirect URIs could not be confirmed from a
first-party page that returned content. This decision therefore does not
hard-code any client's redirect URI. Exact matching is against whatever the
client registered.

## Decision

### 1. Registration is a name and a set of return addresses. It grants nothing.

`POST /api/foundry-mcp/oauth/register` implements RFC 7591 for public clients.
A successful registration writes one row in `mcp_registered_clients` and returns
a `client_id`. It creates no connection, no actor, no scope and no token.

Access begins only when an Owner approves the client on the consent screen,
which sits behind human sign-in at
`/api/foundry-cms/mcp/oauth/authorize`. This is the single place where a
non-human identity is created, and it is unchanged by this decision.

Registration is bounded: 8 KiB of body, at most 5 redirect URIs, a 120-character
client name, 20 registrations per site per hour, and 500 stored clients per
site. The per-hour limit uses the existing `mcp_rate_limit_buckets` table.

Registered metadata is immutable. A database trigger refuses any update, so what
the Owner consented to cannot be changed afterwards.

### 2. The environment allowlist becomes an optional restriction.

`FOUNDRY_MCP_CLIENTS` is no longer required. Unset or empty means the
installation accepts dynamic registration. Set, it restricts authorization to
the listed clients and turns registration off: the endpoint answers 403 and
`registration_endpoint` disappears from the authorization-server metadata.

A present but empty JSON object still fails closed, because that is a
configuration mistake rather than a request for open registration.

### 3. Unknown authorize parameters are ignored, not refused.

The authorize endpoint reads the parameters it uses and ignores the rest. Every
parameter it does use is still checked exactly: `response_type` must be `code`,
`code_challenge_method` must be `S256`, the redirect URI must match one the
client registered character for character, and `resource` must be this
resource's canonical URI when it is present.

`resource` may be absent. A `2025-03-26` client does not send it, and this
server serves exactly one resource, so an absent indicator is that resource.
`state` may also be absent and is echoed only when the client sent it; PKCE,
not `state`, is what binds the exchange.

### 4. The Owner decides the scopes, and can reduce them.

A client may request several scopes on a first authorization. The consent screen
shows one control per requested scope, ticked by default, and the Owner can
clear any of them. `site.read` is always included and cannot be cleared.

The granted set must be inside the requested set. A consent that adds a scope
the client did not request is refused. On a step-up, the granted set must also
keep every scope the connection already holds; removing a scope still requires
revoking the connection.

### 5. Three protocol revisions are served.

The server accepts `2025-03-26`, `2025-06-18` and `2025-11-25`. `initialize`
answers with the revision the client asked for when the server serves it, and
otherwise with `2025-11-25`.

An unsupported `MCP-Protocol-Version` header is refused with HTTP 400. An absent
header is not refused; it means the assumed `2025-03-26` revision, which this
server serves. This replaces the earlier rule that refused a request with no
version header, because that rule locked out every `2025-03-26` client.

HTTP GET and DELETE on the MCP endpoint answer HTTP 405 with `Allow: POST`. The
transport permits an SSE stream or 405, and this server offers no
server-initiated stream.

### 6. The Cloudflare Access boundary is written down and checked.

`mcpAccessBoundary` in `apps/reference-site/src/mcp-production-runtime.ts`
names both sides, and `checkMcpAccessBoundary()` fails if the router and the
list disagree.

Outside the Access application, because a client calls them with no human:

- `/.well-known/oauth-protected-resource/api/foundry-mcp`
- `/.well-known/oauth-authorization-server`
- `/api/foundry-mcp/oauth/register`
- `/api/foundry-mcp/oauth/token`
- `/api/foundry-mcp`

Behind the Access application, because they are human decisions:

- `/api/foundry-cms/mcp/oauth/authorize`
- `/api/foundry-cms/mcp-connections/revoke`

## Rejected alternatives

**Client ID Metadata Documents instead of dynamic registration.** CIMD is SHOULD
in `2025-11-25` and ChatGPT supports it. It was rejected for this change because
it makes the server fetch a URL the client chooses, which is a server-side
outbound request driven by untrusted input. That needs its own threat model and
its own decision. Dynamic registration is still allowed by `2025-11-25` and is
what Claude Code performs by default. CIMD stays open as later work.

**Trusting a registered client name.** Rejected. The name arrives from an
unauthenticated request. It is stored as text, escaped on the consent screen, and
the screen tells the Owner to treat it as a claim. The consent screen also shows
the client identifier and the exact return address.

**Allowing a registration to carry a scope grant.** Rejected. A registration may
state a `scope` it would like, but that value is metadata only. The Owner's
consent is the only thing that grants a scope.

**Dropping the environment allowlist.** Rejected. An operator who wants a closed
installation keeps a way to get one.

## Consequences

- A site Owner connects a client with nothing pasted anywhere. The Owner signs
  in, reads the permissions and approves.
- An installation that leaves `FOUNDRY_MCP_CLIENTS` unset accepts registrations
  from anyone who can reach the endpoint. Each one is inert until an Owner
  consents, bounded in size and count, and rate limited.
- An operator who wants the old behaviour sets `FOUNDRY_MCP_CLIENTS`.
- Migration `0027_mcp_registered_clients.sql` must be applied before
  registration works.
- Refresh rotation with reuse detection, five-minute access tokens, exact
  redirect matching, PKCE S256, site scoping and immediate revocation are
  unchanged.

# Connect an agent to your site

Return to the [contract index](README.md).

This is the practical V1 guide for a non-technical site Owner. The exact button
labels may change, but the permission and approval promises may not.

## Before connecting

Use an MCP client you trust and keep it updated. A connection lets that client
and its AI use only the permissions you approve, on one site. It does not give
the agent your dashboard login, Cloudflare account, GitHub account or email
provider credentials.

Start with the smallest useful permission. Every connection includes **Read
the site** (`site.read`), which cannot be cleared. A client may also ask for
**Draft page and post content** (`content.draft`), **Draft the site design**
(`design.draft`), **Schedule publishing** (`publication.schedule`) or
**Publish** (`publication.publish`) at the same time. The consent screen shows
one control per requested permission. Clear anything you do not want; you can
approve fewer permissions than the client asked for. A site Owner can also add
permissions to an existing connection later. Removing a permission still means
revoking the connection.

These phrases come from one shared list
(`apps/reference-site/src/mcp-connection-display.ts`), used on the dashboard's
Connected agents list, the "Connect an AI agent" screen, and the consent
screen itself, so an Owner reads the same words everywhere a permission is
shown.

## The "Connect an AI agent" screen

The dashboard's Settings page has a "Connect an agent" button under Connected
agents. It opens a screen with this site's agent address, a plain list of what
a connected agent can and cannot do, and the published steps for Claude and
ChatGPT. Nothing on that screen is pasted anywhere by the Owner: the address is
not a secret, and the screen never shows a token, a client secret or a
personal address.

If the installation is not reachable from outside its own machine — a local
development copy or a private preview — the screen says so, because Claude and
ChatGPT run in their own cloud and cannot reach an address that only resolves
locally.

The steps for each client are read from that client's own published
documentation, not from memory, and are dated:

- Claude (claude.ai custom connector): read 18 September 2026 from
  <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>.
- Claude Code (`claude mcp add --transport http <name> <url>`): read 18
  September 2026 from <https://code.claude.com/docs/en/mcp>.
- ChatGPT (Developer mode custom connector): read 18 September 2026 from
  <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>
  and <https://developers.openai.com/api/docs/mcp>.

Foundry has not tested a live connection against claude.ai, ChatGPT or Claude
Code (see [the conformance plan](conformance.md)). The screen and this guide
therefore both say "steps for Claude" and "steps for ChatGPT" — a set of
published steps to follow, never a claim that this exact screen was seen
working with that client.

## Installation configuration

The shipped Worker serves the site-bound resource at
`/api/foundry-mcp`. Its OAuth protected-resource metadata is at
`/.well-known/oauth-protected-resource/api/foundry-mcp`, while the
authorization-server metadata is at
`/.well-known/oauth-authorization-server`.

Clients register themselves at `/api/foundry-mcp/oauth/register`, so the Owner
pastes no token, key or client identifier anywhere. The server advertises that
address as `registration_endpoint` in its authorization-server metadata.

Before enabling connections, the installation operator must:

- apply every D1 migration in numeric order through
  `0027_mcp_registered_clients.sql`. The connection surface itself is defined by
  `0017_mcp_readonly_connections.sql`, `0018_mcp_draft_scopes.sql`,
  `0019_mcp_preview_artifacts.sql`, `0020_mcp_mutation_receipts.sql`,
  `0022_blog_post_scheduling_archive.sql`,
  `0024_mcp_publication_scopes.sql` and
  `0027_mcp_registered_clients.sql`, but the sequence is cumulative and no
  migration in the range may be skipped;
- set `FOUNDRY_MCP_OAUTH_SIGNING_KEY` as a Worker secret with at least 32
  random characters; and
- set the Cloudflare Access application to cover exactly the paths in the table
  below.

### Cloudflare Access boundary

A client calls the public paths with no human present and no Access session. If
the Access application covers them, Access answers with its own sign-in page and
the client cannot discover the server, register or exchange a token.

| Path | Cloudflare Access |
|---|---|
| `/.well-known/oauth-protected-resource/api/foundry-mcp` | must be outside |
| `/.well-known/oauth-authorization-server` | must be outside |
| `/api/foundry-mcp/oauth/register` | must be outside |
| `/api/foundry-mcp/oauth/token` | must be outside |
| `/api/foundry-mcp` | must be outside |
| `/api/foundry-cms/mcp/oauth/authorize` | must stay behind Access |
| `/api/foundry-cms/mcp-connections/revoke` | must stay behind Access |

The rest of `/api/foundry-cms/*` stays behind Access. `mcpAccessBoundary` in
`apps/reference-site/src/mcp-production-runtime.ts` holds the same two lists,
and `checkMcpAccessBoundary()` fails if the router and this table disagree.

### Restricting registration (optional)

`FOUNDRY_MCP_CLIENTS` is optional. Leave it unset to accept dynamic
registration. Set it to restrict the installation to named clients: only those
clients may authorize, the registration endpoint answers `403` and
`registration_endpoint` disappears from the metadata.

```json
{
  "https://client.example/metadata.json": {
    "name": "Owner-approved desktop client",
    "redirectUris": [
      "https://client.example/oauth/callback",
      "http://127.0.0.1:43119/callback"
    ]
  }
}
```

Remote redirects must use HTTPS. Exact loopback redirects are supported for
installed clients, which is how a client on the Owner's own computer receives
its authorization code. A client that registers itself may use
`http://127.0.0.1`, `http://[::1]` or `http://localhost`. This allowlist takes
the literal addresses only, not the `localhost` name.

Wildcards, fragments, a present but empty registry, missing D1, and a missing or
short signing secret fail closed with no MCP command execution. Neither setting
contains an access token; the signing key must still remain a Worker secret.

Registration is bounded: an 8 KiB body, at most 5 redirect URIs, a
120-character client name, 20 registrations per site per hour, and 500 stored
clients per site. A registration grants nothing. It creates no connection, no
permission and no token until an Owner approves the client.

Access tokens last five minutes. The server issues a 30-day rotating refresh
token; every successful refresh invalidates the presented token and returns a
replacement. Reuse of an invalidated refresh token revokes its whole token
family and the connection. MCP JSON bodies are capped at 256 KiB and 32 levels
of nesting, requests time out after 10 seconds, and per-site, per-connection and
per-tool minute buckets return HTTP `429` with `Retry-After` when exhausted.

## Connect

1. Add the installation's `/api/foundry-mcp` server address to your client.
   There is nothing else to paste.
2. Start the connection from that client. The client registers itself and your
   browser opens Foundry. Sign in as a site Owner.
3. Read the page. It shows the client's claimed name, its client identifier,
   the exact address it will return to, this site's name and one control per
   requested permission. The name comes from the client, so treat it as a
   claim. Decline anything you did not expect.
4. Clear any permission you do not want, then approve.
5. Return to the client and ask it to read the site summary. Foundry shows the new
   connection, approved permissions, last use and a **Revoke** button.

Only approving grants access. A client that registered but was never approved
has no connection, no permission and no token.

The address is not a secret, and it does not contain a token. Do not paste access
tokens into prompts or settings fields. Authentication happens in the browser.

## Draft review and safe publishing

The server creates canonical drafts and previews after an Owner grants the
matching draft scope. Scheduling also requires `publication.schedule`;
immediate publication requires `publication.publish`. Both publication paths
also require every draft scope changed by the exact revision.

An agent can draft and prepare a canonical preview. It cannot approve that
preview for itself.

When a draft is ready:

1. The agent gives you a **Review in Foundry** link.
2. Open it and sign in to Foundry. Verify the page/post, design changes and
   revision shown.
3. If anything is wrong, ask the agent to edit the draft and prepare a new
   exact revision.
4. If it is correct, approve that exact revision in Foundry.
5. The agent may then request immediate publication or create a blog schedule
   using the exact `workspaceId`, revision and `approvalId`.

The approval becomes stale whenever the draft, renderer, publication channel or
live production base advances. Campaign tests and bulk sends remain separate
capabilities.

## Review or revoke

In **Agent connections**, you can:

- see the client, one bound site, permissions, creation time and recent use;
- revoke the connection immediately; and
- retain attributable authorization, command, refresh-reuse and revocation
  audit history.

Every new connection starts with `site.read`. An Owner can approve additive
`content.draft`, `design.draft`, `publication.schedule` and
`publication.publish` step-ups for that exact connection and site.
Step-up preserves the connection and actor identity so its audit history stays
continuous. OAuth token responses include an opaque `connection_id` and a
short-lived `step_up_token`. Clients submit both with the ordered additive
scope request; they do not decode the access-token JWT or accept a connection
identifier from a tool result. The Owner consent page confirms the exact
connection, its current permissions and the requested permissions. The
step-up request must reuse the exact redirect URI bound to the existing
authorization; another registered redirect for the same client is rejected
before consent. After approval, the client receives a replacement token and
must reconnect and reinitialize before the new tools and resource templates
appear. Existing access tokens do not gain scopes. Removing a scope still
requires revoking the connection.

Revocation takes effect on the next request even if the client's sign-in token
has not expired. It does not erase attribution or published Git history. Open
drafts remain available for a human to review, reassign or archive.

Revoke immediately if the client device is lost, the client behaves
unexpectedly, or a permission was granted by mistake.

## Drafting and publishing example

The drafting, preview and publication steps below are available when the Owner
grants the required draft and publication scopes.

Owner request:

> Turn our existing workshop notes into a blog post, use the current site
> styles, and prepare it for next Tuesday at 9:00 a.m. Toronto time. Do not
> publish until I approve the preview.

Expected agent workflow:

1. Read `foundry://site`, content schema and existing published content with
   `site.read`.
2. Call `foundry.workspace.open` with one idempotency key.
3. Call `foundry.content.patch` with the current `expectedRevision`, canonical
   rich text and a new idempotency key.
4. Call `foundry.preview.prepare` for the returned exact revision.
5. Give the Owner the `humanReviewUrl` and stop publication work while approval
   is pending.
6. After the Owner approves in Foundry, call
   `foundry.publication.schedule` with the exact `approvalId`, UTC instant,
   `America/Toronto` display zone and a stable idempotency key.
7. Read `foundry.publication.status`. Report the durable schedule. At execution,
   report `Live` only after Foundry verifies the Git commit and release marker.
8. Use `foundry.publication.cancel` with a new stable idempotency key when the
   Owner cancels an active schedule. A late cancellation is rejected and must
   not be reported as accepted.

If another edit occurs after step 4, the scheduling call returns
`APPROVAL_STALE`. The agent reads the latest revision, resolves the conflict,
prepares a new preview and asks the Owner to review again. It never sets an
approval flag itself and never silently overwrites the newer work.

Expected audit chain:

```text
connection "Claude — blog drafting"
  -> workspace
  -> draft revision and content hash
  -> canonical preview
  -> human approval of exact fingerprint
  -> scheduled publication
  -> publish operation
  -> Git commit
  -> verified public release
```

## Troubleshooting

| Message | What it means | What to do |
|---|---|---|
| Permission required | The connection does not have `site.read` | Revoke it and complete a new Owner approval only if access is still wanted |
| Connection revoked | An Owner disabled this connection | Create a new connection only if still wanted |
| Rate limited | A per-site, connection or tool minute budget was exhausted | Respect `Retry-After` before trying again |
| Temporarily unavailable | The read could not complete safely within its time or dependency bounds | Retry after the indicated backoff; inspect installation health if it persists |

# Connect an agent to your site

Return to the [contract index](README.md).

This is the practical V1 guide for a non-technical site Owner. The exact button
labels may change, but the permission and approval promises may not.

## Before connecting

Use an MCP client you trust and keep it updated. A connection lets that client
and its AI use only the permissions you approve, on one site. It does not give
the agent your dashboard login, Cloudflare account, GitHub account or email
provider credentials.

Start with the smallest useful permission. The current production connection
grants exactly **Read site** (`site.read`). Draft editing and publication scopes
remain contract designs and are not available from this connection.

## Installation configuration for read-only connections

The shipped Worker serves the site-bound resource at
`/api/foundry-mcp`. Its OAuth protected-resource metadata is at
`/.well-known/oauth-protected-resource/api/foundry-mcp`, while the
authorization-server metadata is at
`/.well-known/oauth-authorization-server`.

Before enabling connections, the installation operator must:

- apply D1 migration `0017_mcp_readonly_connections.sql`;
- set `FOUNDRY_MCP_OAUTH_SIGNING_KEY` as a Worker secret with at least 32
  random characters;
- set `FOUNDRY_MCP_CLIENTS` to a non-secret JSON object whose keys are
  pre-registered client IDs and whose values contain a display `name` and
  exact `redirectUris`; and
- keep `/api/foundry-cms/*` behind the installation's existing Cloudflare
  Access application, because Owner consent and revocation use that protected
  namespace.

Example client registry:

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
installed clients. Wildcards, fragments, an empty registry, missing D1, and a
missing or short signing secret fail closed with no MCP command execution.
Neither setting contains an access token; the signing key must still remain a
Worker secret.

Access tokens last five minutes. The server issues a 30-day rotating refresh
token; every successful refresh invalidates the presented token and returns a
replacement. Reuse of an invalidated refresh token revokes its whole token
family and the connection. MCP JSON bodies are capped at 256 KiB and 32 levels
of nesting, requests time out after 10 seconds, and per-site, per-connection and
per-tool minute buckets return HTTP `429` with `Retry-After` when exhausted.

## Connect

1. Add the installation's `/api/foundry-mcp` server address to a client that
   the installation operator has pre-registered.
2. Start the connection from that client. Your browser opens Foundry.
3. Confirm the client name, this site's name and the
   requested permissions. Decline anything you did not expect.
4. Approve the connection as a site Owner.
5. Return to the client and ask it to read the site summary. Foundry shows the new
   connection, approved permissions, last use and a **Revoke** button.

The address is not a secret, and it does not contain a token. Do not paste access
tokens into prompts or settings fields. Authentication happens in the browser.

## Future capability: safe publishing

The workflow in this section is part of the approved MCP contract design, but
it is not exposed by the current read-only server. A `site.read` connection
cannot create drafts, prepare previews, approve, schedule, publish or send
campaign tests.

An agent can draft and prepare a canonical preview. It cannot approve that
preview for itself.

When a draft is ready:

1. The agent gives you a **Review in Foundry** link.
2. Open it and sign in to Foundry. Verify the page/post, design changes and
   revision shown.
3. Choose **Approve this revision** only if the rendered result is correct.
4. The agent may then request immediate publication or create the site/blog
   schedule you asked for, if its connection has that permission.
5. Foundry reports **Live** only after Git contains the approved revision and
   the public site's release marker proves it is serving.

Editing the draft, changing the site renderer or advancing the live site makes
the approval stale. You will be asked to review again. This is intentional.

Agent connections cannot send newsletters to an audience. If separately
permitted, they can request one test of an exact campaign revision; Foundry
sends it only to the verified test recipients configured by an Owner, and the
agent cannot choose or read those addresses. A human Owner must still inspect
the delivered test and use the separate bulk-send authorization workflow.

## Review or revoke

In **Agent connections**, you can:

- see the client, one bound site, permissions, creation time and recent use;
- revoke the connection immediately; and
- retain attributable authorization, command, refresh-reuse and revocation
  audit history.

This read-only release does not edit a connection's scopes. Revoke it and
complete a new Owner approval if a replacement connection is needed.

Revocation takes effect on the next request even if the client's sign-in token
has not expired. It does not erase attribution or published Git history. Open
drafts remain available for a human to review, reassign or archive.

Revoke immediately if the client device is lost, the client behaves
unexpectedly, or a permission was granted by mistake.

## Future capability: drafting and publishing example

The following example documents a later scoped release. Its tools are not
advertised by the current three-tool read-only catalog.

Owner request:

> Turn our existing workshop notes into a blog post, use the current site
> styles, and prepare it for next Tuesday at 9:00 a.m. Toronto time. Do not
> publish until I approve the preview.

Expected agent workflow:

1. Read `foundry://site`, content schema and existing published content with
   `site.read`.
2. Call `foundry.workspace.open` with one idempotency key.
3. Call `foundry.content.patch` with the current `baseRevision`, canonical rich
   text and a new idempotency key.
4. Call `foundry.preview.prepare` for the returned exact revision.
5. Give the Owner the `humanReviewUrl` and stop publication work while approval
   is pending.
6. After the Owner approves in Foundry, call
   `foundry.publication.schedule` with the exact `approvalId`, UTC instant,
   `America/Toronto` display zone and a stable idempotency key.
7. Read `foundry.publication.status`. Report the durable schedule. At execution,
   report `Live` only after Foundry verifies the Git commit and release marker.

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

# Capability and permission matrix

Return to the [contract index](README.md).

## Actor and grant model

An Owner creates a connection in `/dash`. Foundry creates an immutable
`connectionId`, a stable installation-local `actorId`, a site binding, the
approved scope set, OAuth client metadata and lifecycle state. The actor is
always `kind: mcp_connection`; it is never a human membership and cannot acquire
the Owner or Editor role.

Revocation changes D1 state first. Every application command reloads the active
connection and scopes from D1, so a still-unexpired access token stops working
on the next call. Historical attribution remains.

## Scopes

| Scope | Grants | Does not grant |
|---|---|---|
| `site.read` | Site metadata, schemas, published content and design resources | Drafts, analytics, subscriber data |
| `content.draft` | Open/read workspaces; create immutable content and campaign-draft revisions | Design changes, approval, publish |
| `design.draft` | Read controlled design primitives and create design revisions within schema | Raw CSS/code, component registration |
| `campaign.test` | Request one test of an exact campaign revision to Owner-configured verified test recipients | Recipient selection/read, audience access, bulk send/schedule/authorization |
| `publication.schedule` | Create, replace or cancel site/blog publication schedules for approved revisions | Campaign/email scheduling, approval |
| `publication.publish` | Request the shared publisher for an already human-approved exact revision; read operation status | Self-approval, bypassing stale checks |
| `analytics.read` | Bounded aggregate analytics views with suppression and quality metadata | Raw events, arbitrary dimensions/SQL, identities |
| `connection.admin` | Read this connection's grant and revoke this connection | Other connections, human users, role or secret management |

`site.read` is the only scope in `scopes_supported` and the initial
`WWW-Authenticate` challenge. Additional scopes use the MCP step-up
authorization flow and a fresh Owner consent. The authorization server displays
the exact site, client identity and incremental scopes. No wildcard scope and
no `*` suffix exists.

## Capability matrix

Legend: **A** allowed by application authorization, **H** human-only,
**—** unavailable.

| Capability | Owner | Editor | MCP with scope | Scheduler |
|---|---:|---:|---:|---:|
| Read published content/schema/design | A | A | `site.read` | — |
| Read own authorized workspaces | A | A | `content.draft` or `design.draft` | — |
| Create/edit content draft | A | A | `content.draft` | — |
| Edit controlled design state | A | A | `design.draft` | — |
| Prepare campaign artifact | A | A | `content.draft` | — |
| Read aggregate analytics | A | A | `analytics.read` | — |
| Read subscriber identity/list | A | H, if separately authorized | — | — |
| Create canonical preview | A | A | draft scope matching changed state | — |
| Approve rendered revision | A | A | — | — |
| Request immediate site/blog publish | A | A | `publication.publish` + valid human approval | — |
| Schedule site/blog publish | A | A | `publication.schedule` + valid human approval | Executes exact authorization |
| Request controlled campaign test | A | A | `campaign.test` + `content.draft` | Executes exact test request |
| Authorize/schedule/send bulk email | H | — | — | Executes separately authorized send only |
| Manage humans, MCP grants or integrations | H | — | self-read/revoke only with `connection.admin` | — |
| Modify arbitrary code/repository files | — | — | — | — |

Human columns summarize the boundary required by the product contract; the
human authorization decision remains authoritative where it is stricter.

## Tool-to-scope matrix

| Tool | Required scopes | Approval at call time | Side effect |
|---|---|---|---|
| `foundry.site.get` | `site.read` | None | None |
| `foundry.content.list` | `site.read` | None | None |
| `foundry.content.get` | `site.read` or `content.draft` for draft revision | None | None |
| `foundry.workspace.open` | `content.draft` or `design.draft` | None | Creates/resumes workspace |
| `foundry.workspace.get` | matching draft scope | None | None |
| `foundry.content.patch` | `content.draft` | None | New immutable revision |
| `foundry.design.patch` | `design.draft` | None | New immutable revision |
| `foundry.preview.prepare` | matching draft scopes | None | Canonical preview artifact |
| `foundry.campaign.test.request` | `campaign.test` + `content.draft` | Exact persisted campaign revision; client confirmation recommended | Test to configured verified recipients |
| `foundry.publication.schedule` | `publication.schedule` + matching draft scopes | Existing human approval | Scheduled operation |
| `foundry.publication.cancel` | `publication.schedule` | None; only before claim | Cancels site/blog schedule |
| `foundry.publication.request` | `publication.publish` + matching draft scopes | Existing human approval | Git/build operation |
| `foundry.publication.status` | `publication.publish` or `publication.schedule` | None | None |
| `foundry.analytics.read` | `analytics.read` | None | None |
| `foundry.connection.get` | `connection.admin` | None | None |
| `foundry.connection.revoke` | `connection.admin` | Explicit client confirmation recommended | Revokes caller |

Authorization is the intersection of token scopes, current D1 grant, site
binding, tool policy and object-level access. Possessing a scope never bypasses
object state, revision, approval or schema checks.

## Data classification and output

| Class | Examples | MCP behavior |
|---|---|---|
| Public | Published page/post fields, public slugs, public assets | Readable with `site.read` |
| Controlled draft | Workspace manifests, revision content, design tokens, campaign copy | Readable only to connections authorized for that workspace and scope |
| Aggregate operational | Counts, trends, quality/freshness metadata | Readable with `analytics.read`; small cells suppressed |
| Personal/restricted | Subscriber address, form respondent identity, IP, recipient event | Never returned |
| Secret | OAuth tokens, provider keys, GitHub keys, JWTs, CSRF values | Never returned or audited |
| Code/infrastructure | Repository source, arbitrary paths, Worker bindings | No MCP capability |

All list tools have server-capped page size and opaque cursors bound to the site,
actor, query and expiration. Object IDs are installation-scoped UUIDs. The
server never accepts a `siteId` argument: site is derived from the authenticated
resource and connection.

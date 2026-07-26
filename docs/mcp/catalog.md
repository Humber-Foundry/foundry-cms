# Resource, prompt and tool catalog

Return to the [contract index](README.md).

## Design rules

- Resources expose addressable state; tools perform bounded queries or domain
  commands; prompts are optional user-invoked workflow starters.
- Every tool has closed JSON Schema input and output
  (`additionalProperties: false`) and returns `structuredContent`.
- For backward compatibility, the same JSON is serialized into one text content
  block. The text contains data only, never new instructions.
- All IDs are UUIDs except revision integers, Git SHAs and opaque cursors.
- Site is derived from the authenticated resource. No input accepts a site,
  repository, hostname, provider, file path, URL or SQL expression.
- Tool annotations accurately describe expected behavior but are not security
  policy. Every mutating tool still performs application authorization.
- V1 declares `execution.taskSupport: "forbidden"` on every tool.

## Resources

All resources require authorization. `resources/list` returns only objects the
connection can read. Templates validate identifiers and re-authorize the
resolved object; guessing an ID never expands access.

| URI or template | MIME type | Scope | Contents |
|---|---|---|---|
| `foundry://site` | `application/json` | `site.read` | Site ID, display name, canonical URL, locale, time zone, live release |
| `foundry://schemas/content` | `application/schema+json` | `site.read` | Allowed document kinds, fields, constraints and schema version |
| `foundry://schemas/design` | `application/schema+json` | `site.read` | Controlled tokens, variants and component slots |
| `foundry://content/{kind}/{contentId}` | `application/json` | `site.read` | Published canonical document and live Git SHA |
| `foundry://workspaces/{workspaceId}` | `application/json` | matching draft scope | Workspace manifest, base, current revision and state |
| `foundry://workspaces/{workspaceId}/revisions/{revision}` | `application/json` | matching draft scope | Immutable canonical revision |
| `foundry://previews/{previewId}` | `application/json` | matching draft scope | Fingerprint, human review URL and approval state; no approval capability |
| `foundry://publications/{operationId}` | `application/json` | publish/schedule scope | Durable state, safe failure and Git/release result |
| `foundry://analytics/definitions` | `application/json` | `analytics.read` | Metric definitions, quality meanings, retention and freshness |
| `foundry://connections/self` | `application/json` | `connection.admin` | Caller connection, site, client, scopes and state |

Resources carry `audience: ["user", "assistant"]`, an honest `lastModified`, and
ETag-equivalent revision/hash data inside their JSON. Draft resources are never
embedded in public content or placed in shared caches.

## Prompts

Prompts are user-controlled helpers, not privileged macros. Getting a prompt
does not execute tools or alter authorization.

| Prompt | Arguments | Produces |
|---|---|---|
| `foundry.draft-page` | `goal`, optional `contentId` | Plan to inspect schema, open workspace, patch content and prepare preview |
| `foundry.prepare-post` | `topic`, optional `publishAt` | Plan to draft a blog post and, if requested, prepare a site/blog schedule after human approval |
| `foundry.prepare-campaign` | `goal`, optional `sourcePostId` | Plan to create campaign copy as a draft; explicitly states that MCP cannot test, schedule or send email |
| `foundry.review-analytics` | `view`, `range` | Plan to read one aggregate view and propose draft improvements |

Stored site content is interpolated only as quoted data sections with explicit
delimiters. Prompt templates never instruct the model to ignore client policy,
reveal secrets or call unavailable tools.

## Common result envelope

Every successful or business-error tool result conforms to:

```json
{
  "contractVersion": "foundry.mcp.v1",
  "invocationId": "018f...",
  "result": {},
  "meta": {
    "replayed": false,
    "observedAt": "2026-07-26T20:00:00Z"
  }
}
```

Tool execution errors set MCP `isError: true` and use:

```json
{
  "contractVersion": "foundry.mcp.v1",
  "invocationId": "018f...",
  "error": {
    "code": "STALE_REVISION",
    "message": "Workspace revision changed; read the latest revision before retrying.",
    "retryable": false,
    "requiredScopes": [],
    "latestRevision": 8,
    "conflictResource": "foundry://workspaces/.../revisions/8"
  },
  "meta": {
    "replayed": false,
    "observedAt": "2026-07-26T20:00:00Z"
  }
}
```

Malformed JSON-RPC, unknown tools and requests that do not satisfy the declared
input schema use JSON-RPC protocol errors. Domain validation, authorization,
conflict and provider failures use the structured execution error above.

Stable error codes:

| Code | Meaning | Retry |
|---|---|---|
| `AUTHENTICATION_REQUIRED` | Missing, invalid, expired or revoked token | Reauthorize |
| `INSUFFICIENT_SCOPE` | Current grant lacks scope; HTTP `403` challenge includes scope | Step-up once |
| `OBJECT_NOT_FOUND` | Object absent or intentionally concealed | No |
| `VALIDATION_FAILED` | Domain/schema validation failed; includes field issues | Correct input |
| `STALE_REVISION` | Workspace compare-and-swap failed | Read/merge, new key |
| `IDEMPOTENCY_KEY_REUSED` | Same key used for different canonical input | New key |
| `APPROVAL_REQUIRED` | No exact human approval exists | Human review |
| `APPROVAL_STALE` | Approval fingerprint no longer matches | New preview/review |
| `WRONG_ARTIFACT_KIND` | Email/campaign artifact passed to publication scheduler | No |
| `PUBLICATION_BUSY` | Another production publication owns the lease | After `retryAfterMs` |
| `TEMPORARILY_UNAVAILABLE` | Dependency unavailable before safe completion | Same key after delay |
| `RESULT_UNKNOWN` | Outcome reconciliation in progress | Poll status |
| `RATE_LIMITED` | Connection/site budget exceeded | After `retryAfterMs` |
| `CONNECTION_REVOKED` | D1 grant inactive | Owner reconnects |

Errors never disclose whether an inaccessible cross-site object exists.

## Tool catalog

Annotations are shown as
`readOnly / destructive / idempotent / openWorld`.

| Tool | Annotation hints | Purpose |
|---|---|---|
| `foundry.site.get` | `T / - / - / F` | Read site and release metadata |
| `foundry.content.list` | `T / - / - / F` | Bounded published-content query |
| `foundry.content.get` | `T / - / - / F` | Read published content or an authorized immutable draft revision |
| `foundry.workspace.open` | `F / F / T / F` | Create/resume a workspace anchored to live Git |
| `foundry.workspace.get` | `T / - / - / F` | Read workspace state |
| `foundry.content.patch` | `F / T / T / F` | Apply typed content commands to a new revision |
| `foundry.design.patch` | `F / T / T / F` | Apply allowlisted design commands to a new revision |
| `foundry.preview.prepare` | `F / F / T / F` | Persist a canonical preview fingerprint |
| `foundry.campaign.test.request` | `F / T / T / T` | Send one exact revision to configured verified test recipients |
| `foundry.publication.schedule` | `F / T / T / T` | Schedule exact approved site/blog revision |
| `foundry.publication.cancel` | `F / T / T / T` | Cancel an unclaimed site/blog schedule |
| `foundry.publication.request` | `F / T / T / T` | Start shared Git/build publication |
| `foundry.publication.status` | `T / - / - / F` | Read durable publish/schedule state |
| `foundry.analytics.read` | `T / - / - / F` | Read one bounded aggregate view |
| `foundry.connection.get` | `T / - / - / F` | Read caller's connection grant |
| `foundry.connection.revoke` | `F / T / T / F` | Revoke caller's connection |

`openWorldHint` is true only where the operation can change public site state or
coordinate Git/Cloudflare. Analytics reads query Foundry's bounded D1 projection,
not source providers directly, and are closed-world.

## Representative schemas

These examples show the normative shapes. The implementation publishes complete
schemas through `tools/list`; generated schema snapshots are conformance-tested.

### Open a workspace

```json
{
  "name": "foundry.workspace.open",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "purpose": {"type": "string", "minLength": 1, "maxLength": 240},
      "idempotencyKey": {"type": "string", "format": "uuid"}
    },
    "required": ["purpose", "idempotencyKey"]
  },
  "outputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "contractVersion": {"const": "foundry.mcp.v1"},
      "invocationId": {"type": "string"},
      "result": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "workspaceId": {"type": "string", "format": "uuid"},
          "revision": {"type": "integer", "minimum": 0},
          "baseCommit": {"type": "string", "pattern": "^[0-9a-f]{40}$"},
          "schemaVersion": {"type": "string"},
          "state": {"const": "open"}
        },
        "required": ["workspaceId", "revision", "baseCommit", "schemaVersion", "state"]
      },
      "meta": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "replayed": {"type": "boolean"},
          "observedAt": {"type": "string", "format": "date-time"}
        },
        "required": ["replayed", "observedAt"]
      }
    },
    "required": ["contractVersion", "invocationId", "result", "meta"]
  },
  "annotations": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "execution": {"taskSupport": "forbidden"}
}
```

### Patch content or prepare a campaign

`documentKind: "campaign"` creates only a campaign draft artifact. The patch
command has no recipient, audience, provider, send or email schedule operation.
Test delivery is a separate, scoped command.

```json
{
  "workspaceId": "3a0fc8d4-b70e-4a07-a5bd-acde5433b2ba",
  "baseRevision": 4,
  "idempotencyKey": "02c4a830-e14c-4d54-a0de-4c474463543a",
  "document": {
    "kind": "post",
    "contentId": "ae8b6710-6f98-42f3-931d-cff6d0310c60"
  },
  "operations": [
    {
      "op": "set",
      "field": "title",
      "value": "A practical guide"
    },
    {
      "op": "replace_rich_text",
      "field": "body",
      "value": {
        "type": "doc",
        "content": []
      }
    }
  ]
}
```

Input schema constraints:

- `operations` contains 1–100 discriminated commands.
- `field` must resolve to an editable stable schema field for the document kind.
- Rich text is the canonical editor JSON, not HTML.
- Relationships use stable content/asset IDs and are checked at the same site.
- Delete/unset commands are allowed only where schema permits and therefore make
  `destructiveHint: true` accurate.
- The output returns `workspaceId`, new `revision`, `contentHash`,
  `changedDocuments`, validation warnings and `replayed`.

### Patch design

```json
{
  "workspaceId": "3a0fc8d4-b70e-4a07-a5bd-acde5433b2ba",
  "baseRevision": 5,
  "idempotencyKey": "0b048343-41e5-4e63-bcdd-eae156c35f53",
  "operations": [
    {"op": "set_token", "token": "color.accent", "value": "#295F4E"},
    {"op": "set_variant", "slot": "hero", "variant": "split"}
  ]
}
```

Tokens, slots, variants and values must exist in
`foundry://schemas/design`. No arbitrary property, selector, URL, asset fetch,
CSS value, class name or component module is accepted.

### Prepare preview

Request:

```json
{
  "workspaceId": "3a0fc8d4-b70e-4a07-a5bd-acde5433b2ba",
  "revision": 6,
  "idempotencyKey": "ce578518-f227-46ee-8c48-16dd7ed7d203"
}
```

Result:

```json
{
  "contractVersion": "foundry.mcp.v1",
  "invocationId": "01J...",
  "result": {
    "previewId": "3314031d-6368-46dc-a563-537866cf6ebf",
    "workspaceId": "3a0fc8d4-b70e-4a07-a5bd-acde5433b2ba",
    "revision": 6,
    "contentHash": "sha256:...",
    "schemaVersion": "2026-07-26.1",
    "rendererCommit": "4f83...",
    "approvalStatus": "pending_human_review",
    "humanReviewUrl": "https://cms.example.com/dash/review/3314031d-..."
  },
  "meta": {"replayed": false, "observedAt": "2026-07-26T20:00:00Z"}
}
```

### Request or schedule publication

Immediate request:

```json
{
  "workspaceId": "3a0fc8d4-b70e-4a07-a5bd-acde5433b2ba",
  "revision": 6,
  "approvalId": "8e7b6b13-d99f-4f7f-b7ac-4d798e28b293",
  "idempotencyKey": "c167ba43-64bf-4bdd-8547-f473263cf8a1"
}
```

Schedule request adds:

```json
{
  "publishAt": "2026-08-01T16:00:00Z",
  "reportingTimeZone": "America/Toronto"
}
```

`publishAt` is an unambiguous UTC instant. `reportingTimeZone` is retained for
human display and DST explanation. The server rejects past times, times beyond
one year, campaign artifact kinds and an approval whose fingerprint differs.
The output returns a durable `operationId`, state and status resource URI. It
does not claim `live` until the release marker proves the expected Git SHA and
content hash.

### Request a campaign test

```json
{
  "workspaceId": "3a0fc8d4-b70e-4a07-a5bd-acde5433b2ba",
  "revision": 7,
  "idempotencyKey": "6811cdd9-6a20-4b93-a5c6-ceb4a9d88987"
}
```

The exact revision must be a valid campaign artifact. There is no recipient,
address, segment, audience, provider or schedule input. The application layer
resolves the Owner-configured verified test recipients, limits the recipient
count to five, rate-limits by site and revision, and records a receipt bound to
the campaign fingerprint. Output contains receipt IDs, accepted/failed counts
and safe provider status, never addresses or provider message-recipient data.
Editing the campaign invalidates the test receipt. This tool cannot activate a
schedule or create bulk-send authorization.

### Aggregate analytics

Request:

```json
{
  "view": "content",
  "range": {
    "start": "2026-06-01",
    "endExclusive": "2026-07-01",
    "timeZone": "America/Toronto"
  },
  "comparison": "previous_period",
  "limit": 20,
  "cursor": null
}
```

`view` is one of `summary`, `content`, `forms`, `audience`, `campaigns`,
`campaign`, or `health`. `campaignId` is accepted only for `campaign`. Limits
are capped at 100. There is no arbitrary metric, dimension, filter or SQL input.

Each result contains:

```json
{
  "view": "content",
  "range": {
    "startUtc": "2026-06-01T04:00:00Z",
    "endExclusiveUtc": "2026-07-01T04:00:00Z",
    "timeZone": "America/Toronto"
  },
  "rows": [
    {
      "subjectId": "ae8b...",
      "metrics": {
        "content.page_views": {
          "value": 420,
          "source": "cloudflare_web_analytics",
          "definitionVersion": "1",
          "quality": "sampled",
          "observedAt": "2026-07-26T19:55:00Z",
          "completeThrough": "2026-07-25T00:00:00Z"
        }
      }
    }
  ],
  "nextCursor": null,
  "suppressionApplied": true
}
```

Unsupported metrics are `unavailable`, not zero. Small dimension cells are
returned as `"fewer_than_5"` without the underlying count. No result includes
subscriber, visitor, form respondent, recipient, message or raw-event fields.

## Discovery compatibility

The server supports pagination for `tools/list`, `resources/list`,
`resources/templates/list` and `prompts/list`. It emits list-changed
notifications when a scope grant changes, while clients must still reconnect or
reauthorize after revocation. Tool names remain namespaced and within MCP's
portable character set. Client-specific aliases are prohibited.

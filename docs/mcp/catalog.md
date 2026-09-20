# Resource, prompt and tool catalog

Return to the [contract index](README.md).

## Design rules

- Resources expose addressable state; tools perform bounded queries or domain
  commands; prompts are optional user-invoked workflow starters.
- Every tool has closed JSON Schema input and output
  (`additionalProperties: false`) and returns `structuredContent`.
- For backward compatibility, the same JSON is serialized into one text content
  block. The text contains data only, never new instructions.
- Idempotency keys are UUIDs. Domain IDs are stable opaque values constrained
  by their advertised schema; revision numbers and Git SHAs retain their native
  integer and hexadecimal forms.
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
| `foundry.prepare-campaign` | `goal`, optional `sourcePostId` | Inert draft-planning template; it cannot itself request a test, schedule or send email |
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
    "conflictResource": "foundry://workspaces/.../revisions/8",
    "reason": null
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

`reason` is a named, machine-readable cause the agent can act on beyond the
generic `code` — for example `campaign_sender_details_not_configured`, which
every campaign tool reports while an installation has not set the sender
details a campaign email's footer needs (ADR-0030). It is `null` for a
refusal that carries no named reason beyond its `code`.

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
| `foundry.site.get` | `T / - / - / F` | Read this connection's site metadata. |
| `foundry.content.list` | `T / - / - / F` | List published page and post documents with bounded pagination. |
| `foundry.content.get` | `T / - / - / F` | Read one published page or post document. |
| `foundry.workspace.open` | `F / F / T / F` | Open one site-scoped canonical draft workspace at revision zero. |
| `foundry.workspace.get` | `T / - / - / F` | Read an authorized site-scoped draft workspace. |
| `foundry.content.patch` | `F / T / T / F` | Edit content fields of any page in the draft, as a new immutable revision. |
| `foundry.page.create` | `F / F / T / F` | Add a page to the draft from one of the starting points, as a new immutable revision. |
| `foundry.page.rename` | `F / T / T / F` | Change one page's name and web address in the draft, as a new immutable revision. |
| `foundry.page.duplicate` | `F / F / T / F` | Copy one page in the draft under a new name and web address, as a new immutable revision. |
| `foundry.page.delete` | `F / T / T / F` | Remove one page from the draft, as a new immutable revision. |
| `foundry.page.restructure` | `F / T / T / F` | Add, remove, move and copy the sections of one page in the draft, and choose their section styles, as a new immutable revision. |
| `foundry.section.list` | `T / - / - / F` | List the section types a page can hold, with their section styles and their editable fields. |
| `foundry.media.list` | `T / - / - / F` | List the photos this site already holds, oldest first, with the address to use for each one. |
| `foundry.media.upload` | `F / F / T / F` | Add one photo to this site, sending the picture itself as base64 text. |
| `foundry.media.place` | `F / T / T / F` | Put one of this site's photos in a page's main or secondary picture slot, as a new immutable revision. |
| `foundry.design.patch` | `F / T / T / F` | Apply registered design tokens or component variants to a new immutable revision. |
| `foundry.blog.create` | `F / F / T / F` | Start a new blog post in the draft, as a new immutable revision. |
| `foundry.blog.update` | `F / T / T / F` | Rewrite one blog post in the draft, as a new immutable revision. |
| `foundry.blog.archive` | `F / T / T / F` | Take one post out of the blog. A post that is on the site comes off it only after a person approves the removal. |
| `foundry.blog.restore` | `F / F / T / F` | Put one archived post back as an unpublished draft. |
| `foundry.blog.schedule_request` | `F / F / T / F` | Ask a person to publish one post at a named time. It records the request only; a person approves the post and starts the schedule. |
| `foundry.preview.prepare` | `F / F / T / F` | Prepare an immutable canonical preview and a human review URL without creating approval. |
| `foundry.publication.request` | `F / T / T / T` | Publish one exact approved workspace revision through the canonical publication pipeline. |
| `foundry.publication.schedule` | `F / T / T / T` | Schedule one exact approved blog revision through the canonical scheduler. |
| `foundry.publication.status` | `T / - / - / F` | Read the current state of a publication, publication schedule or prepared preview. |
| `foundry.publication.cancel` | `F / T / T / T` | Cancel one active publication schedule. |
| `foundry.campaign.create` | `F / F / T / F` | Prepare a new standalone campaign as an independent draft revision. |
| `foundry.campaign.edit` | `F / F / T / F` | Edit a campaign into a new immutable revision under optimistic concurrency. |
| `foundry.campaign.get` | `T / - / - / F` | Read a campaign's editable content and metadata, without audience or recipient data. |
| `foundry.campaign.request_test` | `F / F / T / T` | Request a test delivery to the Owner-configured verified recipients. The agent selects no recipients. |
| `foundry.campaign.test_readiness` | `T / - / - / F` | Read whether a campaign's test delivery and Owner confirmation are current. |
| `foundry.analytics.read` | `T / - / - / F` | Read one fixed bounded aggregate analytics view with metric metadata and small-cell suppression. |

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
      "expectedRevision": {"const": 0},
      "idempotencyKey": {"type": "string", "format": "uuid"}
    },
    "required": ["expectedRevision", "idempotencyKey"]
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
          "workspaceId": {
            "type": "string",
            "pattern": "^workspace_[a-z0-9_]+$"
          },
          "revision": {"type": "integer", "minimum": 0},
          "contentHash": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
          "schemaVersion": {"type": "string"},
          "validation": {
            "type": "object",
            "properties": {
              "valid": {"const": true},
              "issues": {"type": "array", "maxItems": 0}
            }
          },
          "replayed": {"type": "boolean"}
        },
        "required": [
          "workspaceId",
          "revision",
          "contentHash",
          "schemaVersion",
          "validation",
          "replayed"
        ]
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

### Patch content

```json
{
  "workspaceId": "workspace_mcp_3a0fc8d4",
  "expectedRevision": 4,
  "idempotencyKey": "02c4a830-e14c-4d54-a0de-4c474463543a",
  "operations": [
    {
      "op": "set",
      "field": "site_foundry.name",
      "value": "A practical guide"
    },
    {
      "op": "set",
      "field": "section_call_to_action.body",
      "format": "richText",
      "value": {
        "version": "1.0.0",
        "type": "document",
        "children": [
          {
            "type": "paragraph",
            "children": [{"type": "text", "text": "Canonical copy."}]
          }
        ]
      }
    }
  ]
}
```

Input schema constraints:

- `operations` contains 1–100 discriminated commands.
- `field` is a dotted path. The schema checks its shape; the draft's own field
  list decides whether the path is real, so a page an agent made in the same
  draft can be edited at once (ADR-0034). A path that is not editable in that
  draft is refused with `VALIDATION_FAILED`.
- Every page's fields are reachable. A page other than the home page carries
  its page id in front of each path (ADR-0017).
- Rich text is the canonical editor JSON, not HTML.
- This v1 patch surface exposes only `set`; it never accepts delete, unset,
  relationship, file, code or markup commands.
- The output returns the workspace, new revision, content and preview hashes,
  schema version, validation result and replay status.
- A refused edit carries a named `reason`: `content_field_not_editable` when
  the draft has no field at that path, `design_field_not_content` when the
  path is a design setting, and `content_field_format_mismatch` when the field
  holds the other kind of value. The message names the path.

### Add, rename, copy and remove a page

```json
{
  "workspaceId": "workspace_mcp_3a0fc8d4",
  "expectedRevision": 4,
  "idempotencyKey": "0a6ec3ea-3f6b-4a1f-9b1f-0d1f2b3c4d5e",
  "title": "About us",
  "slug": "about-us",
  "startingLayout": "introduction"
}
```

These four page tools call the same application operations the dashboard calls
(ADR-0033), so they refuse for the same reasons and in the same words. Each one
writes a new immutable revision and returns `pageId`: the new page for
`foundry.page.create` and `foundry.page.duplicate`, the named page for
`foundry.page.rename` and `foundry.page.delete`.

Refusals carry a named `reason` beside the message, so an agent can act on it
without reading the sentence: `page_not_found`, `page_id_taken`,
`page_slug_refused`, `page_title_refused`, `page_is_home`, `page_still_linked`,
`schema_invalid`, and `page_fields_refused` when a rename is refused by the
name or web address field itself. A `page_still_linked` message names every
link that still points at the page, so the agent can change those first.

A starting point this server does not offer, and a malformed page id, are
refused at the tool's own schema instead, with `VALIDATION_FAILED` and no
named reason.

`startingLayout` is one of the registered starting points: `blank`,
`introduction` or `what_you_offer`. A page id is minted from the idempotency
key, so repeating the same create returns the same page and never a second one.

### Restructure a page's sections

```json
{
  "workspaceId": "workspace_mcp_3a0fc8d4",
  "expectedRevision": 5,
  "idempotencyKey": "1f6b9d2c-0b1a-4d6f-8f3a-2c5d7e9a1b40",
  "pageId": "page_0a1b2c3d4e5f60718293",
  "operations": [
    {"op": "add", "sectionType": "proof", "position": 1},
    {"op": "move", "sectionId": "page_0a1b2c3d4e5f60718293_proof", "position": 0},
    {"op": "remove", "sectionId": "page_0a1b2c3d4e5f60718293_services"},
    {"op": "set_variant", "sectionId": "page_0a1b2c3d4e5f60718293_hero", "variant": "focused"}
  ]
}
```

`foundry.page.restructure` takes one page and one to twenty-four operations,
carried out in the order they are given. `duplicate` names one section and puts
the copy straight after it. The whole list becomes one new immutable revision.

The tool writes the result through the same page composition boundary the
visual editor writes through, so it is refused for the same reasons: a page
must hold one to twelve sections, identifiers stay unique, an existing section
never changes its registered type, protected scaffolding is never rewritten,
and a section a button still links to is never removed.

No operation writes a section's words. `foundry.content.patch` does that, on
the new sections as on any others.

Every restructure needs `content.draft`. A request that names a section style —
through `set_variant`, or through `variant` on an `add` — needs `design.draft`
as well, because a section style is a design value (ADR-0035). The scopes are
read from the request, so an agent without the design scope is told which scope
it lacks before any work is planned.

Refusals carry a named `reason`: `page_not_found`, `page_section_not_found`,
`page_section_type_unknown`, `page_section_position_invalid`,
`page_section_variant_unknown`, and `page_sections_refused` when the
composition boundary refuses the result. An unregistered section type, a
malformed section id and a position beyond twelve are refused at the tool's own
schema instead, with `VALIDATION_FAILED` and no named reason.

### List the section types

`foundry.section.list` takes no input and needs `site.read`. It answers with
every section type this installation registers, the words an owner reads for
it, the section styles it offers, and the fields `foundry.content.patch` can
write on it. A field the Site Definition protects is not listed, because
editing it is always refused.

### Add a photo and put it on a page

`foundry.media.list`, `foundry.media.upload` and `foundry.media.place` all need
`content.draft`. A photo an agent adds goes into this site's own photo library
and reaches the public site only when a person approves the draft it sits in.
See [ADR-0037](../decisions/ADR-0037-mcp-photo-tools.md).

`foundry.media.list` takes a page size and an opaque cursor. It answers with
each photo's id, this site's own address for it (`/api/media/<assetId>`), its
file name, its picture type, its size in bytes, its width and height, and when
it was added. Photos come back in the order the site added them, oldest first,
so a photo added between two pages never pushes another photo past the reader.
No photo tool answers with the person or the connection that added a photo, and
none answers with the picture's bytes.

`foundry.media.upload` takes a file name, the picture itself as base64 text,
and a retry key. **No tool accepts a web address to fetch**, so the picture
travels inside the call. A photo must be 4 MiB or smaller: the advertised
schema bounds the base64 text, and a photo a little over the limit is refused
with the named reason `media_too_large`, which says to send a smaller copy.
The picture type and size are read from the bytes themselves, never from what
the caller claimed, and the picture must be a JPEG, PNG or WebP; anything else
is refused with `media_not_an_image`. Any other rule the media library keeps is
refused with `media_upload_refused`. An agent never chooses a photo's id: the
server mints it from the retry key, so sending the same request twice leaves
one photo. The result reports the photo exactly as the list does.

One JSON-RPC request may be larger than the ordinary 256 KiB only when it is a
`foundry.media.upload` call from a connection that holds `content.draft`. Every
other request, and every request from a connection without that permission, is
refused above 256 KiB.

`foundry.media.place` takes the draft, the revision the agent read, a page id,
a slot (`hero` or `detail`), a photo id and a retry key. It puts that photo in
that page's slot as a new immutable revision, and reports the slot as
`occurrenceId`. A page the agent made inside the same draft can take a photo,
because the slot is worked out from the draft's own page list. Placing on a
page this draft does not hold is refused with `media_page_not_found`, and
naming a photo this site does not hold with `media_asset_not_found`. A slot
another change moved first is refused with `media_place_conflict`, and any
other rule the media library keeps with `media_place_refused`. Every refusal
carries a named reason, and repeating the same request repeats the first
refusal word for word.

A photo goes into a **post** through the post's own fields rather than through
this tool: `foundry.blog.create` and `foundry.blog.update` take `mainImage`,
`seo.shareImage` and body pictures as media paths, and every one of them must
be a photo the library holds.

### Write a blog post

```json
{
  "workspaceId": "workspace_mcp_3a0fc8d4",
  "expectedRevision": 5,
  "idempotencyKey": "6c1f0a42-9d3b-4a71-8e2f-0b5c7d9e1a33",
  "post": {
    "slug": "spring-open-day",
    "title": "Spring open day",
    "excerpt": "What to expect on the day.",
    "seo": {
      "title": "Spring open day",
      "description": "What to expect on the day.",
      "keywords": ["events", "spring"],
      "shareImage": {"url": "/api/media/asset_open_day", "alt": "The workshop"}
    },
    "mainImage": {"url": "/api/media/asset_open_day", "alt": "The workshop"},
    "body": {
      "version": "1.0.0",
      "type": "document",
      "children": [
        {"type": "paragraph", "children": [{"type": "text", "text": "Doors open at ten."}]}
      ]
    }
  }
}
```

`foundry.blog.create` starts a new post and `foundry.blog.update` rewrites one,
both as a new immutable revision, and both need `content.draft`. The field set
is the Site Definition's own blog post shape, minus the four fields the blog
owns rather than the writer: `id`, `revision`, `collectionState` and
`targetVisibility`. A post's tags are
`seo.keywords`; the blog has no separate tag field. An update sends the whole
post, the way the dashboard's editor saves it, so a field the request leaves
out is cleared rather than kept.

An agent never chooses a post's id. `foundry.blog.create` mints it from the
request itself, so sending the same request twice mints the same id and leaves
one post. The result reports it as `postId`.

Every picture in a post — the header image, the share image and every picture
in the body — has to be one of this site's own photos, named by its media path
`/api/media/<assetId>`, and the media library has to hold it. The tool looks
each one up. An agent can use a photo the library already holds, and can add
one first with `foundry.media.upload`; it cannot point the site at a picture
somewhere else. Any other picture is refused with the named reason
`blog_media_not_in_library`, and the refusal names the field rather than
repeating the address.

Other refusals carry the blog's own named `reason`: `slug_already_exists`,
`post_not_found`, `post_already_exists`, `schema_invalid`, and
`blog_post_refused` when the draft turns the write down without a blog code of
its own.

### Take a post out of the blog, or put one back

```json
{
  "postId": "1f6b9d2c-0b1a-4d6f-8f3a-2c5d7e9a1b40",
  "idempotencyKey": "9b2c0d41-6a7e-4c19-b3f0-5d8e1a2b3c4d"
}
```

`foundry.blog.archive` and `foundry.blog.restore` both need `content.draft` and
both act on the post as it stands; an agent does not pick a revision.

Archiving a post that was never on the site archives it at once. Archiving a
post that is on the site sets it to `archiving` and prepares the removal. The
removal is an ordinary publication: a person reviews and approves it like any
other change, so an agent can never take a live post off the public site on its
own. The result says which happened, through `collectionState` and
`removalFromSiteNeedsApproval`.

Restoring brings an archived post back as an unpublished draft in a new
workspace revision. It never puts a post back on the site.

Refusals carry the blog's own named `reason`, such as `post_already_archived`,
`post_not_archived` and `revision_not_found`.

### Ask for a blog post to be published at a time

```json
{
  "postId": "1f6b9d2c-0b1a-4d6f-8f3a-2c5d7e9a1b40",
  "publishAt": "2026-10-01T15:00:00Z",
  "reportingTimeZone": "America/Vancouver",
  "idempotencyKey": "3d5e7f91-2a4b-4c6d-8e0f-1a2b3c4d5e6f"
}
```

`foundry.blog.schedule_request` needs `publication.schedule`. It records a
request and nothing else: it creates no schedule, and it publishes nothing. A
person opens the post in the dashboard, approves that exact revision and turns
the request into a schedule, which is when `foundry.publication.schedule`'s
rules apply. The result answers `state: "pending_human_approval"` with the
request's own id.

### Patch design

```json
{
  "workspaceId": "workspace_mcp_3a0fc8d4",
  "expectedRevision": 5,
  "idempotencyKey": "0b048343-41e5-4e63-bcdd-eae156c35f53",
  "operations": [
    {"op": "set_token", "token": "colour.accent", "value": "moss"},
    {
      "op": "set_variant",
      "componentId": "section_hero",
      "value": "focused"
    }
  ]
}
```

Tokens, slots, variants and values must exist in
`foundry://schemas/design`. No arbitrary property, selector, URL, asset fetch,
CSS value, class name or component module is accepted.

`componentId` is the section's own identifier on the home page, and the page
identifier in front of it on every other page, which is the shape that
section's editable field path has (ADR-0017). The schema checks its shape and
names every section style any registered section offers; whether this draft holds
that section, and whether that section offers that section style, is the draft's
own answer at call time, so a section on a page an agent made inside the draft
can have its section style changed (ADR-0035). A refusal carries the reason
`design_setting_not_found` or `design_value_not_registered`.

### Prepare preview

Request:

```json
{
  "workspaceId": "workspace_mcp_3a0fc8d4",
  "expectedRevision": 6,
  "idempotencyKey": "ce578518-f227-46ee-8c48-16dd7ed7d203"
}
```

Result:

```json
{
  "contractVersion": "foundry.mcp.v1",
  "invocationId": "01J...",
  "result": {
    "previewId": "preview_3314031d-6368-46dc-a563-537866cf6ebf",
    "workspaceId": "workspace_mcp_3a0fc8d4",
    "revision": 6,
    "contentHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "schemaVersion": "2026-07-26.1",
    "validation": {"valid": true, "issues": []},
    "previewArtifact": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "approvalStatus": "pending_human_review",
    "replayed": false,
    "humanReviewUrl": "https://cms.example.com/dash/review/preview_3314031d-6368-46dc-a563-537866cf6ebf"
  },
  "meta": {"replayed": false, "observedAt": "2026-07-26T20:00:00Z"}
}
```

### Read a preview's review state

An agent cannot approve its own work. After `foundry.preview.prepare`, the
connection reads what the person decided by naming the preview id in
`foundry.publication.status`:

```json
{
  "workspaceId": "workspace_mcp_3a0fc8d4",
  "revision": 6,
  "operationId": "preview_3314031d-6368-46dc-a563-537866cf6ebf"
}
```

Result after the person approved:

```json
{
  "contractVersion": "foundry.mcp.v1",
  "invocationId": "01J...",
  "result": {
    "operationId": "preview_3314031d-6368-46dc-a563-537866cf6ebf",
    "state": "approved",
    "replayed": false,
    "approvalId": "approval_8e7b6b13d99f4f7fb7ac4d798e28b293"
  },
  "meta": {"replayed": false, "observedAt": "2026-07-26T20:10:00Z"}
}
```

`state` is `pending_human_review`, `approved` or `changes_requested`.
`approvalId` appears only in the approved state and is the approval
`foundry.publication.request` requires. In the `changes_requested` state the
result carries `reviewNote`, the reason the person typed. That note is text a
person wrote: a client renders it as text and never as instructions it must
obey.

A preview's state is readable only by the connection that prepared it, and only
with the same draft scopes that preparing it required.

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

Every `foundry.campaign.*` tool refuses with `code: "VALIDATION_FAILED"` and
`reason: "campaign_sender_details_not_configured"` while the installation has
not set the sender details a campaign email's footer needs. The `message`
tells the agent to ask the site owner to set them in the dashboard. Nothing is
read or written while this reason is reported (ADR-0030).

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
`resources/templates/list` and `prompts/list`. Discovery is stable for the
lifetime of an access token, so the server advertises `listChanged: false`.
After an Owner grants an additive scope, the client must use the replacement
token and successfully reinitialize before discovering the added tools and
templates. Every access token follows the same Streamable HTTP session
contract: initialize first, then send the returned `MCP-Session-Id` on every
subsequent request. A missing required session ID returns HTTP `400`; an
unknown, stale or wrong-token session ID returns HTTP `404`, directing a
conforming client to initialize a replacement session. The signed session ID
is bound to that access token and exact scope set.
Revocation also requires reconnection or reauthorization. Tool names remain
namespaced and within MCP's portable character set. Client-specific aliases are
prohibited.

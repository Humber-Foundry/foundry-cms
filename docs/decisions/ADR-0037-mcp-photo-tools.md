# ADR-0037: An agent adds a photo by sending its bytes, and places it through the media library's own commands

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

An agent could already write a blog post and build a page, but it could only
name photos the site already held. `mediaLibraryHoldsAsset` refused every other
picture with the reason `blog_media_not_in_library`
([ADR-0036](ADR-0036-mcp-blog-post-tools.md)). The consent screen said so: "It
can write a blog post, but it cannot upload a photo."

Issue [#172](https://github.com/Humber-Foundry/foundry-cms/issues/172) asks for
three photo tools — list, add, place — and for the rest of the campaign
lifecycle. This record covers the photo half. The campaign half is a separate
slice, because the two share no code and each needs its own tests and its own
migration.

Three things already existed and had to be reused rather than rebuilt.

The media library is `packages/application/src/media-assets.ts`. Its
`commands.upload` hashes the picture, writes the object to the client-owned R2
bucket through `MediaSourceStore`, and records the asset in D1. The dashboard's
own upload route, `apps/reference-site/app/api/foundry-cms/media/route.ts`,
reads the real picture type and size with `inspectImageSource` and then calls
that one command.

A photo on a page is a media occurrence. The occurrence id names the page —
`occurrence_home_hero` for the home page, `occurrence_<pageId>_hero` for every
other page ([ADR-0026](ADR-0026-analytics-and-media-occurrences-per-page.md)).
The content revision store refuses to write a page's photo unless the media
occurrence head already stands at the revision the write names, so a placement
is always two steps: advance the occurrence, then write the definition.

The MCP threat model forbids a tool that accepts a web address. "No tool
accepts URLs" is the control against server-side request forgery, and the
JSON-RPC body limit was 256 KiB.

## Decision

**An agent sends the picture's own bytes, never an address to fetch.**

`foundry.media.upload` takes `bytesBase64`. Nothing fetches anything, so the
SSRF control stands unchanged. A photo is capped at 4 MiB before it is decoded:
the advertised schema bounds the base64 text, and the application bounds the
decoded length again with the named reason `media_too_large`.

**The JSON-RPC body limit stays 256 KiB for every request but one.**

The body is read up to 6 MiB, then the parsed request is inspected. A body
above 256 KiB is refused with 413 unless the request really is one `tools/call`
for `foundry.media.upload`. This keeps the small limit on every other method
and every other tool, and gives the upload just enough room for 4 MiB of
picture plus its base64 padding and the JSON around it.

**An upload runs the dashboard's own upload command, not a second path.**

`inspectImageSource` reads the type and the dimensions from the bytes, never
from what the caller claimed. `isMediaContentType` then holds the picture to
the three types the library stores. `commands.upload` does the rest. There is
no weaker path: an agent's photo and a person's photo go through the same
command, the same hashing, the same R2 write and the same D1 record.

**The server mints the photo's id from the retry key.**

The id is the first sixteen bytes of `SHA-256(siteId:actorId:idempotencyKey)`,
rendered as `asset_<32 hex>`. A retry after an unknown result mints the same id
and leaves one photo, not two. An agent never chooses a photo's id, so it can
never reach an id another actor reserved.

**A placement goes through the media library's occurrence command and then the
draft, exactly as the dashboard does.**

`foundry.media.place` names a page and a slot, not an occurrence id. The tool
resolves `pageMediaOccurrenceId(page, slot)` from the draft's own page list, so
a page an agent made inside the draft can take a photo. It then calls
`commands.replaceOccurrence` and `commands.saveMediaOccurrence`, in that order.
Because the placement writes a draft revision, it records its receipt in
`mcp_mutation_receipts` and migration 0033 widens that table's `operation`
check. A list writes nothing, and an upload writes no draft revision and keeps
its receipt and its audit in the media library's own tables, so neither is
named there.

**`bindSiteMediaOccurrence` now puts the photo on the page the occurrence id
names.**

It bound every occurrence to the home page, which was right when a site had one
page. It now reads the page from the occurrence id with
`findPageByMediaOccurrenceId` and refuses when no single page claims it, which
the draft reports as "This draft has no page for that photo slot." The
dashboard sends only `occurrence_home_*`, which still resolves to the home
page, so nothing a person does changes.

**Every photo tool needs `content.draft`, and no more.**

Adding a photo and placing one are draft work: the photo reaches the public
site only when a person approves the draft it sits in. The photo library is not
published content either, so reading it needs the same permission rather than
`site.read`.

**A photo tool returns no person.**

`McpMediaAsset` carries the photo's id, the site's own address for it, its file
name, its type, its size, its dimensions and when it was added. It does not
carry `createdBy`, and no photo tool returns the picture's bytes.

**The consent screen now says what an agent can do.**

"It cannot upload a photo" would claim less than the tools grant, which the
screen must never do. It says where an added photo stops instead: the photo
library and a draft, and the live site only after the owner approves that
draft.

## Consequences

A site owner can ask an agent for a photo and see it in the preview they
already review. Nothing reaches the public site without the same approval every
other change needs.

An agent-added photo has no small preview copy. The dashboard's upload makes
one in the browser before it sends the picture; a Worker has no image
processing, so an MCP upload stores none. The gallery already handles a photo
with no small copy — it shows the tile without a preview — so this is a
smaller picture in the Photos page, not a failure. Making the small copy
server-side is follow-up work.

A photo above 4 MiB cannot be sent through MCP. A person can still upload a
larger original in the dashboard. An agent that has a larger picture must send
a smaller copy, and the refusal says so.

The larger upload ceiling is a real increase in what one authorized connection
can ask the server to hold in memory. It is bounded three ways: the connection
must already hold `content.draft`, which only the owner can grant; the ceiling
applies to one named tool and nothing else; and the ordinary per-connection
rate limits still apply.

## Alternatives considered

**Fetch a URL the agent supplies.** Rejected. It is the SSRF hole the threat
model closes, and fencing it — an allowlist of hosts, a DNS-rebinding guard, an
egress proxy — would add a large new control surface for a convenience.

**Raise the JSON-RPC body limit for every request.** Rejected. It widens the
exhaustion surface for every method, including the ones an unauthenticated
caller can reach, to serve one tool.

**Keep the 256 KiB limit and cap a photo at about 180 KiB.** Rejected. Most
ordinary web photos are larger, so the tool would refuse the common case and
the owner would learn the agent "cannot really add photos".

**A prepared upload address the agent PUTs bytes to.** Rejected. The clients
this product must serve — claude.ai, ChatGPT, Claude Code — call MCP tools;
they have no general way to make an arbitrary HTTP request, so the tool would
be unusable by its own users.

# ADR-0034: MCP reads and writes every page, and a content field path is checked against the draft rather than against the installed site

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

A site built on this product can now hold more than one page
([ADR-0016](ADR-0016-site-definition-page-collection.md)), and a page can be
created, renamed, duplicated and deleted by one set of application operations
([ADR-0033](ADR-0033-page-lifecycle-operations.md)). The MCP surface had not
caught up. Three things were wrong.

`foundry.content.list` listed one page: the home page. `foundry.content.get`
answered only the home page's id. An agent could therefore not find, or read,
any other page.

`foundry.content.patch` advertised its `field` argument as a closed list of
paths, built at module load from the definition the installation ships with.
A page an agent makes inside a draft has field paths that definition has never
held, so the tool refused every edit to the page the agent had just made.

[Issue #146](https://github.com/Humber-Foundry/foundry-cms/issues/146) records
what the site owner asked for: an agent must be able to edit the site, create
pages and restructure pages. None of that is possible while the MCP surface
can only see one page.

## Decision

**Every MCP read answers for every page. A content field path is checked for
its shape at the schema and for its truth against the draft. Four page tools
call the four application page operations, and nothing else.**

### 1. The reads answer for every page

`foundry.content.list` returns one item per page in `definition.pages`, in the
order the definition holds them, each with its resolved SEO title and its own
content hash. `foundry.content.get` finds a page with `findPageById`. An agent
lists the pages, picks one and reads it; it never has to guess an id.

### 2. A field path is shape-checked at the schema and truth-checked at the draft

`foundry.content.patch` no longer advertises an enumeration of field paths.
The input schema requires a dotted chain of identifiers, which is the shape
`listEditableSiteFields` builds. Whether a path is real, and whether it takes
plain text or rich text, is answered by the draft's own field list at call
time, where it was already answered before this change.

The enumeration had to go, because it could only ever describe the installed
site. It could not describe a page that does not exist yet, and a page an
agent makes exists only inside the draft until the owner approves and
publishes it. Keeping the list would have left the create tool useful and the
edit tool useless on the page it had just made.

What the enumeration bought was a refusal at the client, before a call. That
is a convenience, never the authority: the same path was, and is, checked
twice more on the server, by the tool registry and by
`applySiteDefinitionEdits`. An agent that wants the current list of paths reads
the draft through `foundry.workspace.get`, which returns the whole definition.

The moved bound shows in the schema snapshot: `foundry.content.patch` has a
new `inputSchemaSha256`, and the snapshot was regenerated with this change.

### 3. Four page tools, and no second set of rules

`foundry.page.create`, `foundry.page.rename`, `foundry.page.duplicate` and
`foundry.page.delete` call `createPage`, `renamePage`, `duplicatePage` and
`deletePage` in `packages/application`. They add the MCP front — the draft
scope, the replay receipt, the base-revision check and the audit — and nothing
else. ADR-0033 wrote the rules once so that an agent and a site owner are
refused for the same reasons; repeating any of them here would have undone
that.

Each tool needs `content.draft`, because a page operation writes content. Each
takes the workspace, the revision the agent read, an idempotency key and what
it is being asked to do. Each returns the new revision, its preview artifact
and `pageId`: the new page for a create or a duplicate, the named page for a
rename or a delete.

Adding a page and copying one add to the draft, so both are marked
`destructiveHint: false`. Renaming a page overwrites its name and web address,
and deleting one removes it, so both are marked `destructiveHint: true`, the
same as an ordinary content edit.

### 4. A refusal carries a named reason, and a replay repeats it

`ContentPageOperationError.code` becomes the tool error's `reason`, and the
sentences the draft wrote for the site owner become its `message`. An agent
reads `page_is_home` or `page_still_linked` and acts on it without parsing
English.

A rename is two ordinary field edits, so its refusals come from the name and
web address fields rather than from a page lifecycle code. Those carry the
reason `page_fields_refused` with the field's own sentences as the message.

A refused draft mutation is stored as a receipt so that repeating the request
answers the same way. The receipt stored the code and the message but not the
reason, which would have made a replayed refusal say less than the first one.
Migration `0030_mcp_page_operation_receipts.sql` adds `error_reason` to
`mcp_mutation_receipts` and widens its `operation` list to name the four page
operations.

## Consequences

An agent can now do the whole job the owner asked for: list the pages, read
one, make a new one, edit its fields, rename it, copy it, delete it, and
prepare a preview for the owner to approve. The publish path is unchanged, so
nothing reaches the live site without a person approving it
([ADR-0004](ADR-0004-draft-preview-publish-pipeline.md)).

A client that cached the old `foundry.content.patch` input schema sees a
changed schema on its next `tools/list`. Nothing an agent could send before is
refused now; the schema only admits more.

`foundry.design.patch` still builds its component variant list from the
installed definition, so a section on a page an agent made in a draft cannot
have its variant changed through MCP yet. That is the same fault this record
fixes for content, in the one place it has not been fixed, and it needs its own
ticket.

The reference site stays a one-page published site. The page tools work inside
a draft, and the draft is only published if a person approves it.

## Alternatives considered

**Keep the enumeration and rebuild it per draft.** A tool descriptor is built
once for `tools/list`, before any draft is named, so there is no draft to build
it from. Advertising the installed site's paths and accepting more at call time
would have made the schema say something untrue.

**Give the agent a tool that lists the draft's editable fields.** It would
help, and it may still be worth having. It was left out because
`foundry.workspace.get` already returns the definition an agent needs, and
#161 is about addressing pages rather than about adding a discovery surface.

**Put the page rules in the MCP layer.** Rejected for the reason ADR-0033 gives:
the dashboard and the agent must refuse for the same reasons, and a rule
written twice drifts.

**Leave the refusal reason out of the stored receipt.** Rejected because a
replayed refusal would then carry less than the first refusal for the same
request, which is exactly what an idempotency receipt exists to prevent.

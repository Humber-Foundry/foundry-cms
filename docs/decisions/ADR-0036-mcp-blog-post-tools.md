# ADR-0036: An agent writes and files blog posts through the blog's own commands, and a person still decides what the public site shows

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

Until now an agent could set the words of a page and a blog post that already
existed, but it could not start a post, and it could not touch the blog
collection at all. The consent screen said so: "It cannot start a new blog post
from nothing or upload a photo."

Issue [#171](https://github.com/Humber-Foundry/foundry-cms/issues/171) asks for
five blog tools: write a post, rewrite one, take one out of the blog, put one
back, and ask for one to be published at a time. Slice one of that issue
shipped the page tools and is recorded in
[ADR-0035](ADR-0035-mcp-page-restructure-and-draft-scoped-variants.md). This
record is slice two.

Two things already existed and had to be reused rather than rebuilt.

A blog post inside a draft is an ordinary Site Definition record. The dashboard
writes one through `commands.createBlogPost` and `commands.editBlogPost`, which
call `createBlogPostDefinition` and `editBlogPostDefinition`.

The blog collection is a different layer, built for
[#166](https://github.com/Humber-Foundry/foundry-cms/issues/166) and
[#177](https://github.com/Humber-Foundry/foundry-cms/issues/177). Archive,
restore and schedule proposals live in
`packages/application/src/blog-post-operations.ts`, with the reference site's
own steps in `apps/reference-site/src/blog-post-operations-runtime.ts`. Every
command in that layer required an active owner or editor membership, in the
application and again in the D1 statement.

The hard question was the public site. An agent must never be able to take a
live post off it, and must never publish.

## Decision

**An agent writes a blog post the way the dashboard writes one, files a post
through the blog's own commands under the connection's own authority, and can
only ask for a schedule; every change to the public site still needs a person's
approval.**

### 1. Five tools, and each one calls the command the dashboard calls

`foundry.blog.create` and `foundry.blog.update` call
`commands.createBlogPost` and `commands.editBlogPost`.
`foundry.blog.archive` calls `commands.archive` through
`archiveBlogPostWithWithdrawal`. `foundry.blog.restore` calls
`commands.restore` through `restoreArchivedBlogPostAsDraft`.
`foundry.blog.schedule_request` calls `commands.proposeSchedule`. Nothing about
the blog's rules is written a second time in the MCP layer. The MCP front adds
only the connection's permission, the replay handling, the base-revision check
and a refusal an agent can read.

### 2. An MCP connection is its own actor, so the blog commands learned to
accept one

The blog layer already had this shape for one command:
`activateSchedule` takes an optional `authority` record naming the connection,
and checks it instead of a human membership. Archive, restore and
`proposeSchedule` now take the same record, and the D1 statements that
guarded those commands with a `human_memberships` row now accept either an
active owner or editor, or an active MCP connection holding every permission
the request evaluated. One SQL fragment, `contentAuthoritySql`, writes that
rule once.

A connection never borrows the membership of the person who granted it. The
audit row names the connection's own actor, so a change an agent made and a
change a person made are told apart afterwards.

### 3. Archiving is content work, and it does not take a live post off the site

`foundry.blog.archive` and `foundry.blog.restore` need `content.draft` and
nothing more, because neither changes what the public site shows.

Archiving a post that was never on the site archives it at once. Archiving a
post that is on the site sets it to `archiving` and prepares a removal draft.
That removal is an ordinary publication: a person reviews and approves it, and
`continueArchiveBlogPostWithdrawal` refuses without a human approval id. So an
agent can start a removal and can never finish one. The tool's result says
which case it is, through `collectionState` and
`removalFromSiteNeedsApproval`, and the consent screen says the same thing in
the owner's words.

Restoring brings a post back as an unpublished draft in a new workspace
revision. It never puts a post back on the site.

### 4. A schedule is asked for, not made

`foundry.blog.schedule_request` needs `publication.schedule` and records a
schedule proposal. It creates no schedule and publishes nothing. A person opens
the post in the dashboard, approves that exact revision and turns the proposal
into a schedule, which is the point at which
[ADR-0025](ADR-0025-preview-review-decision-record.md)'s approval rules and
`foundry.publication.schedule` apply. The result answers
`state: "pending_human_approval"`, so a client cannot read it as a promise that
anything will go out.

### 5. The agent writes the post, but it never chooses the post's id

A blog post id is a version 4 UUID. `mintedContentBlogPostId` builds it from
the request's own digest — the idempotency key inside its workspace — exactly
as `mintedContentPageId` builds a page id. Sending the same create twice mints
the same id and leaves one post, so a retry after an unknown result is safe.
The result reports it as `postId`.

`commands.createBlogPost` and `commands.editBlogPost` now answer with the
saved revision plus `postId` and `replayed`, which is what a tool has to
report and what a caller could not see before.

### 6. A post's pictures are this site's own photos, and nothing else

Every picture address in a post — the header image, the share image and every
picture in the body — has to be this site's media path,
`/api/media/<assetId>`. Anything else is refused with the named reason
`blog_media_not_in_library`. An agent can use a photo the media library already
holds; it cannot add one, and it cannot point the site at a picture somewhere
else. Uploading a photo is
[#172](https://github.com/Humber-Foundry/foundry-cms/issues/172) and is still
not an MCP tool.

### 7. A post's tags are `seo.keywords`

The issue asks for tags. The Site Definition has no separate tag field on a
blog post; the list it keeps is `seo.keywords`, and that is what the blog and
the renderer already read. The tool takes the post's own field set unchanged
rather than inventing a second name for the same list.

### 8. Every refusal carries a named reason

The blog's own codes are the reasons an agent branches on:
`slug_already_exists`, `post_not_found`, `post_already_exists`,
`post_already_archived`, `post_not_archived`, `revision_not_found`,
`schema_invalid`, plus `blog_media_not_in_library` for a picture this site does
not hold and `blog_post_refused` when the draft turns a write down without a
blog code of its own. The message is the plain sentence a site owner would
read.

## Consequences

The MCP surface has twenty-nine tools. The catalog, the permission matrix, the
conformance manifest and the registry tests all count them.

`foundry.blog.create` and `foundry.blog.update` write draft revisions, so they
record receipts in `mcp_mutation_receipts`; migration
`0032_mcp_blog_draft_receipts.sql` names them in that table's operation list.
Archive, restore and the schedule request are not draft writes: they keep their
own audit in `blog_post_operation_audit_events` and add no receipt, so they
need no new table.

The consent screen no longer says an agent cannot start a blog post, because it
can. It now says an agent cannot upload a photo, and that a post already on the
site comes off it only with the owner's approval. Both sentences are true of
the tools that ship.

The publish path is unchanged. No blog tool creates an approval, and no blog
tool writes to Git. `commands.approve` is still reachable only from the
dashboard.

## Alternatives considered

**Let archive and restore stay human-only, and give the agent a request to
file instead.** Rejected. There is no request store for archive or restore and
no dashboard screen to answer one, so building them would mean a second
implementation of the blog's own rules — the thing this record exists to
avoid. The property that matters is that a live post needs a person's
approval to come off the site, and that property already holds without a
request.

**Let the agent act under the membership of the person who granted the
connection.** Rejected. The MCP threat model treats the connection and the
person as distinct actors even when they are the same human. Borrowing the
membership would make an agent's archive indistinguishable from the owner's in
the audit trail, and would let a revoked connection's work look like a
person's.

**Let the agent choose a post's id, or pick which revision to archive.**
Rejected. An id an agent chooses cannot be replayed safely, and a revision an
agent chooses is a chance to archive something other than what it read. Both
act on the post as it stands, which is what the dashboard's own controls do.

**Add a separate `blog.draft` permission.** Rejected. Writing a post is
drafting content, which is what `content.draft` already means, and a new scope
would mean another migration, another consent line and another thing for an
owner to understand for no added safety.

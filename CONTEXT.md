# Foundry CMS domain language

This glossary names the concepts shared by the visual editor, MCP, scheduler,
Git publisher and delivery-provider adapter. Implementation contracts and state
machines live in the linked domain documents.

## Publishing

**Content item** — A stable editorial identity whose revisions may change over
time. A content item is not itself a draft file or a published version.

**Revision** — An immutable version of one content item. Editing always creates
a new revision; it never changes a revision that was previewed, approved,
published, tested or sent.

**Rendered artifact** — The immutable output produced from one revision by one
schema and renderer version for a specific channel.

**Fingerprint** — A deterministic digest that identifies every input relevant
to an approval or execution. Equal fingerprints mean equal approved inputs, not
merely similar visible copy.

**Approval** — A human authorization bound to one exact fingerprint. Approval
is evidence for a later operation; it is not an actor, schedule or execution.

**Schedule proposal** — A non-binding suggested time and time zone. It grants no
authority to execute.

**Active schedule** — Durable execution intent authorized by a human for one
exact approval and resolved instant.

**Execution** — One logical attempt to publish or send approved material. It has
a stable identity across retries so an uncertain response cannot create a
duplicate publication or bulk delivery.

**Publication** — Serialization of approved site content to Git followed by a
verified deployment. A Git commit alone is not proof that content is live.

**Live revision** — The revision verified as serving at the public site. A
content item may have a live revision while a different draft revision is being
edited.

**Unpublish** — A new publication that removes a content item from the public
site without deleting its history or editable content.

**Archive** — A reversible editorial withdrawal that cancels pending work and
preserves the item, its revisions and its history. Archive is not deletion.

**Restore** — Creation of active, unpublished work from an archived item. It
does not silently republish an old revision.

## Media

**Media asset** — A stable, site-scoped identity and metadata record for one
immutable source image stored in the client's private R2 bucket.

**Media occurrence** — One stable placement of a media asset in editable
content. Replacing an occurrence changes that placement without changing other
occurrences that reference the same asset.

**Media occurrence revision** — An immutable snapshot of one occurrence's
asset reference and optional normalized crop. A crop is presentation data; it
never rewrites the media asset's source object.

## Blog

**Post** — A stable blog-content identity with zero or more immutable post
revisions and at most one live revision.

**Post revision** — An immutable snapshot of a post's schema-valid fields,
references and deterministic Markdown representation.

## Newsletter

**Campaign** — A stable email-campaign identity with immutable campaign
revisions and at most one completed bulk send in v1.

**Campaign revision** — An immutable snapshot of every send-affecting campaign
input, including content, sender, audience definition and compliance material.

**Derived campaign** — A campaign initially copied from one post revision. The
source relationship records provenance only; later post edits never mutate the
campaign.

**Audience definition** — The versioned rules that identify eligible
subscribers. It contains no frozen addresses.

**Audience snapshot** — The consent- and suppression-filtered recipient set
resolved for one execution. It is identified and counted in the CMS; ordinary
agent access never reveals its addresses.

**Test delivery** — A real provider test-send operation for one exact campaign
fingerprint and explicit test recipients. An on-screen preview is not a test
delivery.

**Bulk-send authorization** — An Owner's approval of the exact campaign
fingerprint and successful test delivery. It is the only approval that can
support an active campaign schedule or immediate bulk send.

**Send operation** — One logical bulk delivery, identified independently of
provider requests and retried without changing identity.

**Suppression** — A durable negative subscriber state that blocks delivery.
Routine synchronization never reverses it.

## Actors

**Owner** — A human who may authorize bulk sending and perform all Editor
publishing operations.

**Editor** — A human who may prepare campaigns and approve and publish site or
blog content, but may not authorize bulk sending or access subscriber
identities.

**MCP agent** — A site-scoped non-human author that may prepare drafts, request
tests and propose schedules but may not approve its own work, activate
schedules or send bulk email.

**Integration** — A narrowly scoped non-human adapter or callback identity. It
reports external facts or performs requested provider operations; it does not
originate human authorization.

**System scheduler** — A non-human executor that may claim due work only when a
still-valid human approval and active schedule already exist.

## Linked domain documents

- [Blog and newsletter publishing lifecycle](docs/domain/blog-newsletter-publishing-lifecycle.md)
- [Draft, preview and publish pipeline](docs/decisions/ADR-0004-draft-preview-publish-pipeline.md)
- [Default newsletter-delivery adapter](docs/decisions/ADR-0002-default-newsletter-delivery-adapter.md)
- [Guided per-client provisioning and operator CLI](docs/architecture/guided-client-provisioning.md)

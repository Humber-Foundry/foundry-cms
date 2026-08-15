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

**Restore** — Creation of active, unpublished work from an archived item or a
selected published revision. It does not silently republish an old revision;
published-version restore creates a new draft on the current production base.

## Media

**Media asset** — A stable, site-scoped identity and metadata record for one
immutable source image stored in the client's private R2 bucket.

**Media occurrence** — One stable, draft-workspace-scoped placement of a media
asset in editable content. Replacing an occurrence changes that placement
without changing other occurrences or another workspace that uses the same
occurrence identity.

**Media occurrence revision** — An immutable snapshot of one occurrence's
asset reference and optional normalized crop. A crop is presentation data; it
never rewrites the media asset's source object. A selected occurrence revision
is bound into an immutable content revision before it appears in an exact
preview; only the Git-published Site Definition is public.

## SEO and sharing

**SEO metadata** — The owner-filled block that decides how one piece of content
looks in a search result and in a link preview: title, description, keywords and
share image. Site pages, blog posts and newsletter campaigns carry the same
field set. Every field may be left blank; blank asks for the fallback.

**Fallback** — The value the renderer uses when an SEO field is blank. A blank
description becomes the post excerpt, then the site description. A blank title
becomes the content's own heading followed by the site name, except on the home
page, whose heading is the site name itself, so it uses the site name alone. A
blank share image becomes the home page's share image, then the home hero. A
fallback is computed at render time and never written back into the content.

**Listing** — A public route that shows other content rather than content an
owner writes, such as the blog index. A listing has no SEO metadata of its own.
Its title is its own heading with the site name after it — the same
heading-then-site-name shape every page below the home page uses — and it
borrows the site description and share image. Its link preview is still right,
and no owner is asked to fill a field for a page they did not write.

**Share image** — The picture shown when a page, post or campaign is shared as a
link. It is an address and an alt text. A page or post may use a path on the
site; a campaign must use an absolute address, because an email is read outside
the site.

**Canonical origin** — The public address a site serves from, held in the Site
Definition. Every canonical and share URL is derived from it plus the route
path. It is not `FOUNDRY_CANONICAL_ORIGIN`, which is the dashboard's
request-integrity origin. An empty canonical origin means the installation has
not set one, and the renderer then emits no address rather than a wrong one.

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

**Stable send key** — The deterministic digest that names one send operation's
logical delivery. It survives every retry, so an uncertain provider response can
never become a second delivery.

**Send artifact** — The provider-neutral record of exactly what one send
operation dispatched: content, sender reference, compliance version,
audience-definition version, approval fingerprint and non-identifying audience
counts. It is committed to Git before the first provider call and contains no
subscriber address.

**Provider send proof** — An installation-keyed digest of one send operation's
exact binding, written durably before the provider request and carried in it.
A delivery event is authenticated evidence only when it presents this proof.

**Execution lease** — A bounded, single-holder claim on one operation's
execution. An expired lease may be reclaimed for the same operation; it never
authorizes a second one.

**Suppression** — A durable negative subscriber state that blocks delivery.
Routine synchronization never reverses it.

## Messages

**Submission** — One thing a visitor sent through a form on the site: the
field values, the instant it arrived, and its receipt. A submission is
immutable. The only change it ever takes is erasure of what it says.

**Receipt** — The identifier that names one submission to a human. It appears
in the dashboard address for that submission and in the owner notification.

**Inbox** — The list of accepted submissions, newest first. It shows a bounded
summary of each one, never the whole submission.

**Inbox role** — What one form field means in that summary: `sender` for the
person's name, `replyAddress` for the address to reply to, `preview` for the
line worth showing. A field with no role appears only when a human opens the
submission.

**Reply address** — The address a visitor gave in the field the form marks as
`replyAddress`. It becomes a reply link only when it holds nothing but an
ordinary address; otherwise it is still stored and still read in full on the
submission's own page.

**Read state** — Whether any human has opened a submission. It belongs to the
site, not to one person: an Owner or an Editor opening a message makes it read
for everyone. The first reader is recorded and never replaced.

**Spam hold** — The state of a submission the spam check kept out of the
inbox. The submission is stored in full and its owner notification waits.
Accepting it moves it to the inbox and releases that notification.

**Owner notification** — The email that tells the Owner a submission arrived.
Storing the submission and sending this email are separate operations, so a
notification that never arrives never loses a submission.

## Analytics

**Analytics fact** — One aggregate measurement of a product object over one
time bucket, from one source. It describes a page, form, campaign or the site
itself. No fact describes a person, a session or a request.

**Metric key** — The stable product name of a measurement, such as
`form.submissions_accepted`. Provider and platform field names are kept as
source metadata, so a query names only the metric key.

**Quality** — What kind of number this is: `exact` when the CMS transaction
recorded it, through `estimated`, `best_effort` and `provider_reported`, to
`unreliable` for a signal such as a reported open. Every reading carries its
quality.

**Availability** — Whether a measurement exists. A measurement that is missing
has state `unavailable` and a reason. A source outage therefore produces
`source_unavailable` measurements, and the dashboard names that reason.

**Comparability signature** — Everything that must match before two numbers
mean the same thing: metric, source, source name, provider metric and
definition version. Values that do not share one signature are shown side by
side, each with its own label.

**Complete through** — The instant a source has fully reported. A bucket that
extends past it is marked in progress.

**Source state** — One source's status, last attempt, last success,
completeness and retry time. Its error code is a stable, non-secret value. No
provider message or credential is stored in it.

**Small-cell suppression** — Breakdown rows below five are reported as
"fewer than 5". A business object's own total is still reported exactly.

**Compaction** — Rolling closed hourly facts into one daily fact after 90 days.
Where the source already wrote that day's fact, compaction removes the hours
and keeps the source's own total. A day whose hours span a definition change,
or that mixes measured and unavailable hours, is left alone and the skip is
logged.

**Retention floor** — The instant, 25 months back, before which aggregate facts
and their revision audit rows are deleted on each scheduled run.

**Poll band** — How far back a provider run asks for changed campaigns: 72
hours on every run, 30 days once a day, 97 days once a week. The widest band
covers 97 days, which puts a campaign's final reconciliation at or after day
90.

## Actors

**Owner** — A human who may authorize bulk sending and perform all Editor
publishing operations.

**Editor** — A human who may prepare campaigns and approve and publish site or
blog content, but may not authorize bulk sending or access subscriber
identities.

**MCP agent** — A site-scoped non-human author that may prepare drafts, request
tests and propose schedules, and may request publication or blog scheduling for
a revision a human already approved. It may not approve its own work, supply
its own approval evidence, publish or schedule anything a human has not
approved, or send bulk email.

**Integration** — A narrowly scoped non-human adapter or callback identity. It
reports external facts or performs requested provider operations; it does not
originate human authorization.

**System scheduler** — A non-human executor that may claim due work only when a
still-valid human approval and active schedule already exist.

## Installation and provisioning

**Installation** — One deployed Foundry CMS site in accounts the client owns.
Its `installationId` names the logical site for the site's whole life and never
changes, including across reprovisioning.

**Deployment** — One account-bound set of Cloudflare resources for an
installation. Its `deploymentId` changes only when a separate set is
intentionally created, such as a cutover from temporary hosting. Every provider
resource name is derived from the deployment, so two installations, or two
deployments of one installation, can never collide on a name.

**Resource stem** — The deterministic `<slug>-<suffix>` prefix every derived
provider resource name uses, where the suffix is hashed from the deployment ID.

**Configuration fingerprint** — A deterministic digest of one resource's
declared, non-secret configuration. It states what the operator intends and what
the provider was observed to be; it never carries a credential.

**Account-scope fingerprint** — A one-way digest binding an operation to one
provider account. A fresh operator recomputes it; the raw account ID is never
committed.

**Provisioning step** — One unit of provisioning work with `inspect`, `plan`,
`apply` and `verify` behaviour. A step is `verified` only after the client
account was read back and its health check passed; `applying` is never evidence
that a write landed.

**Resource classification** — The result of inspecting the client account for
one resource: `absent`, `exact`, `repairable_drift`, `incompatible_drift`,
`ambiguous` or `foreign`. A matching name alone is never `exact`.

**Create intent** — A durable pre-create record naming the provider, exact
resource name, account scope, desired fingerprint and one-use nonce. It is
committed before any create the provider cannot make idempotent, so an ambiguous
response can be resolved later against evidence rather than correlation.

**Provisioning journal** — The installation's durable step, resource and
credential-slot state. Before D1 exists it is the signed receipt chain on the
client repository's provisioning-state branch.

**Provisioning receipt** — One append-only, hash-linked, client-signed entry in
that chain. A resumed operation verifies the whole chain from its root; a broken
link, deleted entry or unexpected signer blocks the chain.

**Credential slot** — The durable record that one credential exists, who owns
it, its least authority, how it is rotated and whether its health check passed.
The value is never part of the record.

## Linked domain documents

- [Blog and newsletter publishing lifecycle](docs/domain/blog-newsletter-publishing-lifecycle.md)
- [Draft, preview and publish pipeline](docs/decisions/ADR-0004-draft-preview-publish-pipeline.md)
- [One SEO and sharing field set](docs/decisions/ADR-0008-seo-metadata-shared-field-set.md)
- [Default newsletter-delivery adapter](docs/decisions/ADR-0002-default-newsletter-delivery-adapter.md)
- [Bulk campaign execution boundary](docs/decisions/ADR-0006-bulk-campaign-execution-boundary.md)
- [Guided per-client provisioning and operator CLI](docs/architecture/guided-client-provisioning.md)
- [Privacy-first aggregate analytics](docs/architecture/privacy-first-aggregate-analytics.md)

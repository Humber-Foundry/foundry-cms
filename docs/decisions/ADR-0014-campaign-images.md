# ADR-0014: Campaign images — header, share and inline images, made absolute and served

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

[Issue #112](https://github.com/Humber-Foundry/foundry-cms/issues/112) asks for
proper image support on an email campaign, mirroring the blog work in
[#111](https://github.com/Humber-Foundry/foundry-cms/issues/111) and
[ADR-0013](ADR-0013-blog-post-images.md). A real campaign needs a picture in
more than one place, and the owner must control each one:

1. A **header image** at the top of the email.
2. A **share / thumbnail image** used where the campaign is previewed or shared.
3. **Inline images** placed inside the email body where the writing needs them.

Each must be chosen through the shared "Choose or upload a photo" picker
([#109](https://github.com/Humber-Foundry/foundry-cms/issues/109)), each must
render in the sent email and in the preview, and each must carry its own alt
text.

The same machinery #111 reused must be reused again: the shared `MediaPicker`,
the `ChangePhotoField` from
[#110](https://github.com/Humber-Foundry/foundry-cms/issues/110) and
[ADR-0012](ADR-0012-page-image-field-media-reference.md), and the rich-text
`image` block. But a campaign is not a page or a post, and two facts make it
different:

- **An email is read outside the site.** A blog post can hold a photo as its
  site path `/api/media/<assetId>` and let the renderer resolve it against the
  delivery mode. An inbox has no site to resolve a path against, so every image
  address in a sent email must be an absolute `https://` address. The campaign
  renderer already refused a path share image for this reason, and
  `campaignShareImageFromPost` already made a post's path absolute against the
  site's canonical origin.
- **A campaign is not part of the Site Definition.** A campaign is stored in its
  own D1 store, so the `siteDefinitionMediaAssetIds` chokepoint that decides
  which assets the public route may serve never sees a campaign's photos. Before
  this change, an inline image in a campaign body was left as a path that no
  mail client could load, which #111 recorded as out of its scope.

Before this change a campaign carried `subject`, `previewText`, a `shareImage`
that was rendered as the one picture at the top of the email body, a
`callToAction`, and the rich-text `emailContent`. The composer set the share
image by typing an address, not through the picker.

## Decision

**A campaign carries a header image, a share image and inline body images, each
chosen through the shared picker and each stored as an absolute `https://`
address. A gallery photo's `/api/media/<assetId>` reference is made absolute
against the site's canonical origin when the campaign is validated. A media
asset a campaign references is public, served by the same `/api/media/<assetId>`
route.**

### 1. The header image is a new field; the share image is the thumbnail

A campaign gains `headerImage: SeoShareImage | null` — the same address-and-alt
shape a page, a post and the share image use. The header image is the picture at
the top of the email body: the place the old share image was drawn. The composer
sets it with the same `ChangePhotoField` the page and blog editors use.

The existing `shareImage` becomes the campaign's thumbnail — the picture used
where the campaign is previewed or shared — and is no longer drawn inside the
email. It is set through the picker too, replacing the typed address. Because the
share image is not part of the sent message, it does not change the send
fingerprint; only the header and inline images, which are sent, do. This mirrors
ADR-0013: the header image is the campaign's `mainImage`, and the share image is
its `seo.shareImage`.

### 2. Inline images are the existing rich-text block

The email body is the same constrained rich-text document a post body is, and it
already allows the `image` block that #111 added. The campaign body editor now
offers the same "Add photo" button, so an inline image is chosen through the
shared picker and given its alt text once, exactly as in the blog editor.

### 3. Every campaign image address is made absolute at validation

`validateCampaignInput` resolves each image address against the site's canonical
origin:

- A `/api/media/<assetId>` reference — what the picker stores — is made absolute
  to `https://<origin>/api/media/<assetId>`.
- An absolute `https://` address is kept as written.
- Any other value, or a reference with no canonical origin to resolve it
  against, is refused, because it cannot be sent.

The header and share images are resolved as an address-and-alt pair; each inline
`image` block's `src` is resolved in place. Because the stored revision already
holds absolute addresses, the campaign renderer, the test-delivery path and the
bulk-delivery path are unchanged: they emit the stored address, and the send
fingerprint covers the header and inline images through the rendered bytes. A
campaign derived from a post carries the post's main image as its header image
and the post's share image as its share image, both made absolute the same way.

Storing the address absolute rather than as a path — unlike a page or post —
follows the campaign's existing rule and keeps the immutable, fingerprinted send
artifact origin-stable rather than resolving the origin at send time in three
delivery call sites.

### 4. A campaign-referenced asset is public

`siteDefinitionMediaAssetIds` cannot see a campaign, so the public route
`/api/media/[assetId]` now also serves an asset that any stored campaign
references — through its header image, its share image or an inline body image.
This is the same principle ADR-0012 established for a page image and ADR-0013 for
a blog photo: a photo the owner placed in content that is meant to be seen is
public. A campaign image is meant to be seen by every recipient, so it must load
from the public internet the moment the campaign references it, not only after a
send. The set is read from the same campaign store the authoring runtime uses,
without a human capability, because it exposes only which assets are referenced,
never any campaign content.

### Preview

The dashboard preview draws the header image and the inline body images. It
draws each gallery photo by its **same-origin** path, taken from the stored
absolute address, so the preview loads on whatever host the dashboard runs on —
`127.0.0.1` in local acceptance, the canonical origin in production — while the
sent email keeps the absolute address a mail client needs. An external picture
is drawn as written. Because a campaign-referenced asset is already public, the
preview needs no media capability of its own.

## Consequences

- The owner sets all three campaign photos the same way as every other photo in
  the product: one shared picker, no address typed. Alt text has its own box for
  the header and share images and a prompt for an inline image.
- The Site Definition schema is unchanged. A campaign is stored in its own D1
  store, so a new campaign field needs no schema version bump, projection or
  validator change. The campaign MCP tool schemas do change: `foundry.campaign.create`
  and `.edit` gain an optional `headerImage`, and `foundry.campaign.get` returns
  it, so the reviewed MCP tool-registry snapshot is regenerated.
- The security surface grows only by the assets the owner placed in their own
  campaign, matching ADR-0012. The public route reads the campaign store on a
  media miss; this is a small, bounded walk of the stored campaigns' current
  revisions.
- A campaign whose canonical origin is unset cannot store a gallery photo,
  because the address cannot be made absolute and an email needs one. This is the
  same limit ADR-0008 records for a path share image.
- The share image no longer appears in the sent email. A campaign that only set a
  share image before now shows no picture in the body until a header image is
  set; this is a pre-release change with no live campaign data.

## Alternatives rejected

- **Store the path and resolve the origin at send time.** Rejected: the campaign
  renderer, the test-delivery path and the bulk-delivery path all produce the
  immutable, fingerprinted send artifact from the stored revision. Threading the
  origin through all three, and through their fingerprints, is a larger and
  riskier change than resolving the address once at validation, and the campaign
  already stored share images absolute.
- **Keep a campaign image out of the served set and require the photo to also be
  placed on the site.** Rejected: it would make the owner place every campaign
  photo on a page or post first, which the shared-picker flow is meant to avoid,
  and a campaign photo is exactly as "meant to be seen" as a published page
  photo.
- **A separate thumbnail field beside the share image.** Rejected for the same
  reason ADR-0013 rejected it: a second field holding the same kind of value as
  the share image would drift from the surfaces that already read the share
  image. The header image is the new field; the share image stays the thumbnail.
- **Expose the campaign images only in the dashboard, not over MCP.** Rejected:
  the campaign create and edit tools already carry the share image, so the header
  image joins it symmetrically rather than leaving one image field dashboard-only.

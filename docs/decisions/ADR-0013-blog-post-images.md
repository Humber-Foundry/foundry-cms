# ADR-0013: Blog post images — main image, thumbnail and inline images

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

[Issue #111](https://github.com/Humber-Foundry/foundry-cms/issues/111) asks for
proper image support on a blog post. A real post needs a picture in more than
one place, and the owner must control each one:

1. A **main / header image** at the top of the post.
2. A **thumbnail / card image** shown in post lists and link previews, which may
   default to the main image.
3. **Inline images** placed inside the body where the writing needs them.

Each must be chosen through the shared "Choose or upload a photo" picker built
by [#109](https://github.com/Humber-Foundry/foundry-cms/issues/109), each must
render on the public post and in post lists and share previews, and each must
carry its own alt text.

Three pieces of machinery already exist and must be reused rather than rebuilt:

- The shared `MediaPicker` from #109.
- The page-editor "Change photo" pattern from
  [#110](https://github.com/Humber-Foundry/foundry-cms/issues/110) and
  [ADR-0012](ADR-0012-page-image-field-media-reference.md): a page-component
  image field holds a gallery photo as its public media path
  `/api/media/<assetId>`; `resolveMediaImageSrc` serves it through the
  authenticated route while a draft is previewed and the public route once
  published; `siteDefinitionMediaAssetIds` is the one set that decides which
  assets the site may serve.
- The SEO and sharing field set from
  [#113](https://github.com/Humber-Foundry/foundry-cms/issues/113) and
  [ADR-0008](ADR-0008-seo-metadata-shared-field-set.md): a post already carries
  `seo.shareImage`, an address and an alt text, and the blog index and the post
  link preview already read the resolved share image.

## Decision

**A blog post carries three photo controls, all reusing the ADR-0012 media
reference format `/api/media/<assetId>` and the shared picker. Site Definition
schema moves to 1.6.0.**

### 1. Main image is a new post field

A blog post gains `mainImage: SeoShareImage | null` — the same address-and-alt
shape the share image uses. The composer sets it with the same `ChangePhotoField`
the page editor uses. The public post and the exact preview draw it as a header
image above the title. A blank main image draws no header image.

### 2. The thumbnail is the SEO share image, not a fourth field

The "thumbnail / card image" is the post's existing `seo.shareImage`. There is
no separate thumbnail field, because a second field holding the same kind of
value would drift from the share image the link preview already uses. The
composer's share-image control becomes the same `ChangePhotoField`, so the owner
picks the thumbnail through the shared picker instead of typing an address.

The post's Open Graph image reads the fully resolved share image. Its
fallback chain gains the main image, so "the thumbnail may default to the main
image" is satisfied without duplication:

    post.seo.shareImage → post.mainImage → home.seo.shareImage → home hero

The blog index card reads the post's own thumbnail — its share image, or its
main image when no share image is set — and stops there. A post with neither
shows a text-only card rather than borrowing the site's picture, because a post
list where every image-less post showed the same site hero would mislead more
than it helps. So the card and the link preview share the post-level part of the
chain and diverge only in the site-level fallback the link preview still needs to
be an absolute address.

### 3. Inline images are a new rich-text block node

The body is a constrained CommonMark rich-text document. It gains one block node,
`image`, with `src` and `alt`. The picker stores the same `/api/media/<assetId>`
reference; `src` accepts any root-relative path or `https` address, and refuses a
plain `http` address so a published `https` post never loads mixed content. `alt`
is the owner's description and may be blank for a decorative picture, and it is
given once when the image is inserted. The body editor gains an "Add photo" button that opens the shared
`MediaPicker` and inserts an image node at the cursor. The renderer draws it as a
`<figure>` with an `<img>`. Its canonical Markdown form is the CommonMark image
`![alt](src)`, so the deterministic Markdown representation round-trips.

The rich-text contract version stays `1.0.0`. Adding a block node is backward
compatible: every document stored before this change is still valid, and no
document's stored bytes change, so the immutable post revisions already written
keep their fingerprints. There is no rich-text upgrade path to add, unlike the
Site Definition, whose `const` version gates the whole shape.

### Serving the photos

`siteDefinitionMediaAssetIds` now also walks every **published** blog post —
`targetVisibility === "public"` — collecting its `mainImage`, its
`seo.shareImage` and every inline image `src` that is a `/api/media/<assetId>`
reference. This is the one chokepoint ADR-0012 established:

- The public route `/api/media/[assetId]` serves an asset the published site
  references, so a published post's three kinds of photo are public.
- The authenticated preview and dashboard media grants cover the same set, so an
  exact draft preview fetches each photo at full resolution.

Only **public** posts contribute. An unpublished post is off the site, so its
photos are not made publicly serveable by its presence in the stored definition.

This widens ADR-0008's stance for one specific case. ADR-0008 kept a share image
"a URL, not an asset reference", and accepted that a share image pointing at an
otherwise-unplaced asset would 404. Now that the owner sets the blog thumbnail by
picking a gallery photo, that photo is a placed photo and must be served, exactly
as a page image field's photo is. The home page's `seo.shareImage` is unchanged
and still out of the served set; this decision covers blog posts only.

## Consequences

- The owner sets all three blog photos the same way as every other photo in the
  product: one shared picker, no address typed. Alt text has its own box for the
  main image and the thumbnail, and a prompt for an inline image.
- A published post's photos are public; the security surface grows only by the
  assets the owner placed on their own published post, matching ADR-0012.
- A post that is deliberately unpublished does not publish its photos. Previewing
  such a post can show a broken image, because the preview capability covers only
  the served set; a newly written post defaults to `public`, so the ordinary
  write-preview-publish flow is unaffected.
- The image node is valid in every rich-text document, including a call-to-action
  section body, because they share one schema. Only the blog body editor offers
  the button, so the node reaches content through the blog composer alone; the
  shared renderer draws it wherever it appears.
- Schema 1.6.0 needs the same version bump, projection step and regenerated
  validator every field change since 1.4.0 has needed. The projection fills
  `mainImage: null` on posts stored under an older schema, so an upgraded site
  renders exactly as before until an owner sets a main image.
- The main image is part of the blog post artifact, because
  `createBlogPostRenderModel` carries it, so changing it produces a new
  fingerprint and an approval cannot carry over to a picture the approver never
  saw.

## Alternatives rejected

- **A separate thumbnail field beside the share image.** Rejected: it would hold
  the same kind of value as `seo.shareImage` and drift from the link preview that
  already reads the share image. Making the thumbnail *be* the share image keeps
  one source of truth and satisfies #113's consistency note.
- **Inline images as a post-level list rather than a body node.** Rejected: the
  ticket asks for images placed "where the writing needs them", which a list
  beside the body cannot express. A body node places the picture in the flow.
- **Bumping the rich-text contract version for the new node.** Rejected: it would
  invalidate every stored document under the old `const` version and there is no
  rich-text projection to upgrade them. Adding a node is backward compatible, so
  the version holds at 1.0.0.
- **Making each blog image a media occurrence.** Rejected for the same reason
  ADR-0012 rejected it for page images: the occurrence id set is a closed enum
  with crop and revision machinery a simple image reference does not need.

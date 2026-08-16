# ADR-0012: Page-component image fields reference gallery photos

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

When editing a page, an image on the canvas was edited through a raw address
field. Selecting a photo section showed the image's file path as text to type.
The owner does not know what that path means and cannot pick one of their own
photos with it.

Issue [#109](https://github.com/Humber-Foundry/foundry-cms/issues/109) built the
shared "Choose or upload a photo" picker and the gallery it reads. That work
deliberately left the page editor for a follow-up and gave the picker no durable
full-resolution address: the picker hands its caller a photo's `assetId` and a
short-lived thumbnail, and expects the caller to place the photo by its id.

[Issue #110](https://github.com/Humber-Foundry/foundry-cms/issues/110) is that
follow-up: clicking a photo in the page editor must offer **Change photo**, open
the shared picker, and swap the image in place through the normal draft, preview
and publish flow.

Before this decision the product had two separate ways a photo reached the home
page:

1. **Media occurrences** (`definition.home.media`) — a fixed pair of placements,
   `occurrence_home_hero` and `occurrence_home_detail`, set only in the Photos
   manager. They render through `/api/media/<assetId>` on the published site and
   through the authenticated media route in an exact preview. The public route
   served an asset only when a published occurrence referenced it.
2. **Page-component image fields** (`imageSrc` on `imageCopyStory`, `photoBand`,
   the attention story) — a plain URL string pointing at a bundled file, drawn
   as `<img src>` with no gallery connection.

A page-component image field could not show a gallery photo, because nothing
served an arbitrary library asset for it and the preview capability covered only
occurrence assets. Making every page image an occurrence was rejected: the
occurrence id set is a closed enum fixed in the JSON schema, the application and
the renderers, and occurrences carry crop and revision machinery a simple image
field does not need.

## Decision

**A page-component image field may hold a reference to a gallery media asset,
stored as that asset's public media path `/api/media/<assetId>`. The photo the
published Site Definition references is served exactly as a placed occurrence's
photo is; the same reference resolves through the authenticated media route
while a draft is edited or previewed.**

### Storing the reference

- The page editor's image field is no longer a raw address input. It shows one
  **Change photo** action, which opens the shared `MediaPicker` from #109, above
  a preview of the current photo. The preview draws a bundled image directly and
  a photo just chosen from its short-lived picker thumbnail. A gallery photo
  carried over from an earlier session shows a clear "a gallery photo is set"
  note instead, because the editor holds no media capability to fetch that
  photo, and the field must not reintroduce the address it replaced. The photo
  itself is confirmed in the exact preview and on the published page.
- Choosing a gallery photo, or uploading and choosing a new one, stores
  `/api/media/<assetId>` in the field. This value already passes the existing
  safe-image validation, which accepts a site-absolute path.
- The swap is an ordinary page-composition edit. It advances the draft revision,
  previews and publishes with every other change. There is no separate media
  mutation path for a page image.

### Serving the reference

- A media asset the **published** Site Definition references — through a media
  occurrence or a page-component image field — is public. The public route
  `/api/media/[assetId]` serves an asset when
  `siteDefinitionMediaAssetIds(published)` contains it. This generalizes the
  earlier rule ("a published occurrence's asset is public") to the same
  principle for image fields: a photo the owner placed on the published page is
  meant to be seen.
- While editing or previewing a draft, the same reference resolves to the
  authenticated route `/api/foundry-cms/media?assetId=…&accessToken=…`. The
  renderer switches on the delivery mode already threaded through
  `SiteRenderer` for occurrences. The preview's media-access capability, and the
  dashboard's media-access grant, now cover every asset the draft references —
  occurrences and image fields alike — so an authenticated preview can fetch
  each one at full resolution.
- A static bundled path or an external `https://` URL is drawn unchanged. Only a
  value matching `/api/media/<assetId>` is treated as a gallery reference.

### What is unchanged

- The occurrence system, its two placements, its crop machinery and its schema
  are untouched. This decision adds a second, lighter way to place a photo; it
  does not replace the first.
- The thumbnail variant, the library capability and the per-asset access
  capability from ADR-0011 are unchanged. This decision only widens the set of
  assets the per-asset capability and the public route recognize, using the same
  tokens and routes.
- The public route still refuses any asset the published site does not
  reference, and the authenticated route still refuses any asset the caller's
  capability does not name. No new capability type is introduced.

## Consequences

- The owner picks a page photo the same way everywhere: one shared picker,
  reached by clicking the image. No address is typed.
- The security surface grows only by the assets the owner themself placed on
  their own site. A page image reference cannot unlock a photo the site does not
  reference, cannot reach another site, and cannot change what a visitor sees,
  because the published render is always produced from the referenced source.
- The set of publicly serveable assets is now computed from the whole published
  home definition, not just its occurrence list. It is a small, deterministic
  walk of the definition for `/api/media/<assetId>` references.
- The editor canvas draws page images with published delivery, as it already
  does for occurrences, so a just-chosen draft photo shows in the canvas only
  once published. The picker's own preview shows the chosen photo immediately,
  and the authenticated preview shows it in the exact draft. This matches the
  existing occurrence behavior on the canvas and is not made worse here.
- The image field's own preview cannot draw a gallery photo carried over from an
  earlier session, because the editor is not issued a media capability. The field
  states plainly that a photo is set rather than falling back to its address, and
  the exact preview and published page show the photo. A standing library
  capability for the editor would let the field draw every stored photo; it is a
  later change, because it widens what the page load mints.

## Alternatives rejected

- **Make every page image a media occurrence.** Rejected: the occurrence id set
  is a closed enum fixed across the JSON schema, the application and the
  renderers, and occurrences carry crop and revision machinery a plain image
  field does not need. Widening that enum for every image slot is a large,
  cross-cutting schema change to solve a placement problem the image field
  already models.
- **Give the picker a durable full-resolution address.** Rejected in ADR-0011
  and still rejected: a per-asset capability names the exact assets it covers
  and is issued for the photos already on the page, so a durable address for an
  unplaced photo would either be refused or force the capability to name the
  whole library. The caller places the photo by its `assetId`, and the placement
  is what makes it serveable.
- **A separate save path for a page image swap.** Rejected: issue #110 requires
  the change to ride the normal draft, preview and publish flow. Storing the
  reference in the field makes the swap an ordinary content edit.

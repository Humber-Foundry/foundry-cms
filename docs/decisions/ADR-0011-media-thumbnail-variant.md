# ADR-0011: Browser-made media thumbnail variant

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The owner dashboard shows the media library as a grid of tiles. Before this
decision the media route served the stored original for every tile, so opening
the Photos page downloaded the whole library at full resolution. A library of
twenty 3 MB photos cost 60 MB to show forty thumbnails. The Photos page and the
photo picker both need the grid, so the cost appears on every page that
shows photos.

A thumbnail is a resized copy. Foundry runs on Cloudflare Workers, which have no
canvas and no image codec. Making the copy on the server therefore needs one
of:

1. **A WebAssembly image codec in the Worker.** It decodes and re-encodes JPEG,
   PNG and WebP. It adds a large dependency to a repository that has none for
   images, it costs Worker CPU on every upload, and it must be kept current for
   its own decoder security fixes.
2. **Cloudflare Images transformations** through `fetch(url, { cf: { image } })`.
   It is a paid, zone-level product. An installation on the default free tier
   cannot use it, and no test can exercise it.
3. **The browser makes the copy before the upload.** Every browser that can show
   the dashboard already has a canvas and an image encoder.

This decision resolves
[issue #109](https://github.com/Humber-Foundry/foundry-cms/issues/109).

## Decision

**The browser draws the thumbnail and uploads it with the photo. The media
library stores it as a derived object beside the immutable source.**

### Making the copy

- Before the upload request, the dashboard draws the chosen file onto a canvas
  at thumbnail size and encodes it. The longest edge is `mediaThumbnailMaxEdge`
  (480 px). A photo already inside that limit is not enlarged.
- The upload carries the copy as a second multipart part named `thumbnail`.
- A browser that cannot produce a copy uploads the photo alone. This is not an
  error.

### Trusting the copy

The browser is an authenticated Owner or Editor, which is not the same as
trusted input. The media route therefore never believes what the browser
claimed about the copy:

- The route reads the copy's content type and pixel size from its own bytes
  with `inspectImageSource`, the same validator the source uses.
- The library refuses a copy that is not JPEG, PNG or WebP, is over
  `mediaThumbnailMaxByteLength` (512 KiB), is larger than 480 px on either
  edge, or is larger than the source it stands in for.
- A refused copy fails the whole upload, so a stored asset never has a copy the
  library would not serve.

These checks prove the copy is a small image of a permitted type. They do not
prove it is a picture of the source. Nothing on the server can prove that
without decoding both images, which is the capability this decision does not
have. The consequence is bounded: an Owner or Editor could make one of their
own site's tiles show the wrong picture of their own choosing. It cannot
mislead about another site, and it cannot change what a visitor sees, because
a rendered artifact is always produced from the source.

### Storing the copy

- The copy is stored in the same private R2 bucket at
  `media/<siteId>/<assetId>/thumbnail`, beside the source object at
  `media/<siteId>/<assetId>/source`.
- Its R2 `customMetadata` carries `variantOf`, the source hash of the asset it
  was made from. A read that does not find that exact hash reports no
  thumbnail, so a copy can never be served for a source it does not belong to.
- No D1 column, table or migration is added. The object key is derived from the
  asset identity, and the binding to the source is the object's own metadata.
- Deleting an asset deletes both objects.
- The copy is written only when the source object is first created, so a later
  upload can never swap the small copy that stands in for an existing source.

### Serving the copy

- `GET /api/foundry-cms/media?assetId=…&variant=thumbnail` serves the copy. It
  is `private, no-store`, like the source.
- A thumbnail is unlocked by a **library capability**, not by the per-asset
  media-access capability.

  A media-access capability lists the exact assets it covers, and that list is
  carried inside the token. The token then travels in an image URL, so the
  list is deliberately limited to the photos placed on the page. The gallery
  shows every photo in the library, so a capability built that way would
  either refuse a tile for every photo the owner has not yet used, or grow a
  500-photo list into an unusable URL.

  The library capability therefore names no asset. It is bound to one human
  identity, expires on the same short clock, and carries its own audience
  (`…:media-library`), so it cannot unlock a full-resolution source and a
  media-access capability cannot unlock a thumbnail.

  It grants no authority the holder lacks. The request that presents it is
  already authenticated and authorized as an active member of the site, the
  media application it reads through is scoped to that one site, and the same
  member already receives every asset's metadata in the access grant. What it
  unlocks is a copy no larger than `mediaThumbnailMaxEdge`. The
  full-resolution source keeps the strict per-asset capability.
- An asset with no stored copy answers `404`. The thumbnail path never falls
  back to the source, because the library capability names no asset and must
  not be a way to read full-resolution originals. The gallery shows that
  tile's frame empty, with its file name, size and badge intact.
- The public route `/api/media/[assetId]` is unchanged. It serves photos placed
  on the published site at full resolution, which is what a visitor needs.

## Consequences

- The Photos page and the photo picker load a small file per tile instead of a
  full-resolution original. No new dependency, no paid product, and no Worker
  CPU is spent on image encoding.
- The library holds two objects per asset. A thumbnail is at most 512 KiB, so
  the added storage is small next to a 20 MiB source limit.
- The exact bytes of a thumbnail depend on the browser that made it. That is
  acceptable because a thumbnail is presentation data: the source is immutable,
  every rendered artifact is produced from the source, and no fingerprint,
  approval or publication covers a thumbnail.
- Assets uploaded before this decision have no copy, so their tiles show an
  empty frame. Uploading the photo again creates a new asset, which does get a
  copy. Backfilling the old ones in place needs a separate decision, because
  the server still cannot resize.
- A browser that cannot draw the copy uploads the photo alone, and that photo
  has no copy for as long as it exists.
- A future server-side resizer can replace how the copy is made without
  changing where it is stored or how it is served, because the route, the
  object key and the `variantOf` binding do not name the browser.

## Alternatives rejected

- **A WebAssembly codec in the Worker.** Rejected for this issue: it adds a
  large image-decoding dependency and per-upload CPU cost to solve a
  presentation problem. It stays available later behind the same storage and
  route contract.
- **Cloudflare Images transformations.** Rejected as a default: a free-tier
  installation cannot use it, so the dashboard would still serve originals on
  the installations that most need the saving.
- **Recording thumbnail metadata in D1.** Rejected: it needs a migration on
  every installation to hold facts that the object key and the object's own
  metadata already carry.

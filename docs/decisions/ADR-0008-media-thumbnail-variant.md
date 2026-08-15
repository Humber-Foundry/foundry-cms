# ADR-0008: Browser-made media thumbnail variant

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The owner dashboard shows the media library as a grid of tiles. Before this
decision the media route served the stored original for every tile, so opening
the Photos page downloaded the whole library at full resolution. A library of
twenty 3 MB photos cost 60 MB to show forty thumbnails. The Photos page and the
photo picker both need the grid, so the cost appears on every photo surface.

A thumbnail is a resized copy. Foundry runs on Cloudflare Workers, which have no
canvas and no image codec. Making the copy on the server therefore needs one of:

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
  needs the same media capability as the source, and it is still
  `private, no-store`.
- An asset stored before this decision has no copy. The route then serves the
  source and says so in `x-foundry-media-variant: source`, rather than
  returning a broken image.
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
- Assets uploaded before this decision keep costing a full download until they
  are uploaded again. Backfilling them needs a separate decision, because the
  server still cannot resize.
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

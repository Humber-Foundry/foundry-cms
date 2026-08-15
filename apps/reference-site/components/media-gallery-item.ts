import type { MediaOccurrenceState } from "./media-manager-state";

/**
 * The plain values one photo tile in the gallery shows, and the media-route
 * addresses it loads. Kept apart from the components so the wording and the
 * arithmetic can be tested without a browser.
 */

const kilobyte = 1024;
const megabyte = 1024 * 1024;

/** The file size of a photo, in the owner's words. */
export function photoSizeLabel(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return "Size unknown";
  if (byteLength < kilobyte) {
    return byteLength === 1 ? "1 byte" : `${Math.round(byteLength)} bytes`;
  }
  if (byteLength < megabyte) {
    return `${Math.round(byteLength / kilobyte)} KB`;
  }
  return `${(byteLength / megabyte).toFixed(1)} MB`;
}

/**
 * The names of the places on the page that show this photo, in order and
 * without repeats.
 */
export function photoUsageNames(
  occurrences: ReadonlyArray<MediaOccurrenceState>,
  assetId: string,
  placeName: (occurrenceId: string) => string,
): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const occurrence of occurrences) {
    if (occurrence.assetId === assetId) names.add(placeName(occurrence.occurrenceId));
  }
  return [...names].sort();
}

function mediaUrl(
  assetId: string,
  accessToken: string,
  variant?: "thumbnail",
): string {
  const query = new URLSearchParams({ assetId, accessToken });
  if (variant !== undefined) query.set("variant", variant);
  return `/api/foundry-cms/media?${query.toString()}`;
}

/** The small copy of a photo, for a gallery tile. */
export function mediaThumbnailUrl(assetId: string, accessToken: string): string {
  return mediaUrl(assetId, accessToken, "thumbnail");
}

/** The full-resolution photo, for a place on the page. */
export function mediaSourceUrl(assetId: string, accessToken: string): string {
  return mediaUrl(assetId, accessToken);
}

/**
 * The height a photo of this size gets in a tile of `tileWidth`, so the
 * browser reserves the right space before the image arrives. A very tall
 * photo is capped at a square tile.
 */
export function photoTileHeight(
  width: number,
  height: number,
  tileWidth: number,
): number {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return tileWidth;
  }
  return Math.min(tileWidth, Math.round((height / width) * tileWidth));
}

/**
 * The photo one surface hands back to another: the asset identity, plus the
 * addresses that render it. A caller shows `thumbnailUrl` in its own
 * controls and uses `sourceUrl` where the full photo belongs.
 */
export type ChosenPhoto = Readonly<{
  assetId: string;
  fileName: string;
  width: number;
  height: number;
  contentType: string;
  thumbnailUrl: string;
  sourceUrl: string;
}>;

export function chosenPhoto(
  asset: Readonly<{
    assetId: string;
    fileName: string;
    width: number;
    height: number;
    contentType: string;
  }>,
  accessToken: string,
): ChosenPhoto {
  return {
    assetId: asset.assetId,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    contentType: asset.contentType,
    thumbnailUrl: mediaThumbnailUrl(asset.assetId, accessToken),
    sourceUrl: mediaSourceUrl(asset.assetId, accessToken),
  };
}

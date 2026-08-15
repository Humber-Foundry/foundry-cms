import type { MediaOccurrenceState } from "./media-manager-state";

/**
 * The values one photo tile shows, and the media-route addresses it loads.
 * These sit apart from the components so they can be tested without a
 * browser.
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

/**
 * The small copy of a photo, for a gallery tile. It is unlocked by the
 * library capability, which names no asset, because the gallery shows every
 * photo in the library.
 */
export function mediaThumbnailUrl(
  assetId: string,
  libraryToken: string,
): string {
  const query = new URLSearchParams({
    assetId,
    libraryToken,
    variant: "thumbnail",
  });
  return `/api/foundry-cms/media?${query.toString()}`;
}

/**
 * The photo the picker hands back to its caller: the asset identity, its size
 * and type, and the address of a rendered thumbnail the caller can show in
 * its own controls.
 *
 * There is no full-resolution address here. A capability for the source
 * names the exact assets it covers and is issued for the photos already
 * placed on the page, so an address for a photo the caller has not placed
 * yet would be refused. A caller places the photo by its `assetId`, and the
 * placement then renders it.
 */
export type ChosenPhoto = Readonly<{
  assetId: string;
  fileName: string;
  width: number;
  height: number;
  contentType: string;
  thumbnailUrl: string;
}>;

export function chosenPhoto(
  asset: Readonly<{
    assetId: string;
    fileName: string;
    width: number;
    height: number;
    contentType: string;
  }>,
  libraryToken: string,
): ChosenPhoto {
  return {
    assetId: asset.assetId,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    contentType: asset.contentType,
    thumbnailUrl: mediaThumbnailUrl(asset.assetId, libraryToken),
  };
}

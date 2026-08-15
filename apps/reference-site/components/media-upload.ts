import { createThumbnailFile } from "../src/media-thumbnail";
import type { MediaUploadAttempt } from "./media-upload-attempt";

/**
 * How a photo surface turns a chosen file into one upload request. The
 * Photos page and the photo picker both build the request here, so an
 * upload carries the same parts wherever it starts.
 */

/** The photo files the media library accepts. */
export const acceptedPhotoTypes = ["image/jpeg", "image/png", "image/webp"];

export function isAcceptedPhoto(file: File): boolean {
  return acceptedPhotoTypes.includes(file.type);
}

/**
 * Builds one upload request for `file`, including the small copy the gallery
 * shows. A browser that cannot make the small copy still uploads the photo;
 * the media route then serves the original until a later upload supplies one.
 *
 * The identifiers are minted once and kept with the request, so a retry
 * sends the same upload rather than a second photo.
 */
export async function createMediaUploadAttempt(
  file: File,
): Promise<MediaUploadAttempt> {
  const assetId = `asset_${crypto.randomUUID().replaceAll("-", "")}`;
  const body = new FormData();
  body.set("assetId", assetId);
  body.set("source", file);
  const thumbnail = await createThumbnailFile(file);
  if (thumbnail !== null) body.set("thumbnail", thumbnail);
  return { assetId, idempotencyKey: crypto.randomUUID(), body };
}

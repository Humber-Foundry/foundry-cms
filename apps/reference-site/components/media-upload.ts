import { mediaContentTypes } from "@humber-foundry/application";

import { createThumbnailFile } from "../src/media-thumbnail";
import type { MediaUploadAttempt } from "./media-upload-attempt";

/**
 * How a chosen file becomes one upload request. The Photos page and the photo
 * picker both build the request here, so an upload carries the same parts
 * wherever it starts.
 */

/** The photo files the media library accepts. */
export const acceptedPhotoTypes: ReadonlyArray<string> = mediaContentTypes;

export function isAcceptedPhoto(file: File): boolean {
  return acceptedPhotoTypes.includes(file.type);
}

/**
 * Builds one upload request for `file`, including the small copy the gallery
 * shows. A browser that cannot make the small copy still uploads the photo.
 * That photo then has no small copy for as long as it exists: the copy is
 * stored only when the source object is first created, and uploading the
 * same photo again returns the asset that is already there. Its tile falls
 * back to the full-resolution original.
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

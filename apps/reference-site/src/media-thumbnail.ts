import {
  mediaContentTypes,
  mediaThumbnailMaxEdge,
} from "@humber-foundry/application";

/**
 * Makes the small copy of a photo that the dashboard gallery shows.
 *
 * The browser does the resizing before the upload request, so the media route
 * can serve a small file instead of the full-resolution original. The original
 * is still uploaded and stored unchanged.
 */

/** The longest edge, in pixels, a thumbnail may have. */
export const thumbnailMaxEdge = mediaThumbnailMaxEdge;

/** The image types the media library stores. */
export const acceptedThumbnailTypes: ReadonlySet<string> = new Set(
  mediaContentTypes,
);

/**
 * The size of the thumbnail for a photo of this size: the same aspect ratio,
 * with the longest edge at `maxEdge`. A photo already inside the limit keeps
 * its own size, because enlarging it would cost bytes and add no detail.
 */
export function thumbnailDimensions(
  width: number,
  height: number,
  maxEdge: number = thumbnailMaxEdge,
): Readonly<{ width: number; height: number }> {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    throw new TypeError("invalid_image_size");
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.min(maxEdge, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxEdge, Math.round(height * scale))),
  };
}

/**
 * Draws `file` at thumbnail size and returns the result as a file, or null
 * when this browser cannot produce one. A null result is not an error: the
 * upload still carries the original, and the gallery falls back to it.
 */
export async function createThumbnailFile(
  file: File,
  maxEdge: number = thumbnailMaxEdge,
): Promise<File | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const size = thumbnailDimensions(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", 0.82);
    });
    // A browser that cannot encode the requested type falls back to PNG on
    // its own. Serve whatever it produced only if the library stores it.
    if (blob === null || !acceptedThumbnailTypes.has(blob.type)) return null;
    if (blob.size <= 0) return null;
    return new File([blob], "thumbnail", { type: blob.type });
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

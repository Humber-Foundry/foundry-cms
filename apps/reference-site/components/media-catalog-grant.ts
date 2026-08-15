import type { MediaAsset } from "@humber-foundry/application";

import type { MediaOccurrenceState } from "./media-manager-state";

/**
 * The access request every photo page makes, and how its answer is read.
 * The media route grants short-lived capabilities along with the catalog,
 * so a page that shows photos asks for both in one request.
 */

export type MediaCatalogGrant = Readonly<{
  assets: ReadonlyArray<MediaAsset>;
  occurrences: ReadonlyArray<MediaOccurrenceState>;
  /** Unlocks the full-resolution photos placed on the page. */
  accessToken: string;
  /** Seconds since the epoch, as the media route reports it. */
  accessTokenExpiresAt: number;
  /** Unlocks a thumbnail of any photo in the library. */
  libraryToken: string;
  libraryTokenExpiresAt: number;
}>;

export function mediaAccessRequestBody(workspaceId: string): string {
  return JSON.stringify({ operation: "access", workspaceId });
}

/**
 * Reads a granted catalog, or throws. A partial answer is refused rather
 * than shown, because a page with a token and no photos looks the same as
 * an empty library.
 */
export function parseMediaCatalogGrant(body: unknown): MediaCatalogGrant {
  if (
    typeof body !== "object" ||
    body === null ||
    !("assets" in body) ||
    !Array.isArray(body.assets) ||
    !("occurrences" in body) ||
    !Array.isArray(body.occurrences) ||
    !("accessToken" in body) ||
    typeof body.accessToken !== "string" ||
    !("accessTokenExpiresAt" in body) ||
    typeof body.accessTokenExpiresAt !== "number" ||
    !("libraryToken" in body) ||
    typeof body.libraryToken !== "string" ||
    !("libraryTokenExpiresAt" in body) ||
    typeof body.libraryTokenExpiresAt !== "number"
  ) {
    throw new Error("media_access_grant_failed");
  }
  return {
    assets: body.assets as ReadonlyArray<MediaAsset>,
    occurrences: body.occurrences as ReadonlyArray<MediaOccurrenceState>,
    accessToken: body.accessToken,
    accessTokenExpiresAt: body.accessTokenExpiresAt,
    libraryToken: body.libraryToken,
    libraryTokenExpiresAt: body.libraryTokenExpiresAt,
  };
}

/**
 * How long to wait before asking for a fresh capability. The renewal lands
 * half a minute early so an in-flight image request cannot outlive its token.
 */
export function mediaAccessRefreshDelayMs(
  accessTokenExpiresAt: number,
  now: number,
): number {
  return Math.max(1_000, accessTokenExpiresAt * 1_000 - now - 30_000);
}

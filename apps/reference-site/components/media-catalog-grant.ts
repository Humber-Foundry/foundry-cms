import type { MediaAsset } from "@humber-foundry/application";

import type { MediaOccurrenceState } from "./media-manager-state";

/**
 * The access request every photo surface makes, and the reading of its
 * answer. The media route grants a short-lived capability along with the
 * catalog, so a surface that shows photos always asks for both together.
 */

export type MediaCatalogGrant = Readonly<{
  assets: ReadonlyArray<MediaAsset>;
  occurrences: ReadonlyArray<MediaOccurrenceState>;
  accessToken: string;
  /** Seconds since the epoch, as the media route reports it. */
  accessTokenExpiresAt: number;
}>;

export function mediaAccessRequestBody(workspaceId: string): string {
  return JSON.stringify({ operation: "access", workspaceId });
}

/**
 * Reads a granted catalog, or throws. A partial answer is refused rather
 * than shown, because a surface with a token and no photos looks the same as
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
    typeof body.accessTokenExpiresAt !== "number"
  ) {
    throw new Error("media_access_grant_failed");
  }
  return {
    assets: body.assets as ReadonlyArray<MediaAsset>,
    occurrences: body.occurrences as ReadonlyArray<MediaOccurrenceState>,
    accessToken: body.accessToken,
    accessTokenExpiresAt: body.accessTokenExpiresAt,
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

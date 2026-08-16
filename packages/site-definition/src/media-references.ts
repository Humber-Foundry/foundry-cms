import type { SiteDefinition } from "./index";
import { publishedMediaPath } from "./seo";

/**
 * A page-component image field holds either a static bundled path
 * (`/foundry-workshop.svg`), an external `https://` URL, or a reference to a
 * gallery media asset. A gallery reference is stored as that asset's public
 * media path, `/api/media/<assetId>`, so the same value serves the published
 * site directly and is recognised here everywhere the asset must be found.
 */
const publishedMediaPattern = /^\/api\/media\/([^/?#]+)$/u;

/** The asset id a published media path names, or null if it is not one. */
export function mediaAssetIdFromPublishedPath(src: string): string | null {
  const match = publishedMediaPattern.exec(src);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** The value an image field stores when the owner picks a gallery photo. */
export function mediaImageSrc(assetId: string): string {
  return publishedMediaPath(assetId);
}

function collectMediaAssetIds(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    const assetId = mediaAssetIdFromPublishedPath(value);
    if (assetId !== null) into.add(assetId);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaAssetIds(item, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectMediaAssetIds(item, into);
  }
}

/**
 * Every gallery media asset the site references: photos placed as media
 * occurrences and photos chosen for a page-component image field. It is the
 * set of assets the site is allowed to serve — the public route serves them
 * for the published site, and the authenticated preview capability covers them
 * for the draft.
 */
export function siteDefinitionMediaAssetIds(
  definition: SiteDefinition,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const occurrence of definition.home.media ?? []) {
    ids.add(occurrence.asset.assetId);
  }
  collectMediaAssetIds(definition.home.sections, ids);
  return ids;
}

export type MediaImageDelivery = "authenticated" | "published";

/**
 * The address a renderer draws for one image field value. A gallery asset
 * reference resolves to the authenticated media route while editing or
 * previewing a draft, and to the public route once published; a static path or
 * external URL is drawn unchanged.
 */
export function resolveMediaImageSrc(
  src: string,
  delivery: MediaImageDelivery,
  accessToken?: string,
): string {
  const assetId = mediaAssetIdFromPublishedPath(src);
  if (assetId === null) return src;
  if (delivery === "authenticated") {
    const query = new URLSearchParams({
      assetId,
      accessToken: accessToken ?? "",
    });
    return `/api/foundry-cms/media?${query.toString()}`;
  }
  return publishedMediaPath(assetId);
}

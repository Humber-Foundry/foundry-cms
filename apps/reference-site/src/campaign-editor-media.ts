import "server-only";

import type { SiteDefinition } from "@humber-foundry/site-definition";

import { siteStaticImageTiles } from "./site-used-photos";

/**
 * The photos a Newsletter writing box may offer.
 *
 * Only site photos an email can load are offered. A relative built-in address
 * such as "/logo.svg" cannot be sent in an email (ADR-0014 needs an absolute
 * address), so this lists uploads and absolute site photos, never a bare path
 * the owner could not send.
 *
 * Both the new email screen and one saved email's screen need the same list,
 * so they read it here rather than each writing the same filter.
 */
export function campaignEditorSiteImages(
  publishedDefinition: SiteDefinition,
  draftDefinition: SiteDefinition,
) {
  return siteStaticImageTiles(publishedDefinition, draftDefinition).filter(
    (image) => image.src.startsWith("https://"),
  );
}

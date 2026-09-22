import "server-only";

import type { ContentWorkspaceId } from "@humber-foundry/application";
import type { SiteDefinition } from "@humber-foundry/site-definition";

import { siteStaticImageTiles } from "./site-used-photos";

/**
 * What a Newsletter writing box needs to change a photo: the token its writes
 * carry, the workspace an upload belongs to, and the photos it may offer.
 *
 * Only site photos an email can load are offered. A relative built-in address
 * such as "/logo.svg" cannot be sent in an email (ADR-0014 needs an absolute
 * address), so the picker lists uploads and absolute site photos, never a bare
 * path the owner could not send.
 *
 * The new email screen and one saved email's screen both hold a writing box,
 * so they read this rather than each writing the same filter.
 */
export function campaignEditorMedia(input: {
  mutationToken: string;
  workspaceId: ContentWorkspaceId;
  publishedDefinition: SiteDefinition;
  draftDefinition: SiteDefinition;
}) {
  return {
    csrfToken: input.mutationToken,
    workspaceId: input.workspaceId,
    siteImages: siteStaticImageTiles(
      input.publishedDefinition,
      input.draftDefinition,
    ).filter((image) => image.src.startsWith("https://")),
  };
}

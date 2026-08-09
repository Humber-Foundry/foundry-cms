import "server-only";

import {
  createInMemoryPublishedSiteRepository,
  createPublishedSiteBundle,
  createSiteApplication,
} from "@humber-foundry/application";
import type { SiteDefinition } from "@humber-foundry/site-definition";

import { installedSiteDefinition } from "./site-definition";

/**
 * Server-only installation seam. Runtime modules take site identity and
 * published content from this object; client-owned private adapters can be
 * added here without exposing them through the browser-safe definition seam.
 */
export function createSiteInstallation(definition: SiteDefinition) {
  return Object.freeze({
    definition,
    siteId: definition.site.id,
    application: createSiteApplication({
      siteId: definition.site.id,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(definition),
      ]),
    }),
  });
}

export const installedSite = createSiteInstallation(
  installedSiteDefinition,
);

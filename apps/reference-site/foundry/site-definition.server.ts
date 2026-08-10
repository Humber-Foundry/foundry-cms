import "server-only";

import {
  createInMemoryPublishedSiteRepository,
  createPublishedSiteBundle,
  createSiteApplication,
} from "@humber-foundry/application";
import type { SiteDefinition } from "@humber-foundry/site-definition";
import {
  isSiteDefinitionWithPageComponents,
  type PageComponentRegistry,
} from "@humber-foundry/site-definition";

import { installedSiteDefinition } from "./site-definition";
import { installedPageComponentRegistry } from "./page-components";

/**
 * Server-only installation seam. Runtime modules take site identity and
 * published content from this object; client-owned private adapters can be
 * added here without exposing them through the browser-safe definition seam.
 */
export function createSiteInstallation(
  definition: SiteDefinition,
  pageComponents: PageComponentRegistry = installedPageComponentRegistry,
) {
  if (!isSiteDefinitionWithPageComponents(definition, pageComponents)) {
    throw new TypeError("installed_site_definition_invalid");
  }
  return Object.freeze({
    definition,
    pageComponents,
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
  installedPageComponentRegistry,
);

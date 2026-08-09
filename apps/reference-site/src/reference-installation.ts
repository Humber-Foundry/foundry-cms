import "server-only";

import {
  createInMemoryPublishedSiteRepository,
  createPublishedSiteBundle,
  createSiteApplication,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

export const referenceSiteApplication = createSiteApplication({
  siteId: referenceSiteDefinition.site.id,
  publishedSites: createInMemoryPublishedSiteRepository([
    createPublishedSiteBundle(referenceSiteDefinition),
  ]),
});

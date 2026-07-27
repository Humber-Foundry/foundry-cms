import "server-only";

import {
  createInMemoryPublishedSiteRepository,
  createSiteApplication,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

export const referenceSiteApplication = createSiteApplication({
  siteId: referenceSiteDefinition.site.id,
  publishedSites: createInMemoryPublishedSiteRepository([
    referenceSiteDefinition,
  ]),
});

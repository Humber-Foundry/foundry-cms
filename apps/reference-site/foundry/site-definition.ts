import {
  createReferenceSiteDefinition,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import publishedSite from "./published-site.json";

/**
 * Browser-safe installation seam.
 *
 * An adopted client repository replaces this value with its own schema-valid
 * Site Definition. Keep secrets, provider bindings, and server adapters out of
 * this module because its definition may be serialized into browser props.
 */
export const installedSiteDefinition: SiteDefinition =
  createReferenceSiteDefinition(publishedSite);

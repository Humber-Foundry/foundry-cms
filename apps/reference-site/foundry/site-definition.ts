import {
  createReferenceSiteDefinition,
  isSiteDefinitionWithPageComponents,
  upgradeSiteDefinition,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import publishedSite from "./published-site.json";
import { installedPageComponentRegistry } from "./page-components";

/**
 * Browser-safe installation seam.
 *
 * An adopted client repository replaces this value with its own schema-valid
 * Site Definition. Keep secrets, provider bindings, and server adapters out of
 * this module because its definition may be serialized into browser props.
 */
const installedCandidate = createReferenceSiteDefinition(publishedSite);
if (!isSiteDefinitionWithPageComponents(
  installedCandidate,
  installedPageComponentRegistry,
)) {
  throw new TypeError("installed_site_definition_invalid");
}

export const installedSiteDefinition: SiteDefinition = installedCandidate;

export function isInstalledSiteDefinition(value: unknown): value is SiteDefinition {
  return isSiteDefinitionWithPageComponents(value, installedPageComponentRegistry);
}

export function upgradeInstalledSiteDefinition(value: unknown): SiteDefinition {
  const upgraded = upgradeSiteDefinition(value);
  if (!isInstalledSiteDefinition(upgraded)) {
    throw new TypeError("installed_site_definition_invalid");
  }
  return upgraded;
}

import "server-only";

import {
  createContentRevisionApplication,
  createInMemoryContentRevisionStore,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1ContentRevisionStore } from "./d1-content-revision-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";

const localRuntime = globalThis as typeof globalThis & {
  __foundryContentRevisionStore?: ReturnType<
    typeof createInMemoryContentRevisionStore
  >;
};
localRuntime.__foundryContentRevisionStore ??=
  createInMemoryContentRevisionStore();

const productionBase =
  `bundled:${referenceSiteDefinition.site.id}` +
  `@definition:${referenceSiteDefinition.definitionVersion}`;

const localApplication = createContentRevisionApplication({
  siteDefinition: referenceSiteDefinition,
  store: localRuntime.__foundryContentRevisionStore,
  rendererVersion: "local-development-renderer",
  productionBase,
});

export async function loadContentRevisionApplication() {
  if (process.env.NODE_ENV === "development") {
    return localApplication;
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new Error("content_revision_database_not_configured");
  }
  return createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    store: createD1ContentRevisionStore(
      environment.FOUNDRY_DB,
      referenceSiteDefinition.site.id,
    ),
    rendererVersion:
      environment.CF_VERSION_METADATA?.id ??
      environment.FOUNDRY_RENDERER_VERSION ??
      "unversioned-renderer",
    productionBase,
  });
}

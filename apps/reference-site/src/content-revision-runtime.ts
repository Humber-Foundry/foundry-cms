import "server-only";

import {
  createContentRevisionApplication,
  ContentRevisionConfigurationError,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1ContentRevisionStore } from "./d1-content-revision-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";

const localRuntime = globalThis as typeof globalThis & {
  __foundryContentRevisionStore?: ReturnType<
    typeof createInMemoryContentRevisionStore
  >;
  __foundryLocalRendererVersion?: string;
};
localRuntime.__foundryContentRevisionStore ??=
  createInMemoryContentRevisionStore();
localRuntime.__foundryLocalRendererVersion ??=
  `local-runtime:${crypto.randomUUID()}`;

export const referenceContentWorkspaceId =
  createContentWorkspaceId("workspace_home");

export { ContentRevisionConfigurationError };

const productionBase = (contentHash: string) =>
  `bundled:${referenceSiteDefinition.site.id}@content:${contentHash}`;

const localApplication = createContentRevisionApplication({
  siteDefinition: referenceSiteDefinition,
  store: localRuntime.__foundryContentRevisionStore,
  workspaceId: referenceContentWorkspaceId,
  rendererVersion: localRuntime.__foundryLocalRendererVersion,
  productionBase,
});

export async function loadContentRevisionApplication() {
  if (process.env.NODE_ENV === "development") {
    return localApplication;
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  const rendererVersion =
    environment.CF_VERSION_METADATA?.id ??
    environment.FOUNDRY_RENDERER_VERSION;
  if (rendererVersion === undefined || rendererVersion.trim() === "") {
    throw new ContentRevisionConfigurationError();
  }
  return createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    store: createD1ContentRevisionStore(
      environment.FOUNDRY_DB,
      referenceSiteDefinition.site.id,
      referenceContentWorkspaceId,
    ),
    workspaceId: referenceContentWorkspaceId,
    rendererVersion,
    productionBase,
  });
}

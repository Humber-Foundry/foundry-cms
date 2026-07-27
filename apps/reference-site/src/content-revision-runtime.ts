import "server-only";

import {
  ContentRevisionConfigurationError,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
  type ContentWorkspaceId,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import { createD1ContentRevisionStore } from "./d1-content-revision-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";

type LocalContentRevisionStore = ReturnType<
  typeof createInMemoryContentRevisionStore
>;

const localRuntime = globalThis as typeof globalThis & {
  __foundryContentRevisionStores?: Map<string, LocalContentRevisionStore>;
  __foundryLocalRendererVersion?: string;
};
localRuntime.__foundryContentRevisionStores ??= new Map();
localRuntime.__foundryLocalRendererVersion ??=
  `local-runtime:${crypto.randomUUID()}`;

export { ContentRevisionConfigurationError };

export async function contentWorkspaceIdForActor(
  actorId: string,
): Promise<ContentWorkspaceId> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${referenceSiteDefinition.site.id}:${actorId}`,
    ),
  );
  const suffix = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
  return createContentWorkspaceId(`workspace_${suffix}`);
}

function applicationFor({
  workspaceId,
  store,
  rendererVersion,
  productionBaseCommit,
}: {
  workspaceId: ContentWorkspaceId;
  store: LocalContentRevisionStore;
  rendererVersion: string;
  productionBaseCommit: string;
}) {
  return createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    store,
    workspaceId,
    rendererVersion,
    productionBase: (contentHash) =>
      `${productionBaseCommit}@content:${contentHash}`,
  });
}

export async function loadContentRevisionApplication(
  workspaceId: ContentWorkspaceId,
) {
  if (process.env.NODE_ENV === "development") {
    let store =
      localRuntime.__foundryContentRevisionStores!.get(workspaceId);
    if (store === undefined) {
      store = createInMemoryContentRevisionStore();
      localRuntime.__foundryContentRevisionStores!.set(workspaceId, store);
    }
    return applicationFor({
      workspaceId,
      store,
      rendererVersion: localRuntime.__foundryLocalRendererVersion!,
      productionBaseCommit:
        `local-source:${localRuntime.__foundryLocalRendererVersion}`,
    });
  }

  const environment = await loadHumanAccessEnvironment();
  const rendererVersion =
    environment.CF_VERSION_METADATA?.id ??
    environment.FOUNDRY_RENDERER_VERSION;
  const productionBaseCommit = environment.FOUNDRY_PRODUCTION_BASE;
  if (
    environment.FOUNDRY_DB === undefined ||
    rendererVersion === undefined ||
    rendererVersion.trim() === "" ||
    productionBaseCommit === undefined ||
    !/^[a-f0-9]{40,64}$/u.test(productionBaseCommit)
  ) {
    throw new ContentRevisionConfigurationError();
  }
  return applicationFor({
    workspaceId,
    store: createD1ContentRevisionStore(
      environment.FOUNDRY_DB,
      referenceSiteDefinition.site.id,
      workspaceId,
    ),
    rendererVersion,
    productionBaseCommit: `git:${productionBaseCommit}`,
  });
}

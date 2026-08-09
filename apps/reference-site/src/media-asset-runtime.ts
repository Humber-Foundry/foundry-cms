import "server-only";

import {
  createInMemoryMediaContentCoordinator,
  createInMemoryMediaAssetStore,
  createInMemoryMediaSourceStore,
  createMediaAssetApplication,
  type ContentActorId,
  type InMemoryMediaContentCoordinator,
  type MediaAssetStore,
  type MediaSourceStore,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { createD1MediaAssetStore } from "./d1-media-asset-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import { createR2MediaSourceStore } from "./r2-media-source-store";

export class MediaAssetConfigurationError extends Error {
  constructor() {
    super("media_assets_not_configured");
    this.name = "MediaAssetConfigurationError";
  }
}

const localRuntime = globalThis as typeof globalThis & {
  __foundryMediaAssets?: MediaAssetStore;
  __foundryMediaSources?: MediaSourceStore;
  __foundryMediaContentCoordinator?: InMemoryMediaContentCoordinator;
};
localRuntime.__foundryMediaContentCoordinator ??=
  createInMemoryMediaContentCoordinator();
localRuntime.__foundryMediaAssets ??= createInMemoryMediaAssetStore({
  mediaContentCoordinator: localRuntime.__foundryMediaContentCoordinator,
});
localRuntime.__foundryMediaSources ??= createInMemoryMediaSourceStore();

export function localMediaAssetStore(): MediaAssetStore {
  return localRuntime.__foundryMediaAssets!;
}

export function localMediaContentCoordinator(): InMemoryMediaContentCoordinator {
  return localRuntime.__foundryMediaContentCoordinator!;
}

export async function loadMediaAssetApplication(actorId: ContentActorId) {
  if (process.env.NODE_ENV === "development") {
    return createMediaAssetApplication({
      siteId: referenceSiteDefinition.site.id,
      actorId,
      assets: localRuntime.__foundryMediaAssets!,
      sources: localRuntime.__foundryMediaSources!,
    });
  }
  const environment = await loadHumanAccessEnvironment();
  if (
    environment.FOUNDRY_DB === undefined ||
    environment.FOUNDRY_MEDIA === undefined
  ) {
    throw new MediaAssetConfigurationError();
  }
  return createMediaAssetApplication({
    siteId: referenceSiteDefinition.site.id,
    actorId,
    assets: createD1MediaAssetStore(environment.FOUNDRY_DB),
    sources: createR2MediaSourceStore(environment.FOUNDRY_MEDIA),
  });
}

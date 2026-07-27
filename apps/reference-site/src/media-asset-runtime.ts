import "server-only";

import {
  createInMemoryMediaAssetStore,
  createInMemoryMediaSourceStore,
  createMediaAssetApplication,
  type ContentActorId,
  type MediaAssetStore,
  type MediaSourceStore,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

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
};
localRuntime.__foundryMediaAssets ??= createInMemoryMediaAssetStore();
localRuntime.__foundryMediaSources ??= createInMemoryMediaSourceStore();

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

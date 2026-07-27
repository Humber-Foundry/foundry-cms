import "server-only";

import {
  createContentActorId,
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

const publicRendererActorId = createContentActorId(
  "integration-public-renderer",
);

export async function loadPublicMediaPresentation() {
  const application = await loadMediaAssetApplication(publicRendererActorId);
  const [assets, occurrences] = await Promise.all([
    application.queries.listAssets(),
    application.queries.listOccurrences(),
  ]);
  return { assets, occurrences };
}

export function loadPublicMediaAssetApplication() {
  return loadMediaAssetApplication(publicRendererActorId);
}

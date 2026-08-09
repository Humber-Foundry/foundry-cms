import "server-only";

import {
  ContentRevisionConfigurationError,
  ContentWorkspaceAccessError,
  type ContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
  createMediaOccurrenceId,
  type ContentWorkspaceId,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";
import type { SiteDefinition } from "@humber-foundry/site-definition";

import {
  createD1ContentRevisionStore,
  findLatestContentWorkspaceIdForActor,
  hydrateManagedBlogPosts,
} from "./d1-content-revision-store";
import {
  upgradeSiteDefinitionForCurrentSchema,
} from "./content-schema-recovery";
import {
  loadHumanAccessEnvironment,
  type HumanAccessEnvironment,
} from "./human-access-environment";
import {
  localMediaAssetStore,
  localMediaContentCoordinator,
} from "./media-asset-runtime";

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

export function isGitObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

export function gitContentProductionBase(
  commit: string,
  contentHash: string,
): string {
  if (!isGitObjectId(commit) || !/^[a-f0-9]{64}$/u.test(contentHash)) {
    throw new ContentRevisionConfigurationError();
  }
  return `git:${commit}@content:${contentHash}`;
}

export function resolveContentReleaseInputs(
  environment: HumanAccessEnvironment,
  embeddedReleaseCommit = process.env.FOUNDRY_RELEASE_COMMIT_SHA,
) {
  const releaseCommit =
    embeddedReleaseCommit !== undefined &&
    isGitObjectId(embeddedReleaseCommit)
      ? embeddedReleaseCommit
      : environment.FOUNDRY_PRODUCTION_BASE;
  const rendererVersion =
    releaseCommit ??
    environment.CF_VERSION_METADATA?.id ??
    environment.FOUNDRY_RENDERER_VERSION;
  if (
    releaseCommit === undefined ||
    !isGitObjectId(releaseCommit) ||
    rendererVersion === undefined ||
    rendererVersion.trim() === ""
  ) {
    throw new ContentRevisionConfigurationError();
  }
  return {
    productionBaseCommit: releaseCommit,
    rendererVersion,
  };
}

export async function contentWorkspaceIdForActor(
  actorId: ContentActorId,
): Promise<ContentWorkspaceId> {
  return contentWorkspaceIdFromSeed(actorId);
}

export async function contentWorkspaceIdForMutation(
  actorId: ContentActorId,
  idempotencyKey: string,
): Promise<ContentWorkspaceId> {
  return contentWorkspaceIdFromSeed(`${actorId}:${idempotencyKey}`);
}

export async function latestContentWorkspaceIdForActor(
  actorId: ContentActorId,
): Promise<ContentWorkspaceId | null> {
  if (process.env.NODE_ENV === "development") {
    let latest:
      | Readonly<{ workspaceId: ContentWorkspaceId; updatedAt: string }>
      | undefined;
    for (const [workspaceId, store] of localRuntime
      .__foundryContentRevisionStores!) {
      try {
        await store.requireAccess(actorId);
        const current = await store.getCurrent();
        if (
          latest === undefined ||
          current.createdAt > latest.updatedAt ||
          (current.createdAt === latest.updatedAt &&
            workspaceId > latest.workspaceId)
        ) {
          latest = {
            workspaceId: createContentWorkspaceId(workspaceId),
            updatedAt: current.createdAt,
          };
        }
      } catch (error) {
        if (!(error instanceof ContentWorkspaceAccessError)) {
          throw error;
        }
      }
    }
    return latest?.workspaceId ?? null;
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  return findLatestContentWorkspaceIdForActor(
    environment.FOUNDRY_DB,
    referenceSiteDefinition.site.id,
    actorId,
  );
}

async function contentWorkspaceIdFromSeed(
  seed: string,
): Promise<ContentWorkspaceId> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${referenceSiteDefinition.site.id}:${seed}`,
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
  actorId,
  store,
  rendererVersion,
  productionBaseCommit,
  initialDefinition,
  initialCreatedBy,
}: {
  workspaceId: ContentWorkspaceId;
  actorId: ContentActorId;
  store: LocalContentRevisionStore;
  rendererVersion: string;
  productionBaseCommit: string;
  initialDefinition?: SiteDefinition;
  initialCreatedBy?: ContentActorId;
}) {
  return createContentRevisionApplication({
    siteDefinition: referenceSiteDefinition,
    initialDefinition,
    initialCreatedBy,
    store,
    workspaceId,
    actorId,
    rendererVersion,
    productionBase: (contentHash) =>
      isGitObjectId(productionBaseCommit)
        ? gitContentProductionBase(productionBaseCommit, contentHash)
        : `${productionBaseCommit}@content:${contentHash}`,
  });
}

function cropsMatch(
  left:
    | Readonly<{ x: number; y: number; width: number; height: number }>
    | null,
  right:
    | Readonly<{ x: number; y: number; width: number; height: number }>
    | null,
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  );
}

export async function loadContentRevisionApplication(
  workspaceId: ContentWorkspaceId,
  actorId: ContentActorId,
  environmentOverride?: HumanAccessEnvironment,
) {
  if (
    process.env.NODE_ENV === "development" &&
    environmentOverride === undefined
  ) {
    let store =
      localRuntime.__foundryContentRevisionStores!.get(workspaceId);
    if (store === undefined) {
      const mediaAssets = localMediaAssetStore();
      store = createInMemoryContentRevisionStore({
        mediaContentCoordinator: localMediaContentCoordinator(),
        isMediaOccurrenceCurrent: async (expected) => {
          const current = await mediaAssets.getOccurrence(
            referenceSiteDefinition.site.id,
            workspaceId,
            createMediaOccurrenceId(expected.occurrenceId),
          );
          return (
            current !== null &&
            current.revision === expected.revision &&
            current.assetId === expected.assetId &&
            cropsMatch(current.crop, expected.crop)
          );
        },
      });
      localRuntime.__foundryContentRevisionStores!.set(workspaceId, store);
    }
    return applicationFor({
      workspaceId,
      actorId,
      store,
      rendererVersion: localRuntime.__foundryLocalRendererVersion!,
      productionBaseCommit:
        `local-source:${localRuntime.__foundryLocalRendererVersion}`,
    });
  }

  const environment =
    environmentOverride ?? await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  const { rendererVersion, productionBaseCommit } =
    resolveContentReleaseInputs(environment);
  const initialDefinition = await hydrateManagedBlogPosts(
    environment.FOUNDRY_DB,
    referenceSiteDefinition,
  );
  return applicationFor({
    workspaceId,
    actorId,
    store: createD1ContentRevisionStore(
      environment.FOUNDRY_DB,
      referenceSiteDefinition.site.id,
      workspaceId,
    ),
    rendererVersion,
    productionBaseCommit,
    initialDefinition,
  });
}

export async function loadRestoredContentRevisionApplication(
  workspaceId: ContentWorkspaceId,
  actorId: ContentActorId,
  definition: SiteDefinition,
  environmentOverride?: HumanAccessEnvironment,
) {
  let currentDefinition: SiteDefinition;
  try {
    currentDefinition =
      upgradeSiteDefinitionForCurrentSchema(definition);
  } catch {
    throw new ContentRevisionConfigurationError();
  }
  if (
    currentDefinition.site.id !== referenceSiteDefinition.site.id ||
    currentDefinition.schemaVersion !== referenceSiteDefinition.schemaVersion ||
    currentDefinition.definitionVersion !==
      referenceSiteDefinition.definitionVersion
  ) {
    throw new ContentRevisionConfigurationError();
  }
  if (
    process.env.NODE_ENV === "development" &&
    environmentOverride === undefined
  ) {
    let store =
      localRuntime.__foundryContentRevisionStores!.get(workspaceId);
    if (store === undefined) {
      store = createInMemoryContentRevisionStore();
      localRuntime.__foundryContentRevisionStores!.set(workspaceId, store);
    }
    return applicationFor({
      workspaceId,
      actorId,
      store,
      rendererVersion: localRuntime.__foundryLocalRendererVersion!,
      productionBaseCommit:
        `local-source:${localRuntime.__foundryLocalRendererVersion}`,
      initialDefinition: currentDefinition,
      initialCreatedBy: actorId,
    });
  }
  const environment =
    environmentOverride ?? await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  const { rendererVersion, productionBaseCommit } =
    resolveContentReleaseInputs(environment);
  return applicationFor({
    workspaceId,
    actorId,
    store: createD1ContentRevisionStore(
      environment.FOUNDRY_DB,
      referenceSiteDefinition.site.id,
      workspaceId,
    ),
    rendererVersion,
    productionBaseCommit,
    initialDefinition: currentDefinition,
    initialCreatedBy: actorId,
  });
}

export async function requireExistingContentWorkspaceAccess(
  workspaceId: ContentWorkspaceId,
  actorId: ContentActorId,
): Promise<void> {
  if (process.env.NODE_ENV === "development") {
    const store = localRuntime.__foundryContentRevisionStores!.get(workspaceId);
    if (store === undefined) {
      throw new ContentWorkspaceAccessError();
    }
    await store.requireAccess(actorId);
    return;
  }
  const environment = await loadHumanAccessEnvironment();
  if (environment.FOUNDRY_DB === undefined) {
    throw new ContentRevisionConfigurationError();
  }
  await createD1ContentRevisionStore(
    environment.FOUNDRY_DB,
    referenceSiteDefinition.site.id,
    workspaceId,
  ).requireAccess(actorId);
}

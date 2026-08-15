import type { SiteId } from "@humber-foundry/site-definition";

import type { ContentActorId, ContentWorkspaceId } from "./content-revisions";
import { sha256CanonicalJson } from "./deterministic-hash";

declare const mediaAssetIdBrand: unique symbol;
export type MediaAssetId = string & {
  readonly [mediaAssetIdBrand]: "MediaAssetId";
};

export function createMediaAssetId(value: string): MediaAssetId {
  if (!/^asset_[a-z0-9_]+$/u.test(value)) {
    throw new TypeError("media_asset_id_invalid");
  }
  return value as MediaAssetId;
}

declare const mediaOccurrenceIdBrand: unique symbol;
export type MediaOccurrenceId = string & {
  readonly [mediaOccurrenceIdBrand]: "MediaOccurrenceId";
};

export function createMediaOccurrenceId(value: string): MediaOccurrenceId {
  if (!/^occurrence_[a-z0-9_]+$/u.test(value)) {
    throw new TypeError("media_occurrence_id_invalid");
  }
  return value as MediaOccurrenceId;
}

export const renderedMediaOccurrenceIds = [
  "occurrence_home_hero",
  "occurrence_home_detail",
] as const satisfies ReadonlyArray<string>;
export type RenderedMediaOccurrenceId =
  (typeof renderedMediaOccurrenceIds)[number];

export function requireRenderedMediaOccurrenceId(
  value: MediaOccurrenceId,
): RenderedMediaOccurrenceId {
  if (!(renderedMediaOccurrenceIds as ReadonlyArray<string>).includes(value)) {
    throw new MediaValidationError("occurrenceId");
  }
  return value as RenderedMediaOccurrenceId;
}

export type MediaAsset = Readonly<{
  siteId: SiteId;
  assetId: MediaAssetId;
  objectKey: string;
  sourceHash: string;
  fileName: string;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  byteLength: number;
  width: number;
  height: number;
  createdAt: string;
  createdBy: ContentActorId;
}>;

/**
 * The longest edge, in pixels, a stored thumbnail may have. A gallery tile is
 * far smaller than this, so one thumbnail covers every dashboard grid size
 * and a retina screen.
 */
export const mediaThumbnailMaxEdge = 480;

/** The largest thumbnail the library accepts, in bytes. */
export const mediaThumbnailMaxByteLength = 512 * 1024;

/**
 * Where the thumbnail for one asset is stored. It sits beside the immutable
 * source object and is derived from the same site and asset identity, so no
 * extra record is needed to find it.
 */
export function mediaThumbnailObjectKey(
  asset: Readonly<{ siteId: SiteId; assetId: MediaAssetId }>,
): string {
  return `media/${asset.siteId}/${asset.assetId}/thumbnail`;
}

export type MediaCrop = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type MediaOccurrenceRevision = Readonly<{
  siteId: SiteId;
  workspaceId: ContentWorkspaceId;
  occurrenceId: MediaOccurrenceId;
  revision: number;
  assetId: MediaAssetId;
  crop: MediaCrop | null;
  createdAt: string;
  createdBy: ContentActorId;
}>;

export const mediaAuditActions = [
  "media.asset.uploaded",
  "media.occurrence.replaced",
  "media.occurrence.cropped",
  "media.asset.deleted",
  "media.access.granted",
] as const;
export type MediaAuditAction = (typeof mediaAuditActions)[number];

export type MediaAuditEvent = Readonly<{
  siteId: SiteId;
  workspaceId: ContentWorkspaceId | null;
  actorId: ContentActorId;
  action: MediaAuditAction;
  subjectId: string;
  occurredAt: string;
}>;

export type MediaMutationResult =
  | Readonly<{ kind: "asset"; value: MediaAsset }>
  | Readonly<{ kind: "occurrence"; value: MediaOccurrenceRevision }>
  | Readonly<{ kind: "deleted"; assetId: MediaAssetId }>;

export type MediaMutationContext = Readonly<{
  siteId: SiteId;
  idempotencyKey: string;
  requestHash: string;
  claimToken: string;
}>;

export class MediaAssetReferencedError extends Error {
  constructor(
    readonly assetId: MediaAssetId,
    readonly referenceCount: number,
  ) {
    super("media_asset_referenced");
    this.name = "MediaAssetReferencedError";
  }
}

export class MediaSiteAccessError extends Error {
  constructor() {
    super("media_site_access_denied");
    this.name = "MediaSiteAccessError";
  }
}

export class MediaOccurrenceConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("media_occurrence_conflict");
    this.name = "MediaOccurrenceConflictError";
  }
}

export class MediaMutationInProgressError extends Error {
  constructor() {
    super("media_mutation_in_progress");
    this.name = "MediaMutationInProgressError";
  }
}

export class MediaValidationError extends Error {
  constructor(readonly field: string) {
    super("media_validation_failed");
    this.name = "MediaValidationError";
  }
}

export type MediaSourceStore = Readonly<{
  put(
    objectKey: string,
    source: Uint8Array,
    metadata: Readonly<{ contentType: string; sourceHash: string }>,
  ): Promise<void>;
  get(
    objectKey: string,
    expected: Readonly<{ contentType: string; sourceHash: string }>,
  ): Promise<
    | Readonly<{
        body: Uint8Array | ReadableStream<Uint8Array>;
        contentType: string;
      }>
    | null
  >;
  /**
   * Stores a derived object, such as a thumbnail. `variantOf` is the source
   * hash of the asset this object was made from, so a reader can prove the
   * variant belongs to the source it is asked to stand in for.
   */
  putVariant(
    objectKey: string,
    variant: Uint8Array,
    metadata: Readonly<{
      contentType: string;
      variantHash: string;
      variantOf: string;
    }>,
  ): Promise<void>;
  /**
   * Reads a derived object. Returns null when the object is absent or was
   * made from a different source, so a caller can fall back to the source.
   */
  getVariant(
    objectKey: string,
    expected: Readonly<{ variantOf: string }>,
  ): Promise<
    | Readonly<{
        body: Uint8Array | ReadableStream<Uint8Array>;
        contentType: string;
      }>
    | null
  >;
  delete(objectKey: string): Promise<void>;
}>;

export type MediaAssetStore = Readonly<{
  claim(
    context: MediaMutationContext,
  ): Promise<boolean>;
  releaseClaim(context: MediaMutationContext): Promise<void>;
  renewClaim(context: MediaMutationContext): Promise<boolean>;
  replay(
    context: MediaMutationContext,
  ): Promise<MediaMutationResult | null>;
  record(
    context: MediaMutationContext,
    result: MediaMutationResult,
  ): Promise<void>;
  getAsset(siteId: SiteId, assetId: MediaAssetId): Promise<MediaAsset | null>;
  isAssetIdReserved(siteId: SiteId, assetId: MediaAssetId): Promise<boolean>;
  listAssets(siteId: SiteId): Promise<ReadonlyArray<MediaAsset>>;
  listOccurrences(
    siteId: SiteId,
    workspaceId: ContentWorkspaceId,
  ): Promise<ReadonlyArray<MediaOccurrenceRevision>>;
  listCatalog(
    siteId: SiteId,
    workspaceId: ContentWorkspaceId,
  ): Promise<
    Readonly<{
      assets: ReadonlyArray<MediaAsset>;
      occurrences: ReadonlyArray<MediaOccurrenceRevision>;
    }>
  >;
  auditAccessGrant(
    siteId: SiteId,
    workspaceId: ContentWorkspaceId,
    actorId: ContentActorId,
    availableAssets: ReadonlyArray<MediaAsset>,
    availableOccurrences: ReadonlyArray<MediaOccurrenceRevision>,
    occurredAt: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<
    Readonly<{
      assets: ReadonlyArray<MediaAsset>;
      occurrences: ReadonlyArray<MediaOccurrenceRevision>;
      occurredAt: string;
    }>
  >;
  createAsset(
    asset: MediaAsset,
    context: MediaMutationContext,
  ): Promise<MediaAsset>;
  getOccurrence(
    siteId: SiteId,
    workspaceId: ContentWorkspaceId,
    occurrenceId: MediaOccurrenceId,
  ): Promise<MediaOccurrenceRevision | null>;
  getOccurrenceRevision(
    siteId: SiteId,
    workspaceId: ContentWorkspaceId,
    occurrenceId: MediaOccurrenceId,
    revision: number,
  ): Promise<MediaOccurrenceRevision | null>;
  saveOccurrence(
    revision: MediaOccurrenceRevision,
    baseRevision: number,
    action: Extract<
      MediaAuditAction,
      "media.occurrence.replaced" | "media.occurrence.cropped"
    >,
    context: MediaMutationContext,
  ): Promise<MediaOccurrenceRevision>;
  beginAssetDeletion(
    siteId: SiteId,
    assetId: MediaAssetId,
    context: MediaMutationContext,
  ): Promise<MediaAsset>;
  tombstoneAssetDeletion(
    siteId: SiteId,
    assetId: MediaAssetId,
    actorId: ContentActorId,
    occurredAt: string,
    context: MediaMutationContext,
  ): Promise<void>;
  completeAssetDeletion(
    siteId: SiteId,
    assetId: MediaAssetId,
    occurredAt: string,
    context: MediaMutationContext,
  ): Promise<void>;
  audit(siteId: SiteId): Promise<ReadonlyArray<MediaAuditEvent>>;
}>;

/**
 * A small copy of the uploaded image, made before the upload request. It is
 * presentation data: the source object never changes, and an upload without
 * one still succeeds.
 */
export type MediaThumbnailUpload = Readonly<{
  contentType: string;
  byteLength: number;
  width: number;
  height: number;
  source: Uint8Array;
}>;

type UploadMediaAssetCommand = Readonly<{
  actorId: ContentActorId;
  assetId: MediaAssetId;
  fileName: string;
  contentType: string;
  byteLength: number;
  width: number;
  height: number;
  source: Uint8Array;
  idempotencyKey: string;
  thumbnail?: MediaThumbnailUpload;
}>;

type ReplaceMediaOccurrenceCommand = Readonly<{
  actorId: ContentActorId;
  workspaceId: ContentWorkspaceId;
  occurrenceId: MediaOccurrenceId;
  assetId: MediaAssetId;
  baseRevision: number;
  idempotencyKey: string;
}>;

type CropMediaOccurrenceCommand = Readonly<{
  actorId: ContentActorId;
  workspaceId: ContentWorkspaceId;
  occurrenceId: MediaOccurrenceId;
  assetId: MediaAssetId;
  crop: MediaCrop;
  baseRevision: number;
  idempotencyKey: string;
}>;

/** The image types the media library stores and serves. */
export const mediaContentTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies ReadonlyArray<MediaAsset["contentType"]>;

const allowedContentTypes = new Set<MediaAsset["contentType"]>(
  mediaContentTypes,
);

export function isMediaContentType(value: string): boolean {
  return allowedContentTypes.has(value as MediaAsset["contentType"]);
}

function assertIdempotencyKey(value: string): void {
  if (value.trim().length < 8 || value.length > 200) {
    throw new MediaValidationError("idempotencyKey");
  }
}

/**
 * A thumbnail must be a real image the library can serve, no larger than the
 * thumbnail edge limit, and no larger than the source it stands in for.
 */
function assertThumbnail(
  thumbnail: MediaThumbnailUpload,
  source: Readonly<{ width: number; height: number }>,
): void {
  if (
    !allowedContentTypes.has(thumbnail.contentType as MediaAsset["contentType"])
  ) {
    throw new MediaValidationError("thumbnail");
  }
  if (
    !Number.isSafeInteger(thumbnail.byteLength) ||
    thumbnail.byteLength <= 0 ||
    thumbnail.byteLength !== thumbnail.source.byteLength ||
    thumbnail.byteLength > mediaThumbnailMaxByteLength ||
    !Number.isSafeInteger(thumbnail.width) ||
    thumbnail.width <= 0 ||
    !Number.isSafeInteger(thumbnail.height) ||
    thumbnail.height <= 0 ||
    thumbnail.width > mediaThumbnailMaxEdge ||
    thumbnail.height > mediaThumbnailMaxEdge ||
    thumbnail.width > source.width ||
    thumbnail.height > source.height
  ) {
    throw new MediaValidationError("thumbnail");
  }
}

function assertCrop(crop: MediaCrop): void {
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > 1 ||
    crop.y + crop.height > 1
  ) {
    throw new MediaValidationError("crop");
  }
}

function immutable<Value>(value: Value): Value {
  return Object.freeze(structuredClone(value));
}

async function hashSource(source: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    source.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createMediaAssetApplication({
  siteId,
  actorId,
  assets,
  sources,
  now = () => new Date().toISOString(),
}: {
  siteId: SiteId;
  actorId: ContentActorId;
  assets: MediaAssetStore;
  sources: MediaSourceStore;
  now?: () => string;
}) {
  const mutationContext = (
    idempotencyKey: string,
    requestHash: string,
  ): MediaMutationContext => ({
    siteId,
    idempotencyKey,
    requestHash,
    claimToken: crypto.randomUUID(),
  });

  async function replayMutation(
    context: MediaMutationContext,
    expectedKind: MediaMutationResult["kind"],
  ) {
    const replay = await assets.replay(context);
    if (replay !== null && replay.kind !== expectedKind) {
      throw new MediaValidationError("idempotencyKey");
    }
    return replay;
  }

  async function claimMutation(
    context: MediaMutationContext,
    expectedKind: MediaMutationResult["kind"],
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await replayMutation(context, expectedKind);
      if (replay !== null) return replay;
      if (await assets.claim(context)) {
        const racedReceipt = await replayMutation(context, expectedKind);
        if (racedReceipt !== null) return racedReceipt;
        return null;
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new MediaMutationInProgressError();
  }

  async function withMutationLease<Value>(
    context: MediaMutationContext,
    work: () => Promise<Value>,
  ) {
    const timer = setInterval(() => {
      void assets.renewClaim(context).catch(() => undefined);
    }, 10_000);
    try {
      if (!(await assets.renewClaim(context))) {
        throw new MediaSiteAccessError();
      }
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  return Object.freeze({
    siteId,
    commands: Object.freeze({
      async upload(command: UploadMediaAssetCommand): Promise<MediaAsset> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        if (
          !allowedContentTypes.has(
            command.contentType as MediaAsset["contentType"],
          )
        ) {
          throw new MediaValidationError("contentType");
        }
        if (
          command.fileName.trim() === "" ||
          command.fileName.length > 255 ||
          !Number.isSafeInteger(command.byteLength) ||
          command.byteLength <= 0 ||
          command.byteLength !== command.source.byteLength ||
          !Number.isSafeInteger(command.width) ||
          command.width <= 0 ||
          !Number.isSafeInteger(command.height) ||
          command.height <= 0
        ) {
          throw new MediaValidationError("source");
        }
        if (command.thumbnail !== undefined) {
          assertThumbnail(command.thumbnail, command);
        }
        const sourceHash = await hashSource(command.source);
        const hash = await sha256CanonicalJson({
          actorId: command.actorId,
          assetId: command.assetId,
          fileName: command.fileName,
          contentType: command.contentType,
          byteLength: command.byteLength,
          width: command.width,
          height: command.height,
          sourceHash,
        });
        const context = mutationContext(command.idempotencyKey, hash);
        const replay = await replayMutation(context, "asset");
        if (replay !== null) {
          if ((await assets.getAsset(siteId, command.assetId)) === null) {
            throw new MediaValidationError("assetId");
          }
          return (replay as Extract<
            MediaMutationResult,
            { kind: "asset" }
          >).value;
        }
        if (await assets.isAssetIdReserved(siteId, command.assetId)) {
          throw new MediaValidationError("assetId");
        }
        const concurrent = await claimMutation(context, "asset");
        if (concurrent !== null) {
          return (concurrent as Extract<
            MediaMutationResult,
            { kind: "asset" }
          >).value;
        }
        try {
          return await withMutationLease(context, async () => {
            const existing = await assets.getAsset(siteId, command.assetId);
            if (existing !== null) {
              if (
                existing.sourceHash !== sourceHash ||
                existing.fileName !== command.fileName ||
                existing.contentType !== command.contentType ||
                existing.byteLength !== command.byteLength ||
                existing.width !== command.width ||
                existing.height !== command.height
              ) {
                throw new MediaValidationError("assetId");
              }
              await assets.record(context, {
                kind: "asset",
                value: existing,
              });
              return existing;
            }
            const objectKey = `media/${siteId}/${command.assetId}/source`;
            const asset: MediaAsset = {
              siteId,
              assetId: command.assetId,
              objectKey,
              sourceHash,
              fileName: command.fileName,
              contentType: command.contentType as MediaAsset["contentType"],
              byteLength: command.byteLength,
              width: command.width,
              height: command.height,
              createdAt: now(),
              createdBy: command.actorId,
            };
            await sources.put(objectKey, command.source, {
              contentType: asset.contentType,
              sourceHash: asset.sourceHash,
            });
            // The thumbnail is stored only when the source object is first
            // created, so a later upload can never swap the small copy that
            // stands in for an existing source.
            if (command.thumbnail !== undefined) {
              await sources.putVariant(
                mediaThumbnailObjectKey(asset),
                command.thumbnail.source,
                {
                  contentType: command.thumbnail.contentType,
                  variantHash: await hashSource(command.thumbnail.source),
                  variantOf: asset.sourceHash,
                },
              );
            }
            if (!(await assets.renewClaim(context))) {
              throw new MediaSiteAccessError();
            }
            return assets.createAsset(asset, context);
          });
        } catch (error) {
          await assets.releaseClaim(context);
          throw error;
        }
      },
      async replaceOccurrence(
        command: ReplaceMediaOccurrenceCommand,
      ): Promise<MediaOccurrenceRevision> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        requireRenderedMediaOccurrenceId(command.occurrenceId);
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await sha256CanonicalJson(command);
        const context = mutationContext(command.idempotencyKey, hash);
        const replay = await replayMutation(context, "occurrence");
        if (replay !== null) {
          return (replay as Extract<
            MediaMutationResult,
            { kind: "occurrence" }
          >).value;
        }
        if ((await assets.getAsset(siteId, command.assetId)) === null) {
          throw new MediaSiteAccessError();
        }
        const concurrent = await claimMutation(context, "occurrence");
        if (concurrent !== null) {
          return (concurrent as Extract<
            MediaMutationResult,
            { kind: "occurrence" }
          >).value;
        }
        try {
          return await withMutationLease(context, async () => {
            const revision: MediaOccurrenceRevision = {
              siteId,
              workspaceId: command.workspaceId,
              occurrenceId: command.occurrenceId,
              revision: command.baseRevision + 1,
              assetId: command.assetId,
              crop: null,
              createdAt: now(),
              createdBy: command.actorId,
            };
            await assets.saveOccurrence(
              revision,
              command.baseRevision,
              "media.occurrence.replaced",
              context,
            );
            return immutable(revision);
          });
        } catch (error) {
          await assets.releaseClaim(context);
          throw error;
        }
      },
      async cropOccurrence(
        command: CropMediaOccurrenceCommand,
      ): Promise<MediaOccurrenceRevision> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        requireRenderedMediaOccurrenceId(command.occurrenceId);
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await sha256CanonicalJson(command);
        const context = mutationContext(command.idempotencyKey, hash);
        const replay = await replayMutation(context, "occurrence");
        if (replay !== null) {
          return (replay as Extract<
            MediaMutationResult,
            { kind: "occurrence" }
          >).value;
        }
        assertCrop(command.crop);
        const concurrent = await claimMutation(context, "occurrence");
        if (concurrent !== null) {
          return (concurrent as Extract<
            MediaMutationResult,
            { kind: "occurrence" }
          >).value;
        }
        try {
          return await withMutationLease(context, async () => {
            const current = await assets.getOccurrence(
              siteId,
              command.workspaceId,
              command.occurrenceId,
            );
            if (
              (await assets.getAsset(siteId, command.assetId)) === null ||
              (current !== null && current.assetId !== command.assetId)
            ) {
              throw new MediaSiteAccessError();
            }
            const revision: MediaOccurrenceRevision = {
              ...(current ?? {
                siteId,
                workspaceId: command.workspaceId,
                occurrenceId: command.occurrenceId,
                assetId: command.assetId,
              }),
              revision: command.baseRevision + 1,
              crop: command.crop,
              createdAt: now(),
              createdBy: command.actorId,
            };
            await assets.saveOccurrence(
              revision,
              command.baseRevision,
              "media.occurrence.cropped",
              context,
            );
            return immutable(revision);
          });
        } catch (error) {
          await assets.releaseClaim(context);
          throw error;
        }
      },
      async delete(command: {
        actorId: ContentActorId;
        assetId: MediaAssetId;
        idempotencyKey: string;
      }): Promise<void> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await sha256CanonicalJson(command);
        const context = mutationContext(command.idempotencyKey, hash);
        const replay = await replayMutation(context, "deleted");
        if (replay !== null) {
          return;
        }
        const concurrent = await claimMutation(context, "deleted");
        if (concurrent !== null) return;
        try {
          return await withMutationLease(context, async () => {
            const asset = await assets.beginAssetDeletion(
              siteId,
              command.assetId,
              context,
            );
            const occurredAt = now();
            await assets.tombstoneAssetDeletion(
              siteId,
              command.assetId,
              command.actorId,
              occurredAt,
              context,
            );
            await sources.delete(asset.objectKey);
            await sources.delete(mediaThumbnailObjectKey(asset));
            if (!(await assets.renewClaim(context))) {
              throw new MediaSiteAccessError();
            }
            await assets.completeAssetDeletion(
              siteId,
              command.assetId,
              occurredAt,
              context,
            );
          });
        } catch (error) {
          await assets.releaseClaim(context);
          throw error;
        }
      },
      async grantAccess(command: {
        actorId: ContentActorId;
        workspaceId: ContentWorkspaceId;
        idempotencyKey: string;
      }) {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        const {
          assets: availableAssets,
          occurrences: availableOccurrences,
        } = await assets.listCatalog(siteId, command.workspaceId);
        const requestHash = await sha256CanonicalJson(command);
        const grant = await assets.auditAccessGrant(
          siteId,
          command.workspaceId,
          actorId,
          availableAssets,
          availableOccurrences,
          now(),
          command.idempotencyKey,
          requestHash,
        );
        return {
          assets: grant.assets,
          occurrences: grant.occurrences,
          accessGrantedAt: grant.occurredAt,
        };
      },
      async grantRevisionAccess(command: {
        actorId: ContentActorId;
        workspaceId: ContentWorkspaceId;
        assetIds: ReadonlyArray<MediaAssetId>;
        idempotencyKey: string;
      }) {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        const assetIds = [...new Set(command.assetIds)].sort();
        const availableAssets = await Promise.all(
          assetIds.map((assetId) => assets.getAsset(siteId, assetId)),
        );
        if (availableAssets.some((asset) => asset === null)) {
          throw new MediaSiteAccessError();
        }
        const requestHash = await sha256CanonicalJson({
          ...command,
          assetIds,
        });
        const grant = await assets.auditAccessGrant(
          siteId,
          command.workspaceId,
          actorId,
          availableAssets as ReadonlyArray<MediaAsset>,
          [],
          now(),
          command.idempotencyKey,
          requestHash,
        );
        return {
          assetIds: grant.assets.map((asset) => asset.assetId),
          accessGrantedAt: grant.occurredAt,
        };
      },
    }),
    queries: Object.freeze({
      async getReplacementReceipt(
        command: ReplaceMediaOccurrenceCommand,
      ): Promise<MediaOccurrenceRevision | null> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        requireRenderedMediaOccurrenceId(command.occurrenceId);
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await sha256CanonicalJson(command);
        const replay = await replayMutation(
          mutationContext(command.idempotencyKey, hash),
          "occurrence",
        );
        return replay === null
          ? null
          : (replay as Extract<
              MediaMutationResult,
              { kind: "occurrence" }
            >).value;
      },
      getAsset(assetId: MediaAssetId) {
        return assets.getAsset(siteId, assetId);
      },
      listAssets() {
        return assets.listAssets(siteId);
      },
      listOccurrences(workspaceId: ContentWorkspaceId) {
        return assets.listOccurrences(siteId, workspaceId);
      },
      async getSource(assetId: MediaAssetId) {
        const asset = await assets.getAsset(siteId, assetId);
        if (asset === null) throw new MediaSiteAccessError();
        return sources.get(asset.objectKey, {
          contentType: asset.contentType,
          sourceHash: asset.sourceHash,
        });
      },
      /**
       * The small copy of this asset, or null when none was stored. A caller
       * that gets null falls back to the source.
       */
      async getThumbnailSource(assetId: MediaAssetId) {
        const asset = await assets.getAsset(siteId, assetId);
        if (asset === null) throw new MediaSiteAccessError();
        return sources.getVariant(mediaThumbnailObjectKey(asset), {
          variantOf: asset.sourceHash,
        });
      },
      async getPublishedSource(assetId: MediaAssetId) {
        const asset = await assets.getAsset(siteId, assetId);
        if (asset === null) throw new MediaSiteAccessError();
        return sources.get(asset.objectKey, {
          contentType: asset.contentType,
          sourceHash: asset.sourceHash,
        });
      },
      getOccurrence(
        workspaceId: ContentWorkspaceId,
        occurrenceId: MediaOccurrenceId,
      ) {
        return assets.getOccurrence(siteId, workspaceId, occurrenceId);
      },
      getOccurrenceRevision(
        workspaceId: ContentWorkspaceId,
        occurrenceId: MediaOccurrenceId,
        revision: number,
      ) {
        return assets.getOccurrenceRevision(
          siteId,
          workspaceId,
          occurrenceId,
          revision,
        );
      },
      audit() {
        return assets.audit(siteId);
      },
    }),
  });
}

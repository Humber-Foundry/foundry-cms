import type { SiteId } from "@foundry/site-definition";

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

export type MediaCrop = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type MediaOccurrenceRevision = Readonly<{
  siteId: SiteId;
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
  "media.assets.listed",
  "media.occurrences.listed",
  "media.source.read",
] as const;
export type MediaAuditAction = (typeof mediaAuditActions)[number];

export type MediaAuditEvent = Readonly<{
  siteId: SiteId;
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
  get(objectKey: string): Promise<
    | Readonly<{ body: Uint8Array; contentType: string }>
    | null
  >;
  delete(objectKey: string): Promise<void>;
}>;

export type MediaAssetStore = Readonly<{
  claim(
    context: MediaMutationContext,
  ): Promise<void>;
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
  ): Promise<ReadonlyArray<MediaOccurrenceRevision>>;
  auditRead(
    siteId: SiteId,
    actorId: ContentActorId,
    action: Extract<
      MediaAuditAction,
      "media.assets.listed" | "media.occurrences.listed" | "media.source.read"
    >,
    subjectId: string,
    occurredAt: string,
  ): Promise<void>;
  createAsset(
    asset: MediaAsset,
    context: MediaMutationContext,
  ): Promise<MediaAsset>;
  getOccurrence(
    siteId: SiteId,
    occurrenceId: MediaOccurrenceId,
  ): Promise<MediaOccurrenceRevision | null>;
  getOccurrenceRevision(
    siteId: SiteId,
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
  ): Promise<MediaAsset>;
  tombstoneAssetDeletion(
    siteId: SiteId,
    assetId: MediaAssetId,
    actorId: ContentActorId,
    occurredAt: string,
  ): Promise<void>;
  completeAssetDeletion(
    siteId: SiteId,
    assetId: MediaAssetId,
    occurredAt: string,
    context: MediaMutationContext,
  ): Promise<void>;
  audit(siteId: SiteId): Promise<ReadonlyArray<MediaAuditEvent>>;
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
  crop: MediaCrop;
  baseRevision: number;
  idempotencyKey: string;
}>;

const allowedContentTypes = new Set<MediaAsset["contentType"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

function assertIdempotencyKey(value: string): void {
  if (value.trim().length < 8 || value.length > 200) {
    throw new MediaValidationError("idempotencyKey");
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
  ): MediaMutationContext => ({ siteId, idempotencyKey, requestHash });

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
        await assets.claim(context);
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
        return assets.createAsset(asset, context);
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
        await assets.claim(context);
        const revision: MediaOccurrenceRevision = {
          siteId,
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
        await assets.claim(context);
        const current = await assets.getOccurrence(
          siteId,
          command.occurrenceId,
        );
        if (current === null) {
          throw new MediaSiteAccessError();
        }
        const revision: MediaOccurrenceRevision = {
          ...current,
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
        await assets.claim(context);
        const asset = await assets.beginAssetDeletion(
          siteId,
          command.assetId,
        );
        const occurredAt = now();
        await assets.tombstoneAssetDeletion(
          siteId,
          command.assetId,
          command.actorId,
          occurredAt,
        );
        await sources.delete(asset.objectKey);
        await assets.completeAssetDeletion(
          siteId,
          command.assetId,
          occurredAt,
          context,
        );
      },
    }),
    queries: Object.freeze({
      getAsset(assetId: MediaAssetId) {
        return assets.getAsset(siteId, assetId);
      },
      async listAssets() {
        const result = await assets.listAssets(siteId);
        await assets.auditRead(
          siteId,
          actorId,
          "media.assets.listed",
          siteId,
          now(),
        );
        return result;
      },
      async listOccurrences() {
        const result = await assets.listOccurrences(siteId);
        await assets.auditRead(
          siteId,
          actorId,
          "media.occurrences.listed",
          siteId,
          now(),
        );
        return result;
      },
      async getSource(assetId: MediaAssetId) {
        const asset = await assets.getAsset(siteId, assetId);
        if (asset === null) throw new MediaSiteAccessError();
        const source = await sources.get(asset.objectKey);
        await assets.auditRead(
          siteId,
          actorId,
          "media.source.read",
          assetId,
          now(),
        );
        return source;
      },
      getOccurrence(occurrenceId: MediaOccurrenceId) {
        return assets.getOccurrence(siteId, occurrenceId);
      },
      getOccurrenceRevision(
        occurrenceId: MediaOccurrenceId,
        revision: number,
      ) {
        return assets.getOccurrenceRevision(siteId, occurrenceId, revision);
      },
      audit() {
        return assets.audit(siteId);
      },
    }),
  });
}

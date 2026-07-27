import type { SiteId } from "@foundry/site-definition";

import type { ContentActorId } from "./content-revisions";

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

export type MediaAsset = Readonly<{
  siteId: SiteId;
  assetId: MediaAssetId;
  objectKey: string;
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
] as const;
export type MediaAuditAction = (typeof mediaAuditActions)[number];

export type MediaAuditEvent = Readonly<{
  siteId: SiteId;
  actorId: ContentActorId;
  action: MediaAuditAction;
  subjectId: MediaAssetId | MediaOccurrenceId;
  occurredAt: string;
}>;

export type MediaMutationResult =
  | Readonly<{ kind: "asset"; value: MediaAsset }>
  | Readonly<{ kind: "occurrence"; value: MediaOccurrenceRevision }>
  | Readonly<{ kind: "deleted"; assetId: MediaAssetId }>;

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
    metadata: Readonly<{ contentType: string }>,
  ): Promise<void>;
  delete(objectKey: string): Promise<void>;
}>;

export type MediaAssetStore = Readonly<{
  replay(
    siteId: SiteId,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<MediaMutationResult | null>;
  record(
    siteId: SiteId,
    idempotencyKey: string,
    requestHash: string,
    result: MediaMutationResult,
  ): Promise<void>;
  getAsset(siteId: SiteId, assetId: MediaAssetId): Promise<MediaAsset | null>;
  createAsset(asset: MediaAsset): Promise<void>;
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
  ): Promise<void>;
  beginAssetDeletion(
    siteId: SiteId,
    assetId: MediaAssetId,
  ): Promise<MediaAsset>;
  completeAssetDeletion(
    siteId: SiteId,
    assetId: MediaAssetId,
    actorId: ContentActorId,
    occurredAt: string,
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
  occurrenceId: MediaOccurrenceId;
  assetId: MediaAssetId;
  baseRevision: number;
  idempotencyKey: string;
}>;

type CropMediaOccurrenceCommand = Readonly<{
  actorId: ContentActorId;
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestHash(command: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(command)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createInMemoryMediaSourceStore(): MediaSourceStore & {
  readForTest(objectKey: string): Promise<Uint8Array | null>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(objectKey, source) {
      objects.set(objectKey, source.slice());
    },
    async delete(objectKey) {
      objects.delete(objectKey);
    },
    async readForTest(objectKey) {
      return objects.get(objectKey)?.slice() ?? null;
    },
  };
}

export function createInMemoryMediaAssetStore(): MediaAssetStore {
  const assets = new Map<string, MediaAsset>();
  const revisions = new Map<string, Map<number, MediaOccurrenceRevision>>();
  const current = new Map<string, number>();
  const auditEvents: MediaAuditEvent[] = [];
  const deletionReservations = new Set<string>();
  const receipts = new Map<
    string,
    Readonly<{ requestHash: string; result: MediaMutationResult }>
  >();
  const scopedKey = (
    siteId: SiteId,
    id: MediaAssetId | MediaOccurrenceId,
  ) => `${siteId}:${id}`;

  return {
    async replay(siteId, idempotencyKey, hash) {
      const receipt = receipts.get(`${siteId}:${idempotencyKey}`);
      if (receipt === undefined) return null;
      if (receipt.requestHash !== hash) {
        throw new MediaValidationError("idempotencyKey");
      }
      return immutable(receipt.result);
    },
    async record(siteId, idempotencyKey, hash, result) {
      const key = `${siteId}:${idempotencyKey}`;
      const receipt = receipts.get(key);
      if (receipt !== undefined && receipt.requestHash !== hash) {
        throw new MediaValidationError("idempotencyKey");
      }
      receipts.set(
        key,
        immutable({ requestHash: hash, result }),
      );
    },
    async getAsset(siteId, assetId) {
      return assets.get(scopedKey(siteId, assetId)) ?? null;
    },
    async createAsset(asset) {
      const key = scopedKey(asset.siteId, asset.assetId);
      const existing = assets.get(key);
      if (existing !== undefined) {
        if (
          existing.objectKey === asset.objectKey &&
          existing.byteLength === asset.byteLength &&
          existing.contentType === asset.contentType
        ) {
          return;
        }
        throw new MediaValidationError("assetId");
      }
      const saved = immutable(asset);
      assets.set(key, saved);
      auditEvents.push(
        immutable({
          siteId: asset.siteId,
          actorId: asset.createdBy,
          action: "media.asset.uploaded" as const,
          subjectId: asset.assetId,
          occurredAt: asset.createdAt,
        }),
      );
    },
    async getOccurrence(siteId, occurrenceId) {
      const key = scopedKey(siteId, occurrenceId);
      const revision = current.get(key);
      return revision === undefined
        ? null
        : (revisions.get(key)?.get(revision) ?? null);
    },
    async getOccurrenceRevision(siteId, occurrenceId, revision) {
      return (
        revisions.get(scopedKey(siteId, occurrenceId))?.get(revision) ?? null
      );
    },
    async saveOccurrence(revision, baseRevision, action) {
      if (
        !assets.has(scopedKey(revision.siteId, revision.assetId)) ||
        deletionReservations.has(scopedKey(revision.siteId, revision.assetId))
      ) {
        throw new MediaSiteAccessError();
      }
      const key = scopedKey(revision.siteId, revision.occurrenceId);
      const currentRevision = current.get(key) ?? 0;
      if (currentRevision !== baseRevision) {
        throw new MediaOccurrenceConflictError(currentRevision);
      }
      const saved = immutable(revision);
      let history = revisions.get(key);
      if (history === undefined) {
        history = new Map();
        revisions.set(key, history);
      }
      history.set(saved.revision, saved);
      current.set(key, saved.revision);
      auditEvents.push(
        immutable({
          siteId: saved.siteId,
          actorId: saved.createdBy,
          action,
          subjectId: saved.occurrenceId,
          occurredAt: saved.createdAt,
        }),
      );
    },
    async beginAssetDeletion(siteId, assetId) {
      const key = scopedKey(siteId, assetId);
      const asset = assets.get(key);
      if (asset === undefined) {
        throw new MediaSiteAccessError();
      }
      if (deletionReservations.has(key)) return asset;
      let referenceCount = 0;
      for (const [occurrenceKey, history] of revisions) {
        if (!occurrenceKey.startsWith(`${siteId}:`)) continue;
        if ([...history.values()].some((revision) => revision.assetId === assetId)) {
          referenceCount += 1;
        }
      }
      if (referenceCount > 0) {
        throw new MediaAssetReferencedError(assetId, referenceCount);
      }
      deletionReservations.add(key);
      return asset;
    },
    async completeAssetDeletion(siteId, assetId, actorId, occurredAt) {
      const key = scopedKey(siteId, assetId);
      if (!deletionReservations.has(key) || !assets.has(key)) {
        throw new MediaSiteAccessError();
      }
      assets.delete(key);
      deletionReservations.delete(key);
      auditEvents.push(
        immutable({
          siteId,
          actorId,
          action: "media.asset.deleted" as const,
          subjectId: assetId,
          occurredAt,
        }),
      );
    },
    async audit(siteId) {
      return auditEvents.filter((event) => event.siteId === siteId);
    },
  };
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
  return Object.freeze({
    siteId,
    commands: Object.freeze({
      async upload(command: UploadMediaAssetCommand): Promise<MediaAsset> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await requestHash(command);
        const replay = await assets.replay(
          siteId,
          command.idempotencyKey,
          hash,
        );
        if (replay !== null) {
          if (replay.kind !== "asset") {
            throw new MediaValidationError("idempotencyKey");
          }
          return replay.value;
        }
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
        const existing = await assets.getAsset(siteId, command.assetId);
        if (existing !== null) return existing;
        const objectKey = `media/${siteId}/${command.assetId}/source`;
        const asset: MediaAsset = {
          siteId,
          assetId: command.assetId,
          objectKey,
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
        });
        await assets.createAsset(asset);
        await assets.record(siteId, command.idempotencyKey, hash, {
          kind: "asset",
          value: asset,
        });
        return immutable(asset);
      },
      async replaceOccurrence(
        command: ReplaceMediaOccurrenceCommand,
      ): Promise<MediaOccurrenceRevision> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await requestHash(command);
        const replay = await assets.replay(
          siteId,
          command.idempotencyKey,
          hash,
        );
        if (replay !== null) {
          if (replay.kind !== "occurrence") {
            throw new MediaValidationError("idempotencyKey");
          }
          return replay.value;
        }
        if ((await assets.getAsset(siteId, command.assetId)) === null) {
          throw new MediaSiteAccessError();
        }
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
        );
        await assets.record(siteId, command.idempotencyKey, hash, {
          kind: "occurrence",
          value: revision,
        });
        return immutable(revision);
      },
      async cropOccurrence(
        command: CropMediaOccurrenceCommand,
      ): Promise<MediaOccurrenceRevision> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await requestHash(command);
        const replay = await assets.replay(
          siteId,
          command.idempotencyKey,
          hash,
        );
        if (replay !== null) {
          if (replay.kind !== "occurrence") {
            throw new MediaValidationError("idempotencyKey");
          }
          return replay.value;
        }
        assertCrop(command.crop);
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
        );
        await assets.record(siteId, command.idempotencyKey, hash, {
          kind: "occurrence",
          value: revision,
        });
        return immutable(revision);
      },
      async delete(command: {
        actorId: ContentActorId;
        assetId: MediaAssetId;
        idempotencyKey: string;
      }): Promise<void> {
        if (command.actorId !== actorId) throw new MediaSiteAccessError();
        assertIdempotencyKey(command.idempotencyKey);
        const hash = await requestHash(command);
        const replay = await assets.replay(
          siteId,
          command.idempotencyKey,
          hash,
        );
        if (replay !== null) {
          if (replay.kind !== "deleted") {
            throw new MediaValidationError("idempotencyKey");
          }
          return;
        }
        const asset = await assets.beginAssetDeletion(
          siteId,
          command.assetId,
        );
        await sources.delete(asset.objectKey);
        await assets.completeAssetDeletion(
          siteId,
          command.assetId,
          command.actorId,
          now(),
        );
        await assets.record(siteId, command.idempotencyKey, hash, {
          kind: "deleted",
          assetId: command.assetId,
        });
      },
    }),
    queries: Object.freeze({
      getAsset(assetId: MediaAssetId) {
        return assets.getAsset(siteId, assetId);
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

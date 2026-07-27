import type { SiteId } from "@foundry/site-definition";

import {
  MediaAssetReferencedError,
  MediaOccurrenceConflictError,
  MediaSiteAccessError,
  MediaValidationError,
  type MediaAsset,
  type MediaAssetId,
  type MediaAssetStore,
  type MediaAuditEvent,
  type MediaMutationResult,
  type MediaOccurrenceId,
  type MediaOccurrenceRevision,
  type MediaSourceStore,
} from "./media-assets";

function immutable<Value>(value: Value): Value {
  return Object.freeze(structuredClone(value));
}

export function createInMemoryMediaSourceStore(): MediaSourceStore & {
  readForTest(objectKey: string): Promise<Uint8Array | null>;
} {
  const objects = new Map<
    string,
    Readonly<{
      source: Uint8Array;
      sourceHash: string;
      contentType: string;
    }>
  >();
  return {
    async put(objectKey, source, metadata) {
      const existing = objects.get(objectKey);
      if (existing !== undefined) {
        if (existing.sourceHash === metadata.sourceHash) return;
        throw new MediaValidationError("assetId");
      }
      objects.set(objectKey, {
        source: source.slice(),
        sourceHash: metadata.sourceHash,
        contentType: metadata.contentType,
      });
    },
    async get(objectKey) {
      const object = objects.get(objectKey);
      return object === undefined
        ? null
        : {
            body: object.source.slice(),
            contentType: object.contentType,
          };
    },
    async delete(objectKey) {
      objects.delete(objectKey);
    },
    async readForTest(objectKey) {
      return objects.get(objectKey)?.source.slice() ?? null;
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
  const claims = new Map<string, string>();
  const scopedKey = (
    siteId: SiteId,
    id: MediaAssetId | MediaOccurrenceId,
  ) => `${siteId}:${id}`;

  const store: MediaAssetStore = {
    async claim(context) {
      const key = `${context.siteId}:${context.idempotencyKey}`;
      const existing = claims.get(key);
      if (existing !== undefined && existing !== context.requestHash) {
        throw new MediaValidationError("idempotencyKey");
      }
      claims.set(key, context.requestHash);
    },
    async replay(context) {
      const receipt = receipts.get(
        `${context.siteId}:${context.idempotencyKey}`,
      );
      if (receipt === undefined) return null;
      if (receipt.requestHash !== context.requestHash) {
        throw new MediaValidationError("idempotencyKey");
      }
      return immutable(receipt.result);
    },
    async record(context, result) {
      const key = `${context.siteId}:${context.idempotencyKey}`;
      const receipt = receipts.get(key);
      if (
        receipt !== undefined &&
        receipt.requestHash !== context.requestHash
      ) {
        throw new MediaValidationError("idempotencyKey");
      }
      receipts.set(
        key,
        immutable({ requestHash: context.requestHash, result }),
      );
    },
    async getAsset(siteId, assetId) {
      return assets.get(scopedKey(siteId, assetId)) ?? null;
    },
    async listAssets(siteId) {
      return [...assets.values()].filter((asset) => asset.siteId === siteId);
    },
    async listOccurrences(siteId) {
      const found: MediaOccurrenceRevision[] = [];
      for (const [key, revision] of current) {
        if (!key.startsWith(`${siteId}:`)) continue;
        const occurrence = revisions.get(key)?.get(revision);
        if (occurrence !== undefined) found.push(occurrence);
      }
      return found;
    },
    async auditRead(siteId, actorId, action, subjectId, occurredAt) {
      auditEvents.push(
        immutable({ siteId, actorId, action, subjectId, occurredAt }),
      );
    },
    async createAsset(asset, context) {
      const key = scopedKey(asset.siteId, asset.assetId);
      const existing = assets.get(key);
      if (existing !== undefined) {
        if (
          existing.objectKey === asset.objectKey &&
          existing.sourceHash === asset.sourceHash &&
          existing.byteLength === asset.byteLength &&
          existing.contentType === asset.contentType
        ) {
          return existing;
        }
        throw new MediaValidationError("assetId");
      }
      const saved = immutable(asset);
      assets.set(key, saved);
      auditEvents.push(
        immutable({
          siteId: asset.siteId,
          actorId: asset.createdBy,
          action: "media.asset.uploaded",
          subjectId: asset.assetId,
          occurredAt: asset.createdAt,
        }),
      );
      await store.record(context, { kind: "asset", value: saved });
      return saved;
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
    async saveOccurrence(revision, baseRevision, action, context) {
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
      const history =
        revisions.get(key) ?? new Map<number, MediaOccurrenceRevision>();
      revisions.set(key, history);
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
      await store.record(context, { kind: "occurrence", value: saved });
      return saved;
    },
    async beginAssetDeletion(siteId, assetId) {
      const key = scopedKey(siteId, assetId);
      const asset = assets.get(key);
      if (asset === undefined) throw new MediaSiteAccessError();
      if (deletionReservations.has(key)) return asset;
      let referenceCount = 0;
      for (const [occurrenceKey, history] of revisions) {
        if (
          occurrenceKey.startsWith(`${siteId}:`) &&
          [...history.values()].some(
            (revision) => revision.assetId === assetId,
          )
        ) {
          referenceCount += 1;
        }
      }
      if (referenceCount > 0) {
        throw new MediaAssetReferencedError(assetId, referenceCount);
      }
      deletionReservations.add(key);
      return asset;
    },
    async completeAssetDeletion(
      siteId,
      assetId,
      actorId,
      occurredAt,
      context,
    ) {
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
          action: "media.asset.deleted",
          subjectId: assetId,
          occurredAt,
        }),
      );
      await store.record(context, { kind: "deleted", assetId });
    },
    async audit(siteId) {
      return auditEvents.filter((event) => event.siteId === siteId);
    },
  };
  return store;
}

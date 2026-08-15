import type { SiteId } from "@humber-foundry/site-definition";
import type {
  ContentWorkspaceId,
  InMemoryMediaContentCoordinator,
} from "./content-revisions";

import {
  MediaAssetReferencedError,
  MediaOccurrenceConflictError,
  MediaSiteAccessError,
  MediaValidationError,
  isMediaContentType,
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

const thumbnailObjectKeyPattern =
  /^media\/site_[a-z0-9_]+\/asset_[a-z0-9_]+\/thumbnail$/u;

export function createInMemoryMediaSourceStore(): MediaSourceStore & {
  readForTest(objectKey: string): Promise<Uint8Array | null>;
} {
  const objects = new Map<
    string,
    Readonly<{
      source: Uint8Array;
      sourceHash: string;
      contentType: string;
      variantOf?: string;
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
    async get(objectKey, expected) {
      const object = objects.get(objectKey);
      if (
        object !== undefined &&
        (object.sourceHash !== expected.sourceHash ||
          object.contentType !== expected.contentType)
      ) {
        throw new MediaSiteAccessError();
      }
      return object === undefined
        ? null
        : {
            body: object.source.slice(),
            contentType: object.contentType,
          };
    },
    async putVariant(objectKey, variant, metadata) {
      if (!thumbnailObjectKeyPattern.test(objectKey)) {
        throw new TypeError("media_variant_key_invalid");
      }
      const existing = objects.get(objectKey);
      if (existing !== undefined) {
        if (
          existing.sourceHash === metadata.variantHash &&
          existing.variantOf === metadata.variantOf &&
          existing.contentType === metadata.contentType
        ) {
          return;
        }
        throw new Error("media_variant_identity_conflict");
      }
      objects.set(objectKey, {
        source: variant.slice(),
        sourceHash: metadata.variantHash,
        contentType: metadata.contentType,
        variantOf: metadata.variantOf,
      });
    },
    async getVariant(objectKey, expected) {
      const object = objects.get(objectKey);
      // Same rules as the R2 store: a variant made from another source, or
      // one claiming a type the library never writes, reads as missing.
      return object === undefined ||
        object.variantOf !== expected.variantOf ||
        !isMediaContentType(object.contentType)
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

export function createInMemoryMediaAssetStore({
  mediaContentCoordinator,
}: {
  mediaContentCoordinator?: InMemoryMediaContentCoordinator;
} = {}): MediaAssetStore {
  const assets = new Map<string, MediaAsset>();
  const deletedAssetIds = new Set<string>();
  const revisions = new Map<string, Map<number, MediaOccurrenceRevision>>();
  const current = new Map<string, number>();
  const auditEvents: MediaAuditEvent[] = [];
  const accessGrants = new Map<
    string,
    Readonly<{
      requestHash: string;
      assets: ReadonlyArray<MediaAsset>;
      occurrences: ReadonlyArray<MediaOccurrenceRevision>;
      occurredAt: string;
    }>
  >();
  const deletionReservations = new Map<
    string,
    Readonly<{ idempotencyKey: string; requestHash: string }>
  >();
  const receipts = new Map<
    string,
    Readonly<{ requestHash: string; result: MediaMutationResult }>
  >();
  const claims = new Map<
    string,
    { requestHash: string; claimToken: string; claimedAt: number }
  >();
  const scopedKey = (
    siteId: SiteId,
    id: MediaAssetId | MediaOccurrenceId,
  ) => `${siteId}:${id}`;
  const occurrenceKey = (
    siteId: SiteId,
    workspaceId: ContentWorkspaceId,
    occurrenceId: MediaOccurrenceId,
  ) => `${siteId}:${workspaceId}:${occurrenceId}`;

  const store: MediaAssetStore = {
    async claim(context) {
      const key = `${context.siteId}:${context.idempotencyKey}`;
      if (receipts.has(key)) return false;
      const existing = claims.get(key);
      if (
        existing !== undefined &&
        existing.requestHash !== context.requestHash
      ) {
        throw new MediaValidationError("idempotencyKey");
      }
      if (
        existing !== undefined &&
        existing.claimToken !== context.claimToken &&
        Date.now() - existing.claimedAt < 30_000
      ) {
        return false;
      }
      claims.set(key, {
        requestHash: context.requestHash,
        claimToken: context.claimToken,
        claimedAt: Date.now(),
      });
      return true;
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
    async releaseClaim(context) {
      const key = `${context.siteId}:${context.idempotencyKey}`;
      if (
        !receipts.has(key) &&
        claims.get(key)?.claimToken === context.claimToken
      ) {
        claims.delete(key);
      }
    },
    async renewClaim(context) {
      const key = `${context.siteId}:${context.idempotencyKey}`;
      const claim = claims.get(key);
      if (claim?.claimToken !== context.claimToken || receipts.has(key)) {
        return false;
      }
      claim.claimedAt = Date.now();
      return true;
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
      if (claims.get(key)?.claimToken !== context.claimToken) {
        throw new MediaSiteAccessError();
      }
      receipts.set(
        key,
        immutable({ requestHash: context.requestHash, result }),
      );
    },
    async getAsset(siteId, assetId) {
      const key = scopedKey(siteId, assetId);
      return deletedAssetIds.has(key) || deletionReservations.has(key)
        ? null
        : (assets.get(key) ?? null);
    },
    async isAssetIdReserved(siteId, assetId) {
      return assets.has(scopedKey(siteId, assetId));
    },
    async listAssets(siteId) {
      return [...assets.entries()]
        .filter(
          ([key, asset]) =>
            asset.siteId === siteId &&
              !deletedAssetIds.has(key) &&
              !deletionReservations.has(key),
        )
        .map(([, asset]) => asset);
    },
    async listOccurrences(siteId, workspaceId) {
      const found: MediaOccurrenceRevision[] = [];
      for (const [key, revision] of current) {
        if (!key.startsWith(`${siteId}:${workspaceId}:`)) continue;
        const occurrence = revisions.get(key)?.get(revision);
        if (occurrence !== undefined) found.push(occurrence);
      }
      return found;
    },
    async listCatalog(siteId, workspaceId) {
      const availableAssets = [...assets.entries()]
        .filter(
          ([key, asset]) =>
            asset.siteId === siteId &&
            !deletedAssetIds.has(key) &&
            !deletionReservations.has(key),
        )
        .map(([, asset]) => asset);
      const availableOccurrences: MediaOccurrenceRevision[] = [];
      for (const [key, revision] of current) {
        if (!key.startsWith(`${siteId}:${workspaceId}:`)) continue;
        const occurrence = revisions.get(key)?.get(revision);
        if (occurrence !== undefined) availableOccurrences.push(occurrence);
      }
      return {
        assets: availableAssets,
        occurrences: availableOccurrences,
      };
    },
    async auditAccessGrant(
      siteId,
      workspaceId,
      actorId,
      availableAssets,
      availableOccurrences,
      occurredAt,
      idempotencyKey,
      requestHash,
    ) {
      const key = `${siteId}:${actorId}:${idempotencyKey}`;
      const existing = accessGrants.get(key);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          throw new MediaValidationError("idempotencyKey");
        }
        return {
          assets: existing.assets,
          occurrences: existing.occurrences,
          occurredAt: existing.occurredAt,
        };
      }
      const grantedAssets = immutable(availableAssets);
      const grantedOccurrences = immutable(availableOccurrences);
      accessGrants.set(key, {
        requestHash,
        assets: grantedAssets,
        occurrences: grantedOccurrences,
        occurredAt,
      });
      auditEvents.push(
        immutable({
          siteId,
          workspaceId,
          actorId,
          action: "media.access.granted",
          subjectId: siteId,
          occurredAt,
        }),
      );
      return {
        assets: grantedAssets,
        occurrences: grantedOccurrences,
        occurredAt,
      };
    },
    async createAsset(asset, context) {
      if (
        claims.get(`${context.siteId}:${context.idempotencyKey}`)
          ?.claimToken !== context.claimToken
      ) {
        throw new MediaSiteAccessError();
      }
      const key = scopedKey(asset.siteId, asset.assetId);
      const existing = assets.get(key);
      if (deletedAssetIds.has(key)) {
        throw new MediaValidationError("assetId");
      }
      if (existing !== undefined) {
        if (
          existing.objectKey === asset.objectKey &&
          existing.sourceHash === asset.sourceHash &&
          existing.byteLength === asset.byteLength &&
          existing.contentType === asset.contentType &&
          existing.fileName === asset.fileName &&
          existing.width === asset.width &&
          existing.height === asset.height
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
          workspaceId: null,
          actorId: asset.createdBy,
          action: "media.asset.uploaded",
          subjectId: asset.assetId,
          occurredAt: asset.createdAt,
        }),
      );
      await store.record(context, { kind: "asset", value: saved });
      return saved;
    },
    async getOccurrence(siteId, workspaceId, occurrenceId) {
      const key = occurrenceKey(siteId, workspaceId, occurrenceId);
      const revision = current.get(key);
      return revision === undefined
        ? null
        : (revisions.get(key)?.get(revision) ?? null);
    },
    async getOccurrenceRevision(siteId, workspaceId, occurrenceId, revision) {
      return (
        revisions
          .get(occurrenceKey(siteId, workspaceId, occurrenceId))
          ?.get(revision) ?? null
      );
    },
    saveOccurrence(revision, baseRevision, action, context) {
      const operation = async () => {
        if (
          claims.get(`${context.siteId}:${context.idempotencyKey}`)
            ?.claimToken !== context.claimToken
        ) {
          throw new MediaSiteAccessError();
        }
        if (
          !assets.has(scopedKey(revision.siteId, revision.assetId)) ||
          deletionReservations.has(
            scopedKey(revision.siteId, revision.assetId),
          ) ||
          deletedAssetIds.has(scopedKey(revision.siteId, revision.assetId))
        ) {
          throw new MediaSiteAccessError();
        }
        const key = occurrenceKey(
          revision.siteId,
          revision.workspaceId,
          revision.occurrenceId,
        );
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
            workspaceId: saved.workspaceId,
            actorId: saved.createdBy,
            action,
            subjectId: saved.occurrenceId,
            occurredAt: saved.createdAt,
          }),
        );
        await store.record(context, { kind: "occurrence", value: saved });
        return saved;
      };
      return mediaContentCoordinator === undefined
        ? operation()
        : mediaContentCoordinator.runExclusive(operation);
    },
    async beginAssetDeletion(siteId, assetId, context) {
      if (
        claims.get(`${context.siteId}:${context.idempotencyKey}`)
          ?.claimToken !== context.claimToken
      ) {
        throw new MediaSiteAccessError();
      }
      const key = scopedKey(siteId, assetId);
      const asset = assets.get(key);
      if (asset === undefined) throw new MediaSiteAccessError();
      const reservation = deletionReservations.get(key);
      if (reservation !== undefined) {
        if (
          reservation.idempotencyKey !== context.idempotencyKey ||
          reservation.requestHash !== context.requestHash
        ) {
          const reservedMutationKey =
            `${siteId}:${reservation.idempotencyKey}`;
          const reservedClaim = claims.get(reservedMutationKey);
          if (
            receipts.has(reservedMutationKey) ||
            (reservedClaim !== undefined &&
              Date.now() - reservedClaim.claimedAt < 30_000)
          ) {
            throw new MediaSiteAccessError();
          }
          deletionReservations.set(key, {
            idempotencyKey: context.idempotencyKey,
            requestHash: context.requestHash,
          });
        }
        return asset;
      }
      if (deletedAssetIds.has(key)) throw new MediaSiteAccessError();
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
      deletionReservations.set(key, {
        idempotencyKey: context.idempotencyKey,
        requestHash: context.requestHash,
      });
      return asset;
    },
    async tombstoneAssetDeletion(
      siteId,
      assetId,
      actorId,
      occurredAt,
      context,
    ) {
      if (
        claims.get(`${context.siteId}:${context.idempotencyKey}`)
          ?.claimToken !== context.claimToken
      ) {
        throw new MediaSiteAccessError();
      }
      const key = scopedKey(siteId, assetId);
      const reservation = deletionReservations.get(key);
      if (
        reservation?.idempotencyKey !== context.idempotencyKey ||
        reservation.requestHash !== context.requestHash ||
        !assets.has(key)
      ) {
        throw new MediaSiteAccessError();
      }
      if (deletedAssetIds.has(key)) return;
      deletedAssetIds.add(key);
      auditEvents.push(
        immutable({
          siteId,
          workspaceId: null,
          actorId,
          action: "media.asset.deleted",
          subjectId: assetId,
          occurredAt,
        }),
      );
    },
    async completeAssetDeletion(
      siteId,
      assetId,
      occurredAt,
      context,
    ) {
      const key = scopedKey(siteId, assetId);
      const reservation = deletionReservations.get(key);
      if (
        reservation?.idempotencyKey !== context.idempotencyKey ||
        reservation.requestHash !== context.requestHash ||
        !assets.has(key)
      ) {
        throw new MediaSiteAccessError();
      }
      if (
        claims.get(`${context.siteId}:${context.idempotencyKey}`)
          ?.claimToken !== context.claimToken
      ) {
        throw new MediaSiteAccessError();
      }
      deletionReservations.delete(key);
      await store.record(context, { kind: "deleted", assetId });
    },
    async audit(siteId) {
      return auditEvents.filter((event) => event.siteId === siteId);
    },
  };
  return store;
}

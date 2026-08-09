import {
  MediaAssetReferencedError,
  MediaOccurrenceConflictError,
  MediaSiteAccessError,
  MediaValidationError,
  createMediaAssetId,
  createMediaOccurrenceId,
  restoreContentActorId,
  type MediaAsset,
  type MediaAssetId,
  type MediaAssetStore,
  type MediaAuditAction,
  type MediaAuditEvent,
  type MediaOccurrenceId,
  type MediaOccurrenceRevision,
  type MediaMutationResult,
  type ContentWorkspaceId,
} from "@humber-foundry/application";
import type { SiteId } from "@humber-foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type AssetRow = {
  site_id: SiteId;
  asset_id: string;
  object_key: string;
  source_hash: string;
  file_name: string;
  content_type: MediaAsset["contentType"];
  byte_length: number;
  width: number;
  height: number;
  created_at: string;
  created_by: string;
  deleted_at: string | null;
};

type OccurrenceRow = {
  site_id: SiteId;
  workspace_id: string;
  occurrence_id: string;
  revision: number;
  asset_id: string;
  crop_json: string | null;
  created_at: string;
  created_by: string;
};

type CatalogRow = {
  kind: "asset" | "occurrence";
  payload_json: string;
};

const assetProjection = `
  SELECT site_id, asset_id, object_key, source_hash, file_name, content_type,
         byte_length, width, height, created_at, created_by
         , deleted_at
  FROM media_assets
`;

const occurrenceProjection = `
  SELECT site_id, workspace_id, occurrence_id, revision, asset_id, crop_json,
         created_at, created_by
  FROM media_occurrence_revisions
`;

function toAsset(row: AssetRow): MediaAsset {
  return {
    siteId: row.site_id,
    assetId: createMediaAssetId(row.asset_id),
    objectKey: row.object_key,
    sourceHash: row.source_hash,
    fileName: row.file_name,
    contentType: row.content_type,
    byteLength: row.byte_length,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    createdBy: restoreContentActorId(row.created_by),
  };
}

function toOccurrence(row: OccurrenceRow): MediaOccurrenceRevision {
  return {
    siteId: row.site_id,
    workspaceId: row.workspace_id as ContentWorkspaceId,
    occurrenceId: createMediaOccurrenceId(row.occurrence_id),
    revision: row.revision,
    assetId: createMediaAssetId(row.asset_id),
    crop:
      row.crop_json === null
        ? null
        : (JSON.parse(row.crop_json) as MediaOccurrenceRevision["crop"]),
    createdAt: row.created_at,
    createdBy: restoreContentActorId(row.created_by),
  };
}

function restoreMutationResult(value: string): MediaMutationResult {
  const parsed = JSON.parse(value) as MediaMutationResult;
  if (parsed.kind === "asset") {
    return { kind: "asset", value: toAsset({
      site_id: parsed.value.siteId,
      asset_id: parsed.value.assetId,
      object_key: parsed.value.objectKey,
      source_hash: parsed.value.sourceHash,
      file_name: parsed.value.fileName,
      content_type: parsed.value.contentType,
      byte_length: parsed.value.byteLength,
      width: parsed.value.width,
      height: parsed.value.height,
      created_at: parsed.value.createdAt,
      created_by: parsed.value.createdBy,
      deleted_at: null,
    }) };
  }
  if (parsed.kind === "occurrence") {
    return {
      kind: "occurrence",
      value: toOccurrence({
        site_id: parsed.value.siteId,
        workspace_id: parsed.value.workspaceId,
        occurrence_id: parsed.value.occurrenceId,
        revision: parsed.value.revision,
        asset_id: parsed.value.assetId,
        crop_json:
          parsed.value.crop === null ? null : JSON.stringify(parsed.value.crop),
        created_at: parsed.value.createdAt,
        created_by: parsed.value.createdBy,
      }),
    };
  }
  return { kind: "deleted", assetId: createMediaAssetId(parsed.assetId) };
}

export function createD1MediaAssetStore(
  database: D1DatabaseBinding,
): MediaAssetStore {
  async function getStoredAsset(siteId: SiteId, assetId: MediaAssetId) {
    const row = await database
      .prepare(
        `${assetProjection} WHERE site_id = ?1 AND asset_id = ?2`,
      )
      .bind(siteId, assetId)
      .first<AssetRow>();
    if (row === null) return null;
    if (row.deleted_at !== null) {
      const deletion = await database
        .prepare(
          `SELECT 1 AS reserved FROM media_asset_deletions
           WHERE site_id = ?1 AND asset_id = ?2`,
        )
        .bind(siteId, assetId)
        .first<{ reserved: number }>();
      if (deletion === null) return null;
    }
    return toAsset(row);
  }

  async function getRecordedAsset(siteId: SiteId, assetId: MediaAssetId) {
    const row = await database
      .prepare(
        `${assetProjection} WHERE site_id = ?1 AND asset_id = ?2`,
      )
      .bind(siteId, assetId)
      .first<AssetRow>();
    return row === null ? null : toAsset(row);
  }

  async function getAsset(siteId: SiteId, assetId: MediaAssetId) {
    const row = await database
      .prepare(
        `${assetProjection}
         WHERE site_id = ?1 AND asset_id = ?2 AND deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM media_asset_deletions
             WHERE site_id = ?1 AND asset_id = ?2
           )`,
      )
      .bind(siteId, assetId)
      .first<AssetRow>();
    return row === null ? null : toAsset(row);
  }

  async function getOccurrenceRevision(
    siteId: SiteId,
    workspaceId: ContentWorkspaceId,
    occurrenceId: MediaOccurrenceId,
    revision: number,
  ) {
    const row = await database
      .prepare(
        `${occurrenceProjection}
         WHERE site_id = ?1 AND workspace_id = ?2
           AND occurrence_id = ?3 AND revision = ?4`,
      )
      .bind(siteId, workspaceId, occurrenceId, revision)
      .first<OccurrenceRow>();
    return row === null ? null : toOccurrence(row);
  }

  return {
    async claim({ siteId, idempotencyKey, requestHash, claimToken }) {
      const claimed = await database
        .prepare(
          `INSERT INTO media_mutation_claims (
             site_id, idempotency_key, request_hash, claim_token, claimed_at
           ) VALUES (?1, ?2, ?3, ?4, datetime('now'))
           ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
        )
        .bind(siteId, idempotencyKey, requestHash, claimToken)
        .run();
      if ((claimed.meta.changes ?? 0) === 0) {
        const existing = await database
          .prepare(
            `SELECT request_hash FROM media_mutation_claims
             WHERE site_id = ?1 AND idempotency_key = ?2`,
          )
          .bind(siteId, idempotencyKey)
          .first<{ request_hash: string }>();
        if (existing?.request_hash !== requestHash) {
          throw new MediaSiteAccessError();
        }
        const takeover = await database
          .prepare(
            `UPDATE media_mutation_claims
             SET claim_token = ?4, claimed_at = datetime('now')
             WHERE site_id = ?1 AND idempotency_key = ?2
               AND request_hash = ?3
               AND claimed_at <= datetime('now', '-30 seconds')
               AND NOT EXISTS (
                 SELECT 1 FROM media_mutation_receipts
                 WHERE site_id = ?1 AND idempotency_key = ?2
               )`,
          )
          .bind(siteId, idempotencyKey, requestHash, claimToken)
          .run();
        return (takeover.meta.changes ?? 0) > 0;
      }
      return true;
    },
    async replay({ siteId, idempotencyKey, requestHash }) {
      const row = await database
        .prepare(
          `SELECT request_hash, result_json
           FROM media_mutation_receipts
           WHERE site_id = ?1 AND idempotency_key = ?2`,
        )
        .bind(siteId, idempotencyKey)
        .first<{ request_hash: string; result_json: string }>();
      if (row === null) return null;
      if (row.request_hash !== requestHash) {
        throw new MediaSiteAccessError();
      }
      return restoreMutationResult(row.result_json);
    },
    async releaseClaim({
      siteId,
      idempotencyKey,
      requestHash,
      claimToken,
    }) {
      await database
        .prepare(
          `DELETE FROM media_mutation_claims
           WHERE site_id = ?1 AND idempotency_key = ?2 AND request_hash = ?3
             AND claim_token = ?4
             AND NOT EXISTS (
               SELECT 1 FROM media_mutation_receipts
               WHERE site_id = ?1 AND idempotency_key = ?2
             )`,
        )
        .bind(siteId, idempotencyKey, requestHash, claimToken)
        .run();
    },
    async renewClaim({ siteId, idempotencyKey, requestHash, claimToken }) {
      const renewed = await database
        .prepare(
          `UPDATE media_mutation_claims
           SET claimed_at = datetime('now')
           WHERE site_id = ?1 AND idempotency_key = ?2
             AND request_hash = ?3 AND claim_token = ?4
             AND NOT EXISTS (
               SELECT 1 FROM media_mutation_receipts
               WHERE site_id = ?1 AND idempotency_key = ?2
             )`,
        )
        .bind(siteId, idempotencyKey, requestHash, claimToken)
        .run();
      return (renewed.meta.changes ?? 0) > 0;
    },
    async record(context, result) {
      const { siteId, idempotencyKey, requestHash } = context;
      const saved = await database
        .prepare(
          `INSERT INTO media_mutation_receipts (
             site_id, idempotency_key, request_hash, result_json, created_at
           )
           SELECT ?1, ?2, ?3, ?4, datetime('now')
           WHERE EXISTS (
             SELECT 1 FROM media_mutation_claims
             WHERE site_id = ?1 AND idempotency_key = ?2
               AND request_hash = ?3 AND claim_token = ?5
           )
           ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
        )
        .bind(
          siteId,
          idempotencyKey,
          requestHash,
          JSON.stringify(result),
          context.claimToken,
        )
        .run();
      if ((saved.meta.changes ?? 0) === 0) {
        const replay = await this.replay(context);
        if (replay === null) throw new MediaSiteAccessError();
      }
    },
    getAsset,
    async isAssetIdReserved(siteId, assetId) {
      const row = await database
        .prepare(
          `SELECT 1 AS reserved FROM media_assets
           WHERE site_id = ?1 AND asset_id = ?2`,
        )
        .bind(siteId, assetId)
        .first<{ reserved: number }>();
      return row !== null;
    },
    async listAssets(siteId) {
      const rows = await database
        .prepare(
          `${assetProjection}
           WHERE site_id = ?1 AND deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM media_asset_deletions
               WHERE media_asset_deletions.site_id = media_assets.site_id
                 AND media_asset_deletions.asset_id = media_assets.asset_id
             )
           ORDER BY created_at, asset_id`,
        )
        .bind(siteId)
        .all<AssetRow>();
      return rows.results.map(toAsset);
    },
    async listOccurrences(siteId, workspaceId) {
      const rows = await database
        .prepare(
          `${occurrenceProjection}
           WHERE site_id = ?1 AND workspace_id = ?2
             AND revision = (
               SELECT current_revision
               FROM media_occurrences
               WHERE site_id = ?1
                 AND workspace_id = ?2
                 AND occurrence_id = media_occurrence_revisions.occurrence_id
             )
           ORDER BY occurrence_id`,
        )
        .bind(siteId, workspaceId)
        .all<OccurrenceRow>();
      return rows.results.map(toOccurrence);
    },
    async listCatalog(siteId, workspaceId) {
      const rows = await database
        .prepare(
          `SELECT 'asset' AS kind, json_object(
             'site_id', site_id,
             'asset_id', asset_id,
             'object_key', object_key,
             'source_hash', source_hash,
             'file_name', file_name,
             'content_type', content_type,
             'byte_length', byte_length,
             'width', width,
             'height', height,
             'created_at', created_at,
             'created_by', created_by,
             'deleted_at', deleted_at
           ) AS payload_json
           FROM media_assets
           WHERE site_id = ?1 AND deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM media_asset_deletions
               WHERE media_asset_deletions.site_id = media_assets.site_id
                 AND media_asset_deletions.asset_id = media_assets.asset_id
             )
           UNION ALL
           SELECT 'occurrence' AS kind, json_object(
             'site_id', site_id,
             'workspace_id', workspace_id,
             'occurrence_id', occurrence_id,
             'revision', revision,
             'asset_id', asset_id,
             'crop_json', crop_json,
             'created_at', created_at,
             'created_by', created_by
           ) AS payload_json
           FROM media_occurrence_revisions
           WHERE site_id = ?1 AND workspace_id = ?2
             AND revision = (
               SELECT current_revision
               FROM media_occurrences
               WHERE site_id = ?1
                 AND workspace_id = ?2
                 AND occurrence_id =
                   media_occurrence_revisions.occurrence_id
             )
           ORDER BY kind, payload_json`,
        )
        .bind(siteId, workspaceId)
        .all<CatalogRow>();
      return {
        assets: rows.results
          .filter((row) => row.kind === "asset")
          .map((row) => toAsset(JSON.parse(row.payload_json) as AssetRow)),
        occurrences: rows.results
          .filter((row) => row.kind === "occurrence")
          .map((row) =>
            toOccurrence(JSON.parse(row.payload_json) as OccurrenceRow),
          ),
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
      await database
        .prepare(
          `INSERT OR IGNORE INTO media_audit_events (
             site_id, workspace_id, actor_id, action, subject_id,
             subject_revision, idempotency_key, request_hash, scope_json,
             occurred_at
           ) VALUES (
             ?1, ?2, ?3, 'media.access.granted', ?1, NULL, ?4, ?5, ?6, ?7
           )`,
        )
        .bind(
          siteId,
          workspaceId,
          actorId,
          idempotencyKey,
          requestHash,
          JSON.stringify({
            assetIds: availableAssets.map((asset) => asset.assetId),
            occurrences: availableOccurrences.map((occurrence) => ({
              occurrenceId: occurrence.occurrenceId,
              revision: occurrence.revision,
            })),
          }),
          occurredAt,
        )
        .run();
      const recorded = await database
        .prepare(
          `SELECT request_hash, scope_json, occurred_at
           FROM media_audit_events
           WHERE site_id = ?1 AND actor_id = ?2
             AND idempotency_key = ?3
             AND action = 'media.access.granted'`,
        )
        .bind(siteId, actorId, idempotencyKey)
        .first<{
          request_hash: string;
          scope_json: string;
          occurred_at: string;
        }>();
      if (recorded === null || recorded.request_hash !== requestHash) {
        throw new MediaValidationError("idempotencyKey");
      }
      const scope: unknown = JSON.parse(recorded.scope_json);
      if (
        typeof scope !== "object" ||
        scope === null ||
        !("assetIds" in scope) ||
        !Array.isArray(scope.assetIds) ||
        !scope.assetIds.every((value) => typeof value === "string") ||
        !("occurrences" in scope) ||
        !Array.isArray(scope.occurrences) ||
        !scope.occurrences.every(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "occurrenceId" in value &&
            typeof value.occurrenceId === "string" &&
            "revision" in value &&
            typeof value.revision === "number" &&
            Number.isSafeInteger(value.revision) &&
            value.revision > 0,
        )
      ) {
        throw new MediaSiteAccessError();
      }
      const grantedAssets = await Promise.all(
        scope.assetIds.map((value) =>
          getRecordedAsset(siteId, createMediaAssetId(value)),
        ),
      );
      const grantedOccurrences = await Promise.all(
        scope.occurrences.map((value) => {
          const occurrence = value as {
            occurrenceId: string;
            revision: number;
          };
          return getOccurrenceRevision(
            siteId,
            workspaceId,
            createMediaOccurrenceId(occurrence.occurrenceId),
            occurrence.revision,
          );
        }),
      );
      if (
        grantedAssets.some((asset) => asset === null) ||
        grantedOccurrences.some((occurrence) => occurrence === null)
      ) {
        throw new MediaSiteAccessError();
      }
      return {
        assets: grantedAssets as ReadonlyArray<MediaAsset>,
        occurrences:
          grantedOccurrences as ReadonlyArray<MediaOccurrenceRevision>,
        occurredAt: recorded.occurred_at,
      };
    },
    async createAsset(asset, context) {
      const { idempotencyKey, requestHash } = context;
      const result: MediaMutationResult = { kind: "asset", value: asset };
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO media_assets (
               site_id, asset_id, object_key, source_hash, file_name, content_type,
               byte_length, width, height, created_at, created_by
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
             WHERE EXISTS (
               SELECT 1 FROM media_mutation_claims
               WHERE site_id = ?1 AND idempotency_key = ?12
                 AND request_hash = ?13 AND claim_token = ?14
             )
             ON CONFLICT (site_id, asset_id) DO NOTHING`,
          )
          .bind(
            asset.siteId,
            asset.assetId,
            asset.objectKey,
            asset.sourceHash,
            asset.fileName,
            asset.contentType,
            asset.byteLength,
            asset.width,
            asset.height,
            asset.createdAt,
            asset.createdBy,
            idempotencyKey,
            requestHash,
            context.claimToken,
          ),
        database
          .prepare(
            `INSERT OR IGNORE INTO media_audit_events (
               site_id, actor_id, action, subject_id,
               subject_revision, occurred_at
             )
             SELECT ?1, ?2, 'media.asset.uploaded', ?3, NULL, ?4
             WHERE EXISTS (
               SELECT 1 FROM media_mutation_claims
               WHERE site_id = ?1 AND idempotency_key = ?5
                 AND request_hash = ?6 AND claim_token = ?7
             )`,
          )
          .bind(
            asset.siteId,
            asset.createdBy,
            asset.assetId,
            asset.createdAt,
            idempotencyKey,
            requestHash,
            context.claimToken,
          ),
        database
          .prepare(
            `INSERT INTO media_mutation_receipts (
               site_id, idempotency_key, request_hash, result_json, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM media_assets
               WHERE site_id = ?1
                 AND asset_id = ?6
                 AND deleted_at IS NULL
                 AND object_key = ?7
                 AND source_hash = ?8
                 AND file_name = ?9
                 AND content_type = ?10
                 AND byte_length = ?11
                 AND width = ?12
                 AND height = ?13
                 AND created_at = ?14
                 AND created_by = ?15
             )
               AND EXISTS (
                 SELECT 1 FROM media_mutation_claims
                 WHERE site_id = ?1 AND idempotency_key = ?2
                   AND request_hash = ?3 AND claim_token = ?16
               )
             ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
          )
          .bind(
            asset.siteId,
            idempotencyKey,
            requestHash,
            JSON.stringify(result),
            asset.createdAt,
            asset.assetId,
            asset.objectKey,
            asset.sourceHash,
            asset.fileName,
            asset.contentType,
            asset.byteLength,
            asset.width,
            asset.height,
            asset.createdAt,
            asset.createdBy,
            context.claimToken,
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        const existingRow = await database
          .prepare(
            `${assetProjection} WHERE site_id = ?1 AND asset_id = ?2`,
          )
          .bind(asset.siteId, asset.assetId)
          .first<AssetRow>();
        const existing =
          existingRow === null || existingRow.deleted_at !== null
            ? null
            : toAsset(existingRow);
        if (
          existing === null ||
          existing.objectKey !== asset.objectKey ||
          existing.sourceHash !== asset.sourceHash ||
          existing.fileName !== asset.fileName ||
          existing.byteLength !== asset.byteLength ||
          existing.contentType !== asset.contentType ||
          existing.width !== asset.width ||
          existing.height !== asset.height
        ) {
          throw new MediaSiteAccessError();
        }
        await this.record(context, {
          kind: "asset",
          value: existing,
        });
        return existing;
      }
      return asset;
    },
    async getOccurrence(siteId, workspaceId, occurrenceId) {
      const row = await database
        .prepare(
          `${occurrenceProjection}
           WHERE site_id = ?1
             AND workspace_id = ?2
             AND occurrence_id = ?3
             AND revision = (
               SELECT current_revision
               FROM media_occurrences
               WHERE site_id = ?1 AND workspace_id = ?2
                 AND occurrence_id = ?3
             )`,
        )
        .bind(siteId, workspaceId, occurrenceId)
        .first<OccurrenceRow>();
      return row === null ? null : toOccurrence(row);
    },
    getOccurrenceRevision,
    async saveOccurrence(
      revision,
      baseRevision,
      action,
      context,
    ) {
      const { idempotencyKey, requestHash } = context;
      const mutationResult: MediaMutationResult = {
        kind: "occurrence",
        value: revision,
      };
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO media_occurrence_revisions (
               site_id, workspace_id, occurrence_id, revision, asset_id,
               crop_json, created_at, created_by
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
             WHERE EXISTS (
               SELECT 1 FROM media_assets
               WHERE site_id = ?1 AND asset_id = ?5
                 AND deleted_at IS NULL
             )
               AND NOT EXISTS (
                 SELECT 1 FROM media_asset_deletions
                 WHERE site_id = ?1 AND asset_id = ?5
               )
               AND (
                 (?9 = 0 AND NOT EXISTS (
                   SELECT 1 FROM media_occurrences
                   WHERE site_id = ?1 AND workspace_id = ?2
                     AND occurrence_id = ?3
                 ))
                 OR EXISTS (
                   SELECT 1 FROM media_occurrences
                   WHERE site_id = ?1 AND workspace_id = ?2
                     AND occurrence_id = ?3 AND current_revision = ?9
                 )
               )
               AND EXISTS (
                 SELECT 1 FROM media_mutation_claims
                 WHERE site_id = ?1 AND idempotency_key = ?10
                   AND request_hash = ?11 AND claim_token = ?12
               )`,
          )
          .bind(
            revision.siteId,
            revision.workspaceId,
            revision.occurrenceId,
            revision.revision,
            revision.assetId,
            revision.crop === null ? null : JSON.stringify(revision.crop),
            revision.createdAt,
            revision.createdBy,
            baseRevision,
            idempotencyKey,
            requestHash,
            context.claimToken,
          ),
        database
          .prepare(
            `INSERT INTO media_occurrences (
               site_id, workspace_id, occurrence_id,
               current_revision, current_asset_id
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM media_occurrence_revisions
               WHERE site_id = ?1 AND workspace_id = ?2
                 AND occurrence_id = ?3 AND revision = ?4
             )
             ON CONFLICT (site_id, workspace_id, occurrence_id) DO UPDATE SET
               current_revision = excluded.current_revision,
               current_asset_id = excluded.current_asset_id
             WHERE media_occurrences.current_revision = ?6`,
          )
          .bind(
            revision.siteId,
            revision.workspaceId,
            revision.occurrenceId,
            revision.revision,
            revision.assetId,
            baseRevision,
          ),
        database
          .prepare(
            `INSERT OR IGNORE INTO media_audit_events (
               site_id, workspace_id, actor_id, action, subject_id,
               subject_revision, occurred_at
             )
             SELECT ?1, ?7, ?2, ?3, ?4, ?5, ?6
             WHERE EXISTS (
               SELECT 1 FROM media_occurrences
               WHERE site_id = ?1 AND workspace_id = ?7
                 AND occurrence_id = ?4 AND current_revision = ?5
             )
               AND EXISTS (
                 SELECT 1 FROM media_occurrence_revisions
                 WHERE site_id = ?1 AND workspace_id = ?7
                   AND occurrence_id = ?4 AND revision = ?5
                   AND asset_id = ?11 AND crop_json IS ?12
                   AND created_at = ?6 AND created_by = ?2
               )
               AND EXISTS (
                 SELECT 1 FROM media_mutation_claims
                 WHERE site_id = ?1 AND idempotency_key = ?8
                   AND request_hash = ?9 AND claim_token = ?10
               )`,
          )
          .bind(
            revision.siteId,
            revision.createdBy,
            action,
            revision.occurrenceId,
            revision.revision,
            revision.createdAt,
            revision.workspaceId,
            idempotencyKey,
            requestHash,
            context.claimToken,
            revision.assetId,
            revision.crop === null ? null : JSON.stringify(revision.crop),
          ),
        database
          .prepare(
            `INSERT INTO media_mutation_receipts (
               site_id, idempotency_key, request_hash, result_json, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM media_occurrences
               WHERE site_id = ?1 AND workspace_id = ?8
                 AND occurrence_id = ?6 AND current_revision = ?7
             )
               AND EXISTS (
                 SELECT 1 FROM media_occurrence_revisions
                 WHERE site_id = ?1 AND workspace_id = ?8
                   AND occurrence_id = ?6 AND revision = ?7
                   AND asset_id = ?10 AND crop_json IS ?11
                   AND created_at = ?5 AND created_by = ?12
               )
               AND EXISTS (
               SELECT 1 FROM media_mutation_claims
               WHERE site_id = ?1 AND idempotency_key = ?2
                   AND request_hash = ?3 AND claim_token = ?9
               )
             ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
          )
          .bind(
            revision.siteId,
            idempotencyKey,
            requestHash,
            JSON.stringify(mutationResult),
            revision.createdAt,
            revision.occurrenceId,
            revision.revision,
            revision.workspaceId,
            context.claimToken,
            revision.assetId,
            revision.crop === null ? null : JSON.stringify(revision.crop),
            revision.createdBy,
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        const replay = await this.replay(context);
        if (replay?.kind === "occurrence") return replay.value;
        if ((await getAsset(revision.siteId, revision.assetId)) === null) {
          throw new MediaSiteAccessError();
        }
        const current = await database
          .prepare(
            `SELECT current_revision
             FROM media_occurrences
             WHERE site_id = ?1 AND workspace_id = ?2
               AND occurrence_id = ?3`,
          )
          .bind(
            revision.siteId,
            revision.workspaceId,
            revision.occurrenceId,
          )
          .first<{ current_revision: number }>();
        throw new MediaOccurrenceConflictError(current?.current_revision ?? 0);
      }
      return revision;
    },
    async beginAssetDeletion(siteId, assetId, context) {
      const existing = await getStoredAsset(siteId, assetId);
      if (existing === null) throw new MediaSiteAccessError();
      const result = await database
        .prepare(
          `INSERT INTO media_asset_deletions (
             site_id, asset_id, idempotency_key, request_hash, reserved_at
           )
           SELECT ?1, ?2, ?3, ?4, datetime('now')
           WHERE NOT EXISTS (
             SELECT 1 FROM media_occurrence_revisions
             WHERE site_id = ?1 AND asset_id = ?2
           )
             AND EXISTS (
               SELECT 1 FROM media_mutation_claims
               WHERE site_id = ?1 AND idempotency_key = ?3
                 AND request_hash = ?4 AND claim_token = ?5
             )
           ON CONFLICT (site_id, asset_id) DO NOTHING`,
        )
        .bind(
          siteId,
          assetId,
          context.idempotencyKey,
          context.requestHash,
          context.claimToken,
        )
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        const reserved = await database
          .prepare(
            `SELECT idempotency_key, request_hash FROM media_asset_deletions
             WHERE site_id = ?1 AND asset_id = ?2`,
          )
          .bind(siteId, assetId)
          .first<{ idempotency_key: string; request_hash: string }>();
        if (reserved === null) {
          const references = await database
            .prepare(
              `SELECT COUNT(*) AS count
               FROM (
                 SELECT workspace_id, occurrence_id
                 FROM media_occurrence_revisions
                 WHERE site_id = ?1 AND asset_id = ?2
                 GROUP BY workspace_id, occurrence_id
               )`,
            )
            .bind(siteId, assetId)
            .first<{ count: number }>();
          throw new MediaAssetReferencedError(assetId, references?.count ?? 0);
        }
        if (
          reserved.idempotency_key !== context.idempotencyKey ||
          reserved.request_hash !== context.requestHash
        ) {
          const adopted = await database
            .prepare(
              `UPDATE media_asset_deletions
               SET idempotency_key = ?3, request_hash = ?4,
                   reserved_at = datetime('now')
               WHERE site_id = ?1 AND asset_id = ?2
                 AND idempotency_key = ?6 AND request_hash = ?7
                 AND NOT EXISTS (
                   SELECT 1 FROM media_mutation_receipts
                   WHERE site_id = ?1 AND idempotency_key = ?6
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM media_mutation_claims
                   WHERE site_id = ?1 AND idempotency_key = ?6
                     AND claimed_at > datetime('now', '-30 seconds')
                 )
                 AND EXISTS (
                   SELECT 1 FROM media_mutation_claims
                   WHERE site_id = ?1 AND idempotency_key = ?3
                     AND request_hash = ?4 AND claim_token = ?5
                 )`,
            )
            .bind(
              siteId,
              assetId,
              context.idempotencyKey,
              context.requestHash,
              context.claimToken,
              reserved.idempotency_key,
              reserved.request_hash,
            )
            .run();
          if ((adopted.meta.changes ?? 0) === 0) {
            throw new MediaSiteAccessError();
          }
        }
      }
      return existing;
    },
    async tombstoneAssetDeletion(
      siteId,
      assetId,
      actorId,
      occurredAt,
      context,
    ) {
      const results = await database.batch([
        database
          .prepare(
            `UPDATE media_assets
             SET deleted_at = COALESCE(deleted_at, ?3)
             WHERE site_id = ?1 AND asset_id = ?2
               AND EXISTS (
                 SELECT 1 FROM media_asset_deletions
                 WHERE site_id = ?1 AND asset_id = ?2
                   AND idempotency_key = ?4 AND request_hash = ?5
               )
               AND EXISTS (
                 SELECT 1 FROM media_mutation_claims
                 WHERE site_id = ?1 AND idempotency_key = ?4
                   AND request_hash = ?5 AND claim_token = ?6
               )`,
          )
          .bind(
            siteId,
            assetId,
            occurredAt,
            context.idempotencyKey,
            context.requestHash,
            context.claimToken,
          ),
        database
          .prepare(
            `INSERT OR IGNORE INTO media_audit_events (
               site_id, actor_id, action, subject_id,
               subject_revision, occurred_at
             )
             SELECT ?1, ?2, 'media.asset.deleted', ?3, NULL, ?4
             WHERE EXISTS (
                 SELECT 1 FROM media_asset_deletions
                 WHERE site_id = ?1 AND asset_id = ?3
                   AND idempotency_key = ?5 AND request_hash = ?6
               )
               AND EXISTS (
                 SELECT 1 FROM media_mutation_claims
                 WHERE site_id = ?1 AND idempotency_key = ?5
                   AND request_hash = ?6 AND claim_token = ?7
               )`,
          )
          .bind(
            siteId,
            actorId,
            assetId,
            occurredAt,
            context.idempotencyKey,
            context.requestHash,
            context.claimToken,
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        throw new MediaSiteAccessError();
      }
    },
    async completeAssetDeletion(
      siteId,
      assetId,
      occurredAt,
      context,
    ) {
      const { idempotencyKey, requestHash } = context;
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO media_mutation_receipts (
               site_id, idempotency_key, request_hash, result_json, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM media_asset_deletions
               WHERE site_id = ?1 AND asset_id = ?7
                 AND idempotency_key = ?2 AND request_hash = ?3
             )
               AND EXISTS (
                 SELECT 1 FROM media_assets
                 WHERE site_id = ?1 AND asset_id = ?7
                   AND deleted_at IS NOT NULL
               )
               AND EXISTS (
               SELECT 1 FROM media_mutation_claims
               WHERE site_id = ?1 AND idempotency_key = ?2
                 AND request_hash = ?3 AND claim_token = ?6
             )
             ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
          )
          .bind(
            siteId,
            idempotencyKey,
            requestHash,
            JSON.stringify({ kind: "deleted", assetId }),
            occurredAt,
            context.claimToken,
            assetId,
          ),
        database
          .prepare(
            `DELETE FROM media_asset_deletions
             WHERE site_id = ?1 AND asset_id = ?2
               AND idempotency_key = ?3 AND request_hash = ?4
               AND EXISTS (
                 SELECT 1 FROM media_assets
                 WHERE site_id = ?1 AND asset_id = ?2
                   AND deleted_at IS NOT NULL
               )
               AND EXISTS (
                 SELECT 1 FROM media_mutation_claims
                 WHERE site_id = ?1 AND idempotency_key = ?3
                   AND request_hash = ?4 AND claim_token = ?5
               )`,
          )
          .bind(
            siteId,
            assetId,
            context.idempotencyKey,
            context.requestHash,
            context.claimToken,
          ),
      ]);
      if (
        (results[0]?.meta.changes ?? 0) === 0 ||
        (results[1]?.meta.changes ?? 0) === 0
      ) {
        const replay = await this.replay(context);
        if (replay?.kind === "deleted") return;
        throw new MediaSiteAccessError();
      }
    },
    async audit(siteId) {
      const rows = await database
        .prepare(
          `SELECT site_id, workspace_id, actor_id, action, subject_id, occurred_at
           FROM media_audit_events
           WHERE site_id = ?1
           ORDER BY id`,
        )
        .bind(siteId)
        .all<{
          site_id: SiteId;
          workspace_id: string | null;
          actor_id: string;
          action: MediaAuditAction;
          subject_id: string;
          occurred_at: string;
        }>();
      return rows.results.map(
        (row): MediaAuditEvent => ({
          siteId: row.site_id,
          workspaceId:
            row.workspace_id === null
              ? null
              : (row.workspace_id as ContentWorkspaceId),
          actorId: restoreContentActorId(row.actor_id),
          action: row.action,
          subjectId: row.subject_id,
          occurredAt: row.occurred_at,
        }),
      );
    },
  };
}

import {
  MediaAssetReferencedError,
  MediaOccurrenceConflictError,
  MediaSiteAccessError,
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
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

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
};

type OccurrenceRow = {
  site_id: SiteId;
  occurrence_id: string;
  revision: number;
  asset_id: string;
  crop_json: string | null;
  created_at: string;
  created_by: string;
};

const assetProjection = `
  SELECT site_id, asset_id, object_key, source_hash, file_name, content_type,
         byte_length, width, height, created_at, created_by
  FROM media_assets
`;

const occurrenceProjection = `
  SELECT site_id, occurrence_id, revision, asset_id, crop_json,
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
    }) };
  }
  if (parsed.kind === "occurrence") {
    return {
      kind: "occurrence",
      value: toOccurrence({
        site_id: parsed.value.siteId,
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
  async function getAsset(siteId: SiteId, assetId: MediaAssetId) {
    const row = await database
      .prepare(`${assetProjection} WHERE site_id = ?1 AND asset_id = ?2`)
      .bind(siteId, assetId)
      .first<AssetRow>();
    return row === null ? null : toAsset(row);
  }

  async function getOccurrenceRevision(
    siteId: SiteId,
    occurrenceId: MediaOccurrenceId,
    revision: number,
  ) {
    const row = await database
      .prepare(
        `${occurrenceProjection}
         WHERE site_id = ?1 AND occurrence_id = ?2 AND revision = ?3`,
      )
      .bind(siteId, occurrenceId, revision)
      .first<OccurrenceRow>();
    return row === null ? null : toOccurrence(row);
  }

  return {
    async claim(siteId, idempotencyKey, requestHash) {
      const claimed = await database
        .prepare(
          `INSERT INTO media_mutation_claims (
             site_id, idempotency_key, request_hash, claimed_at
           ) VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
        )
        .bind(siteId, idempotencyKey, requestHash)
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
      }
    },
    async replay(siteId, idempotencyKey, requestHash) {
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
    async record(siteId, idempotencyKey, requestHash, result) {
      const saved = await database
        .prepare(
          `INSERT INTO media_mutation_receipts (
             site_id, idempotency_key, request_hash, result_json, created_at
           ) VALUES (?1, ?2, ?3, ?4, datetime('now'))
           ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
        )
        .bind(siteId, idempotencyKey, requestHash, JSON.stringify(result))
        .run();
      if ((saved.meta.changes ?? 0) === 0) {
        const replay = await this.replay(siteId, idempotencyKey, requestHash);
        if (replay === null) throw new MediaSiteAccessError();
      }
    },
    getAsset,
    async listAssets(siteId) {
      const rows = await database
        .prepare(`${assetProjection} WHERE site_id = ?1 ORDER BY created_at, asset_id`)
        .bind(siteId)
        .all<AssetRow>();
      return rows.results.map(toAsset);
    },
    async listOccurrences(siteId) {
      const rows = await database
        .prepare(
          `${occurrenceProjection}
           WHERE site_id = ?1
             AND revision = (
               SELECT current_revision
               FROM media_occurrences
               WHERE site_id = ?1
                 AND occurrence_id = media_occurrence_revisions.occurrence_id
             )
           ORDER BY occurrence_id`,
        )
        .bind(siteId)
        .all<OccurrenceRow>();
      return rows.results.map(toOccurrence);
    },
    async auditRead(siteId, actorId, action, subjectId, occurredAt) {
      await database
        .prepare(
          `INSERT INTO media_audit_events (
             site_id, actor_id, action, subject_id,
             subject_revision, occurred_at
           ) VALUES (?1, ?2, ?3, ?4, NULL, ?5)`,
        )
        .bind(siteId, actorId, action, subjectId, occurredAt)
        .run();
    },
    async createAsset(asset, idempotencyKey, requestHash) {
      const result: MediaMutationResult = { kind: "asset", value: asset };
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO media_assets (
               site_id, asset_id, object_key, source_hash, file_name, content_type,
               byte_length, width, height, created_at, created_by
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
          ),
        database
          .prepare(
            `INSERT OR IGNORE INTO media_audit_events (
               site_id, actor_id, action, subject_id,
               subject_revision, occurred_at
             ) VALUES (?1, ?2, 'media.asset.uploaded', ?3, NULL, ?4)`,
          )
          .bind(
            asset.siteId,
            asset.createdBy,
            asset.assetId,
            asset.createdAt,
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
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        const existing = await getAsset(asset.siteId, asset.assetId);
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
        await this.record(asset.siteId, idempotencyKey, requestHash, {
          kind: "asset",
          value: existing,
        });
        return existing;
      }
      return asset;
    },
    async getOccurrence(siteId, occurrenceId) {
      const row = await database
        .prepare(
          `${occurrenceProjection}
           WHERE site_id = ?1
             AND occurrence_id = ?2
             AND revision = (
               SELECT current_revision
               FROM media_occurrences
               WHERE site_id = ?1 AND occurrence_id = ?2
             )`,
        )
        .bind(siteId, occurrenceId)
        .first<OccurrenceRow>();
      return row === null ? null : toOccurrence(row);
    },
    getOccurrenceRevision,
    async saveOccurrence(
      revision,
      baseRevision,
      action,
      idempotencyKey,
      requestHash,
    ) {
      const mutationResult: MediaMutationResult = {
        kind: "occurrence",
        value: revision,
      };
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO media_occurrence_revisions (
               site_id, occurrence_id, revision, asset_id, crop_json,
               created_at, created_by
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
             WHERE EXISTS (
               SELECT 1 FROM media_assets
               WHERE site_id = ?1 AND asset_id = ?4
             )
               AND NOT EXISTS (
                 SELECT 1 FROM media_asset_deletions
                 WHERE site_id = ?1 AND asset_id = ?4
               )
               AND (
                 (?8 = 0 AND NOT EXISTS (
                   SELECT 1 FROM media_occurrences
                   WHERE site_id = ?1 AND occurrence_id = ?2
                 ))
                 OR EXISTS (
                   SELECT 1 FROM media_occurrences
                   WHERE site_id = ?1 AND occurrence_id = ?2
                     AND current_revision = ?8
                 )
               )`,
          )
          .bind(
            revision.siteId,
            revision.occurrenceId,
            revision.revision,
            revision.assetId,
            revision.crop === null ? null : JSON.stringify(revision.crop),
            revision.createdAt,
            revision.createdBy,
            baseRevision,
          ),
        database
          .prepare(
            `INSERT INTO media_occurrences (
               site_id, occurrence_id, current_revision, current_asset_id
             )
             SELECT ?1, ?2, ?3, ?4
             WHERE EXISTS (
               SELECT 1 FROM media_occurrence_revisions
               WHERE site_id = ?1 AND occurrence_id = ?2 AND revision = ?3
             )
             ON CONFLICT (site_id, occurrence_id) DO UPDATE SET
               current_revision = excluded.current_revision,
               current_asset_id = excluded.current_asset_id
             WHERE media_occurrences.current_revision = ?5`,
          )
          .bind(
            revision.siteId,
            revision.occurrenceId,
            revision.revision,
            revision.assetId,
            baseRevision,
          ),
        database
          .prepare(
            `INSERT OR IGNORE INTO media_audit_events (
               site_id, actor_id, action, subject_id,
               subject_revision, occurred_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
             WHERE EXISTS (
               SELECT 1 FROM media_occurrences
               WHERE site_id = ?1 AND occurrence_id = ?4
                 AND current_revision = ?5
             )`,
          )
          .bind(
            revision.siteId,
            revision.createdBy,
            action,
            revision.occurrenceId,
            revision.revision,
            revision.createdAt,
          ),
        database
          .prepare(
            `INSERT INTO media_mutation_receipts (
               site_id, idempotency_key, request_hash, result_json, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM media_occurrences
               WHERE site_id = ?1 AND occurrence_id = ?6
                 AND current_revision = ?7
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
          ),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        if ((await getAsset(revision.siteId, revision.assetId)) === null) {
          throw new MediaSiteAccessError();
        }
        const current = await database
          .prepare(
            `SELECT current_revision
             FROM media_occurrences
             WHERE site_id = ?1 AND occurrence_id = ?2`,
          )
          .bind(revision.siteId, revision.occurrenceId)
          .first<{ current_revision: number }>();
        throw new MediaOccurrenceConflictError(current?.current_revision ?? 0);
      }
      return revision;
    },
    async beginAssetDeletion(siteId, assetId) {
      const existing = await getAsset(siteId, assetId);
      if (existing === null) throw new MediaSiteAccessError();
      const result = await database
        .prepare(
          `INSERT INTO media_asset_deletions (site_id, asset_id, reserved_at)
           SELECT ?1, ?2, datetime('now')
           WHERE NOT EXISTS (
             SELECT 1 FROM media_occurrence_revisions
             WHERE site_id = ?1 AND asset_id = ?2
           )
           ON CONFLICT (site_id, asset_id) DO NOTHING`,
        )
        .bind(siteId, assetId)
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        const reserved = await database
          .prepare(
            `SELECT 1 AS reserved FROM media_asset_deletions
             WHERE site_id = ?1 AND asset_id = ?2`,
          )
          .bind(siteId, assetId)
          .first<{ reserved: number }>();
        if (reserved === null) {
          const references = await database
            .prepare(
              `SELECT COUNT(DISTINCT occurrence_id) AS count
               FROM media_occurrence_revisions
               WHERE site_id = ?1 AND asset_id = ?2`,
            )
            .bind(siteId, assetId)
            .first<{ count: number }>();
          throw new MediaAssetReferencedError(assetId, references?.count ?? 0);
        }
      }
      return existing;
    },
    async completeAssetDeletion(
      siteId,
      assetId,
      actorId,
      occurredAt,
      idempotencyKey,
      requestHash,
    ) {
      const results = await database.batch([
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
             )`,
          )
          .bind(siteId, actorId, assetId, occurredAt),
        database
          .prepare(
            `DELETE FROM media_asset_deletions
             WHERE site_id = ?1 AND asset_id = ?2`,
          )
          .bind(siteId, assetId),
        database
          .prepare(
            `DELETE FROM media_assets
             WHERE site_id = ?1 AND asset_id = ?2`,
          )
          .bind(siteId, assetId),
        database
          .prepare(
            `INSERT INTO media_mutation_receipts (
               site_id, idempotency_key, request_hash, result_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (site_id, idempotency_key) DO NOTHING`,
          )
          .bind(
            siteId,
            idempotencyKey,
            requestHash,
            JSON.stringify({ kind: "deleted", assetId }),
            occurredAt,
          ),
      ]);
      if ((results[2]?.meta.changes ?? 0) === 0) {
        throw new MediaSiteAccessError();
      }
    },
    async audit(siteId) {
      const rows = await database
        .prepare(
          `SELECT site_id, actor_id, action, subject_id, occurred_at
           FROM media_audit_events
           WHERE site_id = ?1
           ORDER BY id`,
        )
        .bind(siteId)
        .all<{
          site_id: SiteId;
          actor_id: string;
          action: MediaAuditAction;
          subject_id: string;
          occurred_at: string;
        }>();
      return rows.results.map(
        (row): MediaAuditEvent => ({
          siteId: row.site_id,
          actorId: restoreContentActorId(row.actor_id),
          action: row.action,
          subjectId: row.subject_id,
          occurredAt: row.occurred_at,
        }),
      );
    },
  };
}

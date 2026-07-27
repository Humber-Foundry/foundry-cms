import type {
  ContentRevision,
  ContentRevisionStore,
} from "@foundry/application";
import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
} from "@foundry/application";
import type { SiteDefinition, SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type RevisionRow = {
  revision: number;
  definition_json: string;
  content_hash: string;
  schema_version: SiteDefinition["schemaVersion"];
  renderer_version: string;
  production_base: string;
  created_at: string;
  created_by: string;
};

type ReceiptRow = {
  request_hash: string;
  revision: number;
};

function toRevision(row: RevisionRow): ContentRevision {
  return {
    revision: row.revision,
    definition: JSON.parse(row.definition_json) as SiteDefinition,
    inputs: {
      contentHash: row.content_hash,
      schemaVersion: row.schema_version,
      rendererVersion: row.renderer_version,
      productionBase: row.production_base,
    },
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

const revisionProjection = `
  SELECT
    revision,
    definition_json,
    content_hash,
    schema_version,
    renderer_version,
    production_base,
    created_at,
    created_by
  FROM content_revisions
`;

export function createD1ContentRevisionStore(
  database: D1DatabaseBinding,
  siteId: SiteId,
): ContentRevisionStore {
  async function findReceipt(idempotencyKey: string) {
    return database
      .prepare(
        `SELECT request_hash, revision
         FROM content_revision_receipts
         WHERE idempotency_key = ?1 AND site_id = ?2`,
      )
      .bind(idempotencyKey, siteId)
      .first<ReceiptRow>();
  }

  async function getRevision(revision: number) {
    const row = await database
      .prepare(
        `${revisionProjection}
         WHERE site_id = ?1 AND revision = ?2`,
      )
      .bind(siteId, revision)
      .first<RevisionRow>();
    return row === null ? null : toRevision(row);
  }

  async function getCurrent() {
    const row = await database
      .prepare(
        `${revisionProjection}
         WHERE site_id = ?1
           AND revision = (
             SELECT current_revision
             FROM content_workspaces
             WHERE site_id = ?1
           )`,
      )
      .bind(siteId)
      .first<RevisionRow>();
    if (row === null) {
      throw new Error("content_workspace_not_initialized");
    }
    return toRevision(row);
  }

  return {
    async initialize(initialRevision) {
      await database.batch([
        database
          .prepare(
            `INSERT INTO content_workspaces (
               site_id, current_revision, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT (site_id) DO NOTHING`,
          )
          .bind(
            siteId,
            initialRevision.revision,
            initialRevision.createdAt,
          ),
        database
          .prepare(
            `INSERT INTO content_revisions (
               site_id, revision, definition_json, content_hash,
               schema_version, renderer_version, production_base,
               created_at, created_by
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
             WHERE NOT EXISTS (
               SELECT 1 FROM content_revisions
               WHERE site_id = ?1 AND revision = ?2
             )`,
          )
          .bind(
            siteId,
            initialRevision.revision,
            JSON.stringify(initialRevision.definition),
            initialRevision.inputs.contentHash,
            initialRevision.inputs.schemaVersion,
            initialRevision.inputs.rendererVersion,
            initialRevision.inputs.productionBase,
            initialRevision.createdAt,
            initialRevision.createdBy,
          ),
      ]);
    },
    getCurrent,
    getRevision,
    async persist(command) {
      const existing = await findReceipt(command.idempotencyKey);
      if (existing !== null) {
        if (existing.request_hash !== command.requestHash) {
          throw new ContentRevisionIdempotencyError();
        }
        return (await getRevision(existing.revision))!;
      }

      const current = await getCurrent();
      if (current.revision !== command.baseRevision) {
        throw new ContentRevisionConflictError(current.revision);
      }

      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO content_revisions (
               site_id, revision, definition_json, content_hash,
               schema_version, renderer_version, production_base,
               created_at, created_by
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
             WHERE EXISTS (
               SELECT 1 FROM content_workspaces
               WHERE site_id = ?1 AND current_revision = ?10
             )
             AND NOT EXISTS (
               SELECT 1 FROM content_revision_receipts
               WHERE idempotency_key = ?11
             )`,
          )
          .bind(
            siteId,
            command.revision.revision,
            JSON.stringify(command.revision.definition),
            command.revision.inputs.contentHash,
            command.revision.inputs.schemaVersion,
            command.revision.inputs.rendererVersion,
            command.revision.inputs.productionBase,
            command.revision.createdAt,
            command.revision.createdBy,
            command.baseRevision,
            command.idempotencyKey,
          ),
        database
          .prepare(
            `UPDATE content_workspaces
             SET current_revision = ?1, updated_at = ?2
             WHERE site_id = ?3
               AND current_revision = ?4
               AND EXISTS (
                 SELECT 1 FROM content_revisions
                 WHERE site_id = ?3 AND revision = ?1
               )`,
          )
          .bind(
            command.revision.revision,
            command.revision.createdAt,
            siteId,
            command.baseRevision,
          ),
        database
          .prepare(
            `INSERT INTO content_revision_receipts (
               idempotency_key, site_id, request_hash, revision, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM content_workspaces
               WHERE site_id = ?2 AND current_revision = ?4
             )
             ON CONFLICT (idempotency_key) DO NOTHING`,
          )
          .bind(
            command.idempotencyKey,
            siteId,
            command.requestHash,
            command.revision.revision,
            command.revision.createdAt,
          ),
      ]);

      if ((results[2]?.meta.changes ?? 0) > 0) {
        return command.revision;
      }
      const racedReceipt = await findReceipt(command.idempotencyKey);
      if (racedReceipt !== null) {
        if (racedReceipt.request_hash !== command.requestHash) {
          throw new ContentRevisionIdempotencyError();
        }
        return (await getRevision(racedReceipt.revision))!;
      }
      throw new ContentRevisionConflictError(
        (await getCurrent()).revision,
      );
    },
  };
}

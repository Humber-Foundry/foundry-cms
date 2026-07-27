import type {
  ContentActorId,
  ContentRevision,
  ContentRevisionStore,
  ContentWorkspaceId,
} from "@foundry/application";
import {
  ContentRevisionConfigurationError,
  ContentRevisionBookmarkError,
  ContentRevisionConflictError,
  ContentWorkspaceAccessError,
  createContentWorkspaceId,
  restoreContentActorId,
  assertContentRevisionBase,
  assertContentRevisionIdempotency,
  withContentRevisionBookmark,
} from "@foundry/application";
import type { SiteDefinition, SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

export async function findLatestContentWorkspaceIdForActor(
  database: D1DatabaseBinding,
  siteId: SiteId,
  actorId: ContentActorId,
): Promise<ContentWorkspaceId | null> {
  const row = await database
    .prepare(
      `SELECT workspace.workspace_id
       FROM content_workspaces AS workspace
       WHERE workspace.site_id = ?1
         AND workspace.lifecycle = 'open'
         AND (
           workspace.owner_actor_id = ?2
           OR EXISTS (
             SELECT 1
             FROM content_workspace_collaborators AS collaborator
             WHERE collaborator.workspace_id = workspace.workspace_id
               AND collaborator.actor_id = ?2
           )
         )
       ORDER BY workspace.updated_at DESC, workspace.workspace_id DESC
       LIMIT 1`,
    )
    .bind(siteId, actorId)
    .first<{ workspace_id: string }>();
  return row === null
    ? null
    : createContentWorkspaceId(row.workspace_id);
}

type RevisionRow = {
  workspace_id: ContentWorkspaceId;
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
    workspaceId: row.workspace_id,
    revision: row.revision,
    definition: JSON.parse(row.definition_json) as SiteDefinition,
    inputs: {
      contentHash: row.content_hash,
      schemaVersion: row.schema_version,
      rendererVersion: row.renderer_version,
      productionBase: row.production_base,
    },
    createdAt: row.created_at,
    createdBy: restoreContentActorId(row.created_by),
  };
}

const revisionProjection = `
  SELECT
    workspace_id,
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

function requireBookmark(bookmark: string | null): string {
  if (bookmark === null) {
    throw new ContentRevisionConfigurationError();
  }
  return bookmark;
}

export function createD1ContentRevisionStore(
  database: D1DatabaseBinding,
  siteId: SiteId,
  workspaceId: ContentWorkspaceId,
): ContentRevisionStore {
  async function findReceipt(
    connection: Pick<D1DatabaseBinding, "prepare">,
    idempotencyKey: string,
  ) {
    return connection
      .prepare(
        `SELECT request_hash, revision
         FROM content_revision_receipts
         WHERE idempotency_key = ?1 AND workspace_id = ?2`,
      )
      .bind(idempotencyKey, workspaceId)
      .first<ReceiptRow>();
  }

  async function getRevisionFrom(
    connection: Pick<D1DatabaseBinding, "prepare">,
    revision: number,
  ) {
    const row = await connection
      .prepare(
        `${revisionProjection}
         WHERE workspace_id = ?1 AND revision = ?2`,
      )
      .bind(workspaceId, revision)
      .first<RevisionRow>();
    return row === null ? null : toRevision(row);
  }

  async function getCurrentFrom(
    connection: Pick<D1DatabaseBinding, "prepare">,
  ) {
    const row = await connection
      .prepare(
        `${revisionProjection}
         WHERE workspace_id = ?1
           AND revision = (
             SELECT current_revision
             FROM content_workspaces
             WHERE workspace_id = ?1
           )`,
      )
      .bind(workspaceId)
      .first<RevisionRow>();
    if (row === null) {
      throw new Error("content_workspace_not_initialized");
    }
    return toRevision(row);
  }

  return {
    async initialize(initialRevision, ownerActorId) {
      await database.batch([
        database
          .prepare(
            `INSERT INTO content_workspaces (
               workspace_id, site_id, owner_actor_id,
               production_base, schema_version, renderer_version,
               current_revision, current_content_hash, lifecycle,
               created_at, updated_at
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9, ?9
             )
             ON CONFLICT (workspace_id) DO NOTHING`,
          )
          .bind(
            workspaceId,
            siteId,
            ownerActorId,
            initialRevision.inputs.productionBase,
            initialRevision.inputs.schemaVersion,
            initialRevision.inputs.rendererVersion,
            initialRevision.revision,
            initialRevision.inputs.contentHash,
            initialRevision.createdAt,
          ),
        database
          .prepare(
            `INSERT INTO content_revisions (
               workspace_id, revision, definition_json, content_hash,
               schema_version, renderer_version, production_base,
               request_hash, created_at, created_by
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
             WHERE NOT EXISTS (
               SELECT 1 FROM content_revisions
               WHERE workspace_id = ?1 AND revision = ?2
             )`,
          )
          .bind(
            workspaceId,
            initialRevision.revision,
            JSON.stringify(initialRevision.definition),
            initialRevision.inputs.contentHash,
            initialRevision.inputs.schemaVersion,
            initialRevision.inputs.rendererVersion,
            initialRevision.inputs.productionBase,
            "system:published-base",
            initialRevision.createdAt,
            initialRevision.createdBy,
          ),
      ]);
    },
    async requireAccess(actorId) {
      const access = await database
        .prepare(
          `SELECT 1 AS allowed
           FROM content_workspaces AS workspace
           WHERE workspace.workspace_id = ?1
             AND (
               workspace.owner_actor_id = ?2
               OR EXISTS (
                 SELECT 1
                 FROM content_workspace_collaborators AS collaborator
                 WHERE collaborator.workspace_id = workspace.workspace_id
                   AND collaborator.actor_id = ?2
               )
             )`,
        )
        .bind(workspaceId, actorId)
        .first<{ allowed: number }>();
      if (access === null) {
        throw new ContentWorkspaceAccessError();
      }
    },
    async addCollaborator(ownerActorId, collaboratorActorId) {
      const result = await database
        .prepare(
          `INSERT INTO content_workspace_collaborators (
             workspace_id, actor_id, added_at
           )
           SELECT workspace_id, ?2, datetime('now')
           FROM content_workspaces
           WHERE workspace_id = ?1 AND owner_actor_id = ?3
           ON CONFLICT (workspace_id, actor_id) DO NOTHING`,
        )
        .bind(workspaceId, collaboratorActorId, ownerActorId)
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        const owner = await database
          .prepare(
            `SELECT 1 AS allowed
             FROM content_workspaces
             WHERE workspace_id = ?1 AND owner_actor_id = ?2`,
          )
          .bind(workspaceId, ownerActorId)
          .first<{ allowed: number }>();
        if (owner === null) {
          throw new ContentWorkspaceAccessError();
        }
      }
    },
    async getCurrent() {
      const connection =
        database.withSession?.("first-primary") ?? database;
      return getCurrentFrom(connection);
    },
    async getRevision(revision, bookmark) {
      if (bookmark === undefined) {
        return getRevisionFrom(database, revision);
      }
      try {
        const connection = database.withSession?.(bookmark);
        if (connection === undefined) {
          throw new ContentRevisionBookmarkError();
        }
        return await getRevisionFrom(connection, revision);
      } catch {
        throw new ContentRevisionBookmarkError();
      }
    },
    async getRevisionWithBookmark(revision) {
      if (database.withSession === undefined) {
        throw new Error("content_revision_sessions_unavailable");
      }
      const session = database.withSession("first-primary");
      const saved = await getRevisionFrom(session, revision);
      return saved === null
        ? null
        : withContentRevisionBookmark(
            saved,
            requireBookmark(session.getBookmark()),
          );
    },
    async replay(idempotencyKey, requestHash) {
      if (database.withSession === undefined) {
        throw new Error("content_revision_sessions_unavailable");
      }
      const session = database.withSession("first-primary");
      const receipt = await findReceipt(session, idempotencyKey);
      if (receipt === null) {
        return null;
      }
      assertContentRevisionIdempotency(receipt.request_hash, requestHash);
      const revision = await getRevisionFrom(session, receipt.revision);
      if (revision === null) {
        throw new ContentRevisionConfigurationError();
      }
      return withContentRevisionBookmark(
        revision,
        requireBookmark(session.getBookmark()),
      );
    },
    async persist(command) {
      if (database.withSession === undefined) {
        throw new Error("content_revision_sessions_unavailable");
      }
      const session = database.withSession("first-primary");
      const existing = await findReceipt(session, command.idempotencyKey);
      if (existing !== null) {
        assertContentRevisionIdempotency(
          existing.request_hash,
          command.requestHash,
        );
        const revision = (await getRevisionFrom(
          session,
          existing.revision,
        ))!;
        return withContentRevisionBookmark(
          revision,
          requireBookmark(session.getBookmark()),
        );
      }

      const current = await getCurrentFrom(session);
      if (command.baseRevision !== current.revision) {
        const racedReceipt = await findReceipt(
          session,
          command.idempotencyKey,
        );
        if (racedReceipt !== null) {
          assertContentRevisionIdempotency(
            racedReceipt.request_hash,
            command.requestHash,
          );
          const revision = await getRevisionFrom(
            session,
            racedReceipt.revision,
          );
          if (revision === null) {
            throw new ContentRevisionConfigurationError();
          }
          return withContentRevisionBookmark(
            revision,
            requireBookmark(session.getBookmark()),
          );
        }
      }
      assertContentRevisionBase(command.baseRevision, current.revision);

      const results = await session.batch([
        session
          .prepare(
            `INSERT INTO content_revisions (
               workspace_id, revision, definition_json, content_hash,
               schema_version, renderer_version, production_base,
               request_hash, created_at, created_by
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
             WHERE EXISTS (
               SELECT 1 FROM content_workspaces
               WHERE workspace_id = ?1 AND current_revision = ?11
             )
             AND NOT EXISTS (
               SELECT 1 FROM content_revision_receipts
               WHERE idempotency_key = ?12 AND workspace_id = ?1
             )`,
          )
          .bind(
            workspaceId,
            command.revision.revision,
            JSON.stringify(command.revision.definition),
            command.revision.inputs.contentHash,
            command.revision.inputs.schemaVersion,
            command.revision.inputs.rendererVersion,
            command.revision.inputs.productionBase,
            command.requestHash,
            command.revision.createdAt,
            command.revision.createdBy,
            command.baseRevision,
            command.idempotencyKey,
          ),
        session
          .prepare(
            `UPDATE content_workspaces
             SET current_revision = ?1,
                 current_content_hash = ?2,
                 updated_at = ?3
             WHERE workspace_id = ?4
               AND current_revision = ?5
               AND EXISTS (
                 SELECT 1 FROM content_revisions
                 WHERE workspace_id = ?4 AND revision = ?1
               )`,
          )
          .bind(
            command.revision.revision,
            command.revision.inputs.contentHash,
            command.revision.createdAt,
            workspaceId,
            command.baseRevision,
          ),
        session
          .prepare(
            `INSERT INTO content_revision_receipts (
               idempotency_key, workspace_id, request_hash, revision, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (
               SELECT 1 FROM content_workspaces
               WHERE workspace_id = ?2 AND current_revision = ?4
             )
             AND EXISTS (
               SELECT 1 FROM content_revisions
               WHERE workspace_id = ?2
                 AND revision = ?4
                 AND request_hash = ?3
             )
             ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
          )
          .bind(
            command.idempotencyKey,
            workspaceId,
            command.requestHash,
            command.revision.revision,
            command.revision.createdAt,
          ),
        session
          .prepare(
            `INSERT INTO content_revision_audit_events (
               workspace_id, revision, actor_id, event_type, occurred_at
             )
             SELECT ?1, ?2, ?3, 'content.revision.created', ?4
             WHERE EXISTS (
               SELECT 1 FROM content_revision_receipts
               WHERE idempotency_key = ?5
                 AND workspace_id = ?1
                 AND revision = ?2
             )
             ON CONFLICT (workspace_id, revision, event_type) DO NOTHING`,
          )
          .bind(
            workspaceId,
            command.revision.revision,
            command.revision.createdBy,
            command.revision.createdAt,
            command.idempotencyKey,
          ),
      ]);

      if ((results[2]?.meta.changes ?? 0) > 0) {
        return withContentRevisionBookmark(
          command.revision,
          requireBookmark(session.getBookmark()),
        );
      }
      const racedReceipt = await findReceipt(
        session,
        command.idempotencyKey,
      );
      if (racedReceipt !== null) {
        assertContentRevisionIdempotency(
          racedReceipt.request_hash,
          command.requestHash,
        );
        const revision = (await getRevisionFrom(
          session,
          racedReceipt.revision,
        ))!;
        return withContentRevisionBookmark(
          revision,
          requireBookmark(session.getBookmark()),
        );
      }
      throw new ContentRevisionConflictError(
        (await getCurrentFrom(session)).revision,
      );
    },
  };
}

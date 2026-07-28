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
import {
  isSiteDefinition,
  type BlogPost,
  type SiteDefinition,
  type SiteId,
  type StoredSiteDefinitionSchemaVersion,
} from "@foundry/site-definition";

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

export async function listContentRevisionContributors(
  database: D1DatabaseBinding,
  workspaceId: ContentWorkspaceId,
  revision: number,
): Promise<ReadonlyArray<ContentActorId>> {
  const rows = await database
    .prepare(
      `SELECT DISTINCT created_by
       FROM content_revisions
       WHERE workspace_id = ?1
         AND revision <= ?2
         AND created_by <> 'system:published-base'
       ORDER BY created_by`,
    )
    .bind(workspaceId, revision)
    .all<{ created_by: string }>();
  return rows.results.map((row) => restoreContentActorId(row.created_by));
}

export async function hydrateManagedBlogPosts(
  database: D1DatabaseBinding,
  definition: SiteDefinition,
): Promise<SiteDefinition> {
  const rows = await database
    .prepare(
      `SELECT revision.snapshot_json, post.last_verified_visibility
       FROM blog_posts AS post
       JOIN blog_post_revisions AS revision
         ON revision.site_id = post.site_id
        AND revision.post_id = post.post_id
        AND revision.revision = post.current_revision
         WHERE post.site_id = ?1
         AND post.live_revision IS NULL
         AND (
           (
             post.last_verified_visibility = 'unpublished'
             AND post.last_verified_revision = post.current_revision
           )
           OR post.last_verified_visibility = 'absent'
         )
       ORDER BY post.post_id`,
    )
    .bind(definition.site.id)
    .all<{
      snapshot_json: string;
      last_verified_visibility: "unpublished" | "absent";
    }>();
  const managed = rows.results.map(
    ({ snapshot_json, last_verified_visibility }) => {
      const post = JSON.parse(snapshot_json) as BlogPost;
      return last_verified_visibility === "absent"
        ? { ...post, visibility: "unpublished" as const }
        : post;
    },
  );
  const publishedIds = new Set(definition.blog.posts.map(({ id }) => id));
  const hydrated = {
    ...definition,
    blog: {
      ...definition.blog,
      posts: [
        ...definition.blog.posts,
        ...managed.filter(({ id }) => !publishedIds.has(id)),
      ],
    },
  };
  if (!isSiteDefinition(hydrated)) {
    throw new ContentRevisionConfigurationError();
  }
  return hydrated;
}

export async function reconcileVerifiedBlogPostPublication(
  database: D1DatabaseBinding,
  siteId: SiteId,
  definition: SiteDefinition,
  verifiedAt: string,
): Promise<void> {
  const presentPostIds = definition.blog.posts.map(({ id }) => id);
  const absentBindings = presentPostIds.map((_, index) => `?${index + 3}`);
  const absentPostGuard =
    absentBindings.length === 0
      ? ""
      : `AND post_id NOT IN (${absentBindings.join(", ")})`;
  const results = await database.batch([
    ...definition.blog.posts.map((post) =>
      database
        .prepare(
          `UPDATE blog_posts
           SET live_revision = ?1,
               last_verified_revision = ?2,
               last_verified_visibility = ?3,
               last_verified_at = ?4,
               updated_at = ?4
           WHERE site_id = ?5
             AND post_id = ?6
             AND (
               last_verified_at IS NULL
               OR last_verified_at <= ?4
             )`,
        )
        .bind(
          post.visibility === "public" ? post.revision : null,
          post.revision,
          post.visibility,
          verifiedAt,
          siteId,
          post.id,
        ),
    ),
    database
      .prepare(
        `UPDATE blog_posts
         SET live_revision = NULL,
             last_verified_visibility = 'absent',
             last_verified_at = ?1,
             updated_at = ?1
         WHERE site_id = ?2
           AND live_revision IS NOT NULL
           AND (
             last_verified_at IS NULL
             OR last_verified_at <= ?1
           )
           ${absentPostGuard}`,
      )
      .bind(verifiedAt, siteId, ...presentPostIds),
  ]);
  for (const [index, result] of results
    .slice(0, definition.blog.posts.length)
    .entries()) {
    if ((result.meta.changes ?? 0) > 0) {
      continue;
    }
    const post = definition.blog.posts[index]!;
    const aggregate = await database
      .prepare(
        `SELECT last_verified_revision, last_verified_at
         FROM blog_posts
         WHERE site_id = ?1 AND post_id = ?2`,
      )
      .bind(siteId, post.id)
      .first<{
        last_verified_revision: number | null;
        last_verified_at: string | null;
      }>();
    if (
      aggregate === null ||
      aggregate.last_verified_revision === null ||
      (
        aggregate.last_verified_revision < post.revision &&
        (aggregate.last_verified_at === null ||
          aggregate.last_verified_at <= verifiedAt)
      )
    ) {
      throw new ContentRevisionConfigurationError();
    }
  }
}

type RevisionRow = {
  workspace_id: ContentWorkspaceId;
  revision: number;
  definition_json: string;
  content_hash: string;
  schema_version: StoredSiteDefinitionSchemaVersion;
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
      const initialBlogStatements = initialRevision.definition.blog.posts
        .flatMap((post) => [
          database
            .prepare(
              `INSERT INTO blog_posts (
                 site_id, post_id, collection_state, current_revision,
                 live_revision, last_verified_revision,
                 last_verified_visibility, last_verified_at,
                 version, updated_at
               ) VALUES (?1, ?2, 'active', ?3, ?4, ?3, ?5, ?6, ?3, ?6)
               ON CONFLICT (site_id, post_id) DO NOTHING`,
            )
            .bind(
              siteId,
              post.id,
              post.revision,
              post.visibility === "public" ? post.revision : null,
              post.visibility,
              initialRevision.createdAt,
            ),
          database
            .prepare(
              `INSERT INTO blog_post_revisions (
                 revision_id, site_id, post_id, revision, workspace_id,
                 content_revision, snapshot_json, created_at, created_by
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT (site_id, post_id, revision) DO NOTHING`,
            )
            .bind(
              crypto.randomUUID(),
              siteId,
              post.id,
              post.revision,
              workspaceId,
              initialRevision.revision,
              JSON.stringify(post),
              initialRevision.createdAt,
              initialRevision.createdBy,
            ),
        ]);
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
        ...initialBlogStatements,
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
    async getBlogPostAggregate(postId) {
      const row = await database
        .prepare(
          `SELECT current_revision, live_revision,
                  last_verified_revision, last_verified_visibility, version
           FROM blog_posts
           WHERE site_id = ?1 AND post_id = ?2`,
        )
        .bind(siteId, postId)
        .first<{
          current_revision: number;
          live_revision: number | null;
          last_verified_revision: number | null;
          last_verified_visibility:
            | BlogPost["visibility"]
            | "absent"
            | null;
          version: number;
        }>();
      return row === null
        ? null
        : {
            currentRevision: row.current_revision,
            liveRevision: row.live_revision,
            lastVerifiedRevision: row.last_verified_revision,
            lastVerifiedVisibility: row.last_verified_visibility,
            version: row.version,
          };
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
    async recordRejectedBlogTransition(input) {
      await database
        .prepare(
          `INSERT INTO blog_post_transition_audit_events (
             workspace_id, actor_id, post_id, command_type, outcome,
             reason_code, request_id, before_state_json, after_state_json,
             revision, occurred_at
           ) VALUES (?1, ?2, ?3, ?4, 'rejected', ?5, ?6, ?7, ?8, NULL, ?9)
           ON CONFLICT (workspace_id, request_id, outcome, post_id)
           DO NOTHING`,
        )
        .bind(
          input.workspaceId,
          input.actorId,
          input.postId ?? "unknown",
          input.commandType,
          input.reasonCode,
          input.requestId,
          input.beforeState === null
            ? null
            : JSON.stringify(input.beforeState),
          input.afterState === null
            ? null
            : JSON.stringify(input.afterState),
          input.occurredAt,
        )
        .run();
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
      const mediaOccurrence = command.mediaOccurrence;
      const mediaCrop =
        mediaOccurrence?.crop === null || mediaOccurrence === undefined
          ? null
          : JSON.stringify(mediaOccurrence.crop);
      const blogGuardBindings: Array<string | number> = [];
      let blogGuardParameter = 18;
      const blogTransitionGuards = (command.blogTransitions ?? [])
        .map((transition) => {
          const postParameter = blogGuardParameter;
          blogGuardBindings.push(transition.postId);
          blogGuardParameter += 1;
          if (transition.beforeState === null) {
            return `AND NOT EXISTS (
              SELECT 1 FROM blog_posts
              WHERE site_id = ?14 AND post_id = ?${postParameter}
            )`;
          }
          const revisionParameter = blogGuardParameter;
          blogGuardBindings.push(transition.beforeState.revision);
          blogGuardParameter += 1;
          return `AND EXISTS (
            SELECT 1 FROM blog_posts
            WHERE site_id = ?14
              AND post_id = ?${postParameter}
              AND current_revision = ?${revisionParameter}
              AND collection_state = 'active'
          )`;
        })
        .join("\n");
      const blogPublicationGuard =
        !command.blogTransitions?.some(
          ({ commandType }) => commandType === "blog.post.unpublish",
        )
          ? ""
          : `AND NOT EXISTS (
              SELECT 1 FROM content_publications
              WHERE status IN (
                'requested', 'committed', 'building',
                'deployed', 'unknown'
              )
            )`;

      const blogTransitionStatements = (command.blogTransitions ?? []).map(
        (transition) =>
          session
            .prepare(
              `INSERT INTO blog_post_transition_audit_events (
                 workspace_id, actor_id, post_id, command_type, outcome,
                 reason_code, request_id, before_state_json, after_state_json,
                 revision, occurred_at
               )
               SELECT ?1, ?2, ?3, ?4, 'accepted', 'accepted', ?5,
                      ?6, ?7, ?8, ?9
               WHERE EXISTS (
                 SELECT 1 FROM content_revision_receipts
                 WHERE idempotency_key = ?5
                   AND workspace_id = ?1
                   AND revision = ?8
                   AND request_hash = ?10
               )
               ON CONFLICT (workspace_id, request_id, outcome, post_id)
               DO NOTHING`,
            )
            .bind(
              workspaceId,
              command.revision.createdBy,
              transition.postId,
              transition.commandType,
              command.idempotencyKey,
              transition.beforeState === null
                ? null
                : JSON.stringify(transition.beforeState),
              transition.afterState === null
                ? null
                : JSON.stringify(transition.afterState),
              command.revision.revision,
              command.revision.createdAt,
              command.requestHash,
            ),
      );
      const blogAggregateStatements = (command.blogTransitions ?? []).map(
        (transition) =>
          transition.beforeState === null
            ? session
                .prepare(
                  `INSERT INTO blog_posts (
                     site_id, post_id, collection_state, current_revision,
                     live_revision, last_verified_revision,
                     last_verified_visibility, last_verified_at,
                     version, updated_at
                   )
                   SELECT ?1, ?2, 'active', ?3, NULL, NULL, NULL, NULL, 1, ?4
                   WHERE EXISTS (
                     SELECT 1 FROM content_revision_receipts
                     WHERE idempotency_key = ?5
                       AND workspace_id = ?6
                       AND revision = ?7
                       AND request_hash = ?8
                   )
                   ON CONFLICT (site_id, post_id) DO NOTHING`,
                )
                .bind(
                  siteId,
                  transition.postId,
                  transition.afterState!.revision,
                  command.revision.createdAt,
                  command.idempotencyKey,
                  workspaceId,
                  command.revision.revision,
                  command.requestHash,
                )
            : session
                .prepare(
                  `UPDATE blog_posts
                   SET current_revision = ?1,
                       version = version + 1,
                       updated_at = ?2
                   WHERE site_id = ?3
                     AND post_id = ?4
                     AND current_revision = ?5
                     AND EXISTS (
                       SELECT 1 FROM content_revision_receipts
                       WHERE idempotency_key = ?6
                         AND workspace_id = ?7
                         AND revision = ?8
                         AND request_hash = ?9
                     )`,
                )
                .bind(
                  transition.afterState!.revision,
                  command.revision.createdAt,
                  siteId,
                  transition.postId,
                  transition.beforeState.revision,
                  command.idempotencyKey,
                  workspaceId,
                  command.revision.revision,
                  command.requestHash,
                ),
      );
      const blogRevisionStatements = (command.blogTransitions ?? []).map(
        (transition) => {
          const post = command.revision.definition.blog.posts.find(
            ({ id }) => id === transition.postId,
          );
          if (post === undefined) {
            throw new ContentRevisionConfigurationError();
          }
          return session
            .prepare(
              `INSERT INTO blog_post_revisions (
                 revision_id, site_id, post_id, revision, workspace_id,
                 content_revision, snapshot_json, created_at, created_by
               )
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
               WHERE EXISTS (
                 SELECT 1 FROM content_revision_receipts
                 WHERE idempotency_key = ?10
                   AND workspace_id = ?5
                   AND revision = ?6
                   AND request_hash = ?11
               )
               ON CONFLICT (site_id, post_id, revision) DO NOTHING`,
            )
            .bind(
              transition.revisionId,
              siteId,
              transition.postId,
              transition.afterState!.revision,
              workspaceId,
              command.revision.revision,
              JSON.stringify(post),
              command.revision.createdAt,
              command.revision.createdBy,
              command.idempotencyKey,
              command.requestHash,
            );
        },
      );
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
             )
             AND (
               ?13 IS NULL OR EXISTS (
                 SELECT 1
                 FROM media_occurrences AS media_head
                 JOIN media_occurrence_revisions AS media_revision
                   ON media_revision.site_id = media_head.site_id
                  AND media_revision.workspace_id = media_head.workspace_id
                  AND media_revision.occurrence_id = media_head.occurrence_id
                  AND media_revision.revision = media_head.current_revision
                 WHERE media_head.site_id = ?14
                   AND media_head.workspace_id = ?1
                   AND media_head.occurrence_id = ?13
                   AND media_head.current_revision = ?15
                   AND media_revision.asset_id = ?16
                   AND media_revision.crop_json IS ?17
               )
             )
             ${blogTransitionGuards}
             ${blogPublicationGuard}`,
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
            mediaOccurrence?.occurrenceId ?? null,
            siteId,
            mediaOccurrence?.revision ?? null,
            mediaOccurrence?.assetId ?? null,
            mediaCrop,
            ...blogGuardBindings,
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
                   AND request_hash = ?6
               )
               AND (
                 ?7 IS NULL OR EXISTS (
                   SELECT 1
                   FROM media_occurrences AS media_head
                   JOIN media_occurrence_revisions AS media_revision
                     ON media_revision.site_id = media_head.site_id
                    AND media_revision.workspace_id = media_head.workspace_id
                    AND media_revision.occurrence_id = media_head.occurrence_id
                    AND media_revision.revision = media_head.current_revision
                   WHERE media_head.site_id = ?8
                     AND media_head.workspace_id = ?4
                     AND media_head.occurrence_id = ?7
                     AND media_head.current_revision = ?9
                     AND media_revision.asset_id = ?10
                     AND media_revision.crop_json IS ?11
                 )
               )`,
          )
          .bind(
            command.revision.revision,
            command.revision.inputs.contentHash,
            command.revision.createdAt,
            workspaceId,
            command.baseRevision,
            command.requestHash,
            mediaOccurrence?.occurrenceId ?? null,
            siteId,
            mediaOccurrence?.revision ?? null,
            mediaOccurrence?.assetId ?? null,
            mediaCrop,
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
        ...blogAggregateStatements,
        ...blogRevisionStatements,
        ...blogTransitionStatements,
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

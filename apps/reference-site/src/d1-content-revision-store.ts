import type {
  BlogPostArtifactFingerprint,
  ContentActorId,
  ContentRevision,
  ContentRevisionStore,
  ContentWorkspaceId,
  JoinedMcpMutationAudit,
  JoinedMcpMutationResult,
} from "@foundry/application";
import {
  ContentRevisionConfigurationError,
  ContentRevisionBookmarkError,
  ContentRevisionConflictError,
  ContentWorkspaceAccessError,
  createBlogPostArtifactFingerprint,
  createBlogPostRevisionId,
  createContentWorkspaceId,
  restoreContentActorId,
  sha256CanonicalJson,
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

import type {
  D1DatabaseBinding,
  D1DatabaseSessionBinding,
} from "./d1-human-access-store";

type D1StatementPreparer = Pick<
  D1DatabaseBinding | D1DatabaseSessionBinding,
  "prepare"
>;

function prepareMcpMutationReceiptInsert(
  target: D1StatementPreparer,
  audit: JoinedMcpMutationAudit,
  result: JoinedMcpMutationResult,
  guard: Readonly<{
    sql: string;
    bindings: ReadonlyArray<unknown>;
  }> = { sql: "1 = 1", bindings: [] },
) {
  return target
    .prepare(
      `INSERT INTO mcp_mutation_receipts (
         site_id, actor_id, operation, idempotency_key, input_hash,
         invocation_id, result_hash, result_state, workspace_id, revision,
         content_hash, preview_id, replay_count, created_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'succeeded',
              ?8, ?9, ?10, ?11, 0, ?12
       WHERE ${guard.sql}
       ON CONFLICT (site_id, actor_id, operation, idempotency_key)
       DO UPDATE SET replay_count = replay_count + 1
       WHERE input_hash = excluded.input_hash`,
    )
    .bind(
      audit.siteId,
      audit.actorId,
      audit.operation,
      audit.idempotencyKey,
      audit.inputHash,
      audit.invocationId,
      result.resultHash,
      result.workspaceId,
      result.revision,
      result.contentHash,
      result.previewId ?? null,
      audit.occurredAt,
      ...guard.bindings,
    );
}

function prepareJoinedMcpAuditInsert(
  target: D1StatementPreparer,
  audit: JoinedMcpMutationAudit,
  result: JoinedMcpMutationResult,
) {
  return target
    .prepare(
      `INSERT INTO mcp_audit_events (
         invocation_id, connection_id, actor_id, site_id, operation,
         input_hash, protocol_version, scopes_json, outcome, reason,
         human_actor_id, revocation_reason, occurred_at, contract_version,
         idempotency_key, result_hash, replayed, workspace_id, revision,
         content_hash, preview_id
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'allowed', NULL,
              NULL, NULL, ?9, ?10,
              receipt.idempotency_key, receipt.result_hash,
              CASE WHEN receipt.invocation_id = ?1 THEN 0 ELSE 1 END,
              receipt.workspace_id, receipt.revision, receipt.content_hash,
              receipt.preview_id
       FROM mcp_mutation_receipts AS receipt
       WHERE receipt.site_id = ?4
         AND receipt.actor_id = ?3
         AND receipt.operation = ?5
         AND receipt.idempotency_key = ?11
         AND receipt.input_hash = ?6
         AND receipt.result_state = 'succeeded'
         AND receipt.result_hash = ?12
         AND receipt.workspace_id = ?13
         AND receipt.revision = ?14
         AND receipt.content_hash = ?15
         AND receipt.preview_id IS ?16
       ON CONFLICT (invocation_id) DO NOTHING`,
    )
    .bind(
      audit.invocationId,
      audit.connectionId,
      audit.actorId,
      audit.siteId,
      audit.operation,
      audit.inputHash,
      audit.protocolVersion,
      JSON.stringify(audit.scopesEvaluated),
      audit.occurredAt,
      audit.contractVersion,
      audit.idempotencyKey,
      result.resultHash,
      result.workspaceId,
      result.revision,
      result.contentHash,
      result.previewId ?? null,
    );
}

export type D1ContentRevisionInitializationExtension = Readonly<{
  blogPostAdvanceAuthority: "archived-restore";
  prepareStatements(input: Readonly<{
    revision: ContentRevision;
    artifacts: ReadonlyArray<BlogPostArtifactFingerprint>;
  }>): ReadonlyArray<ReturnType<D1DatabaseBinding["prepare"]>>;
}>;

function prepareBlogRenderArtifactInsert(
  target: D1StatementPreparer,
  input: Readonly<{
    workspaceId: ContentWorkspaceId;
    contentRevision: number;
    artifacts: ReadonlyArray<BlogPostArtifactFingerprint>;
    createdAt: string;
    receipt?: Readonly<{ idempotencyKey: string; requestHash: string }>;
  }>,
) {
  const receiptGuard =
    input.receipt === undefined
      ? ""
      : `AND EXISTS (
           SELECT 1 FROM content_revision_receipts
           WHERE idempotency_key = ?5
             AND workspace_id = ?1
             AND revision = ?2
             AND request_hash = ?6
         )`;
  return target
    .prepare(
      `INSERT INTO blog_post_render_artifacts (
         workspace_id, content_revision, post_id, post_revision_id,
         post_revision, content_hash, schema_version, renderer_version,
         serialization_version, rendered_bytes_hash,
         artifact_fingerprint, created_at
       )
       SELECT
         ?1, ?2,
         json_extract(artifact.value, '$.postId'),
         json_extract(artifact.value, '$.postRevisionId'),
         json_extract(artifact.value, '$.revision'),
         json_extract(artifact.value, '$.contentHash'),
         json_extract(artifact.value, '$.schemaVersion'),
         json_extract(artifact.value, '$.rendererVersion'),
         json_extract(artifact.value, '$.serializationVersion'),
         json_extract(artifact.value, '$.renderedBytesHash'),
         json_extract(artifact.value, '$.value'),
         ?4
       FROM json_each(?3) AS artifact
       WHERE 1 = 1
       ${receiptGuard}
       ON CONFLICT (workspace_id, content_revision, post_id)
       DO NOTHING`,
    )
    .bind(
      input.workspaceId,
      input.contentRevision,
      JSON.stringify(input.artifacts),
      input.createdAt,
      ...(input.receipt === undefined
        ? []
        : [input.receipt.idempotencyKey, input.receipt.requestHash]),
    );
}

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
        AND revision.revision = CASE
          WHEN post.live_revision IS NOT NULL
            AND post.last_verified_visibility = 'public'
          THEN post.live_revision
          ELSE post.current_revision
        END
       LEFT JOIN blog_post_collection_states AS collection
         ON collection.site_id = post.site_id
        AND collection.post_id = post.post_id
       WHERE post.site_id = ?1
         AND (
           (
             COALESCE(collection.collection_state, 'active') = 'active'
             AND (
               (
                 post.live_revision IS NOT NULL
                 AND post.last_verified_visibility = 'public'
               )
               OR (
                 post.live_revision IS NULL
                 AND post.last_verified_revision = post.current_revision
                 AND post.last_verified_visibility IN ('unpublished', 'absent')
               )
             )
           )
           OR (
             collection.collection_state = 'archiving'
             AND post.live_revision IS NOT NULL
           )
         )
       ORDER BY post.post_id`,
    )
    .bind(definition.site.id)
    .all<{
      snapshot_json: string;
      last_verified_visibility: "public" | "unpublished" | "absent";
    }>();
  const managed = rows.results.map(
    ({ snapshot_json, last_verified_visibility }) => {
      const post = JSON.parse(snapshot_json) as BlogPost;
      return last_verified_visibility === "absent" &&
        post.targetVisibility === "public"
        ? {
            ...post,
            revision: post.revision + 1,
            targetVisibility: "unpublished" as const,
          }
        : post;
    },
  );
  const managedIds = new Set(managed.map(({ id }) => id));
  const hydrated = {
    ...definition,
    blog: {
      ...definition.blog,
      posts: [
        ...definition.blog.posts.filter(({ id }) => !managedIds.has(id)),
        ...managed,
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
  publication: Readonly<{ id: string; sequence: number }>,
  verifiedAt: string,
): Promise<void> {
  const blog = (
    definition as SiteDefinition & {
      readonly blog?: SiteDefinition["blog"];
    }
  ).blog;
  let blogPosts: SiteDefinition["blog"]["posts"];
  if (blog === undefined) {
    if (
      !["1.0.0", "1.1.0", "1.2.0"].includes(definition.schemaVersion)
    ) {
      throw new ContentRevisionConfigurationError();
    }
    blogPosts = [];
  } else {
    blogPosts = blog.posts;
  }
  const serializedPosts = JSON.stringify(
    await Promise.all(
      blogPosts.map(async (post) => {
        const contentHash = await sha256CanonicalJson(post);
        return {
          id: post.id,
          revision: post.revision,
          revisionId: await createBlogPostRevisionId(
            definition.site.id,
            post.id,
            post.revision,
            contentHash,
          ),
          contentHash,
          targetVisibility: post.targetVisibility,
        };
      }),
    ),
  );
  const immutableRevisionVerification = await database
    .prepare(
      `WITH incoming_posts AS (
         SELECT
           json_extract(value, '$.id') AS post_id,
           json_extract(value, '$.revision') AS revision,
           json_extract(value, '$.revisionId') AS revision_id,
           json_extract(value, '$.contentHash') AS content_hash
         FROM json_each(?1)
       )
       SELECT COUNT(*) AS invalid_count
       FROM incoming_posts AS incoming
       LEFT JOIN blog_posts AS aggregate
         ON aggregate.site_id = ?2
        AND aggregate.post_id = incoming.post_id
       LEFT JOIN blog_post_revisions AS revision
         ON revision.revision_id = incoming.revision_id
        AND revision.site_id = ?2
        AND revision.post_id = incoming.post_id
        AND revision.revision = incoming.revision
        AND revision.content_hash = incoming.content_hash
       WHERE aggregate.post_id IS NULL
          OR revision.revision_id IS NULL`,
    )
    .bind(serializedPosts, siteId)
    .first<{ invalid_count: number }>();
  if (
    immutableRevisionVerification === null ||
    immutableRevisionVerification.invalid_count > 0
  ) {
    throw new ContentRevisionConfigurationError();
  }
  await database.batch([
    database
      .prepare(
        `WITH incoming_posts AS (
           SELECT
             json_extract(value, '$.id') AS post_id,
             json_extract(value, '$.revision') AS revision,
             json_extract(value, '$.revisionId') AS revision_id,
             json_extract(value, '$.contentHash') AS content_hash,
             json_extract(value, '$.targetVisibility') AS target_visibility
           FROM json_each(?1)
         )
         UPDATE blog_posts
         SET live_revision = (
               SELECT CASE
                 WHEN incoming.target_visibility = 'public'
                   THEN incoming.revision
                 ELSE NULL
               END
               FROM incoming_posts AS incoming
               WHERE incoming.post_id = blog_posts.post_id
             ),
             current_revision = (
               SELECT CASE
                 WHEN blog_posts.current_revision >
                   CAST(incoming.revision AS INTEGER)
                 THEN blog_posts.current_revision
                 ELSE CAST(incoming.revision AS INTEGER)
               END
               FROM incoming_posts AS incoming
               WHERE incoming.post_id = blog_posts.post_id
             ),
             current_revision_id = (
               SELECT CASE
                 WHEN blog_posts.current_revision >
                   CAST(incoming.revision AS INTEGER)
                 THEN blog_posts.current_revision_id
                 ELSE incoming.revision_id
               END
               FROM incoming_posts AS incoming
               WHERE incoming.post_id = blog_posts.post_id
             ),
             last_verified_revision = (
               SELECT incoming.revision
               FROM incoming_posts AS incoming
               WHERE incoming.post_id = blog_posts.post_id
             ),
             last_verified_visibility = (
               SELECT incoming.target_visibility
               FROM incoming_posts AS incoming
               WHERE incoming.post_id = blog_posts.post_id
             ),
             last_verified_publication_id = ?2,
             last_verified_publication_sequence = ?3,
             updated_at = ?4
         WHERE site_id = ?5
           AND EXISTS (
             SELECT 1
             FROM incoming_posts AS incoming
             JOIN blog_post_revisions AS revision
               ON revision.revision_id = incoming.revision_id
              AND revision.site_id = ?5
              AND revision.post_id = incoming.post_id
              AND revision.revision = incoming.revision
              AND revision.content_hash = incoming.content_hash
             WHERE incoming.post_id = blog_posts.post_id
           )
           AND (
             last_verified_publication_sequence IS NULL
             OR last_verified_publication_sequence < ?3
             OR (
               last_verified_publication_sequence = ?3
               AND last_verified_publication_id = ?2
             )
           )`,
      )
      .bind(
        serializedPosts,
        publication.id,
        publication.sequence,
        verifiedAt,
        siteId,
      ),
    database
      .prepare(
        `UPDATE blog_posts
         SET live_revision = NULL,
             last_verified_visibility = 'absent',
             last_verified_publication_id = ?1,
             last_verified_publication_sequence = ?2,
             updated_at = ?3
         WHERE site_id = ?4
           AND (
             live_revision IS NOT NULL
             OR last_verified_publication_sequence IS NOT NULL
           )
           AND (
             last_verified_publication_sequence IS NULL
             OR last_verified_publication_sequence < ?2
             OR (
               last_verified_publication_sequence = ?2
               AND last_verified_publication_id = ?1
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(?5) AS present_post
             WHERE present_post.value = blog_posts.post_id
           )`,
      )
      .bind(
        publication.id,
        publication.sequence,
        verifiedAt,
        siteId,
        JSON.stringify(blogPosts.map(({ id }) => id)),
      ),
  ]);
  const verification = await database
    .prepare(
      `WITH incoming_posts AS (
         SELECT
           json_extract(value, '$.id') AS post_id,
           json_extract(value, '$.revision') AS revision,
           json_extract(value, '$.revisionId') AS revision_id,
           json_extract(value, '$.contentHash') AS content_hash,
           json_extract(value, '$.targetVisibility') AS target_visibility
         FROM json_each(?1)
       )
       SELECT COUNT(*) AS invalid_count
       FROM incoming_posts AS incoming
       LEFT JOIN blog_posts AS aggregate
         ON aggregate.site_id = ?2
        AND aggregate.post_id = incoming.post_id
       LEFT JOIN blog_post_revisions AS revision
         ON revision.revision_id = incoming.revision_id
        AND revision.site_id = ?2
        AND revision.post_id = incoming.post_id
        AND revision.revision = incoming.revision
        AND revision.content_hash = incoming.content_hash
       WHERE aggregate.post_id IS NULL
          OR revision.revision_id IS NULL
          OR aggregate.last_verified_revision IS NULL
          OR aggregate.last_verified_publication_sequence IS NULL
          OR aggregate.last_verified_publication_sequence < ?3
          OR (
            aggregate.last_verified_publication_sequence = ?3
            AND (
              aggregate.last_verified_publication_id <> ?4
              OR aggregate.current_revision <
                CAST(incoming.revision AS INTEGER)
              OR (
                aggregate.current_revision =
                  CAST(incoming.revision AS INTEGER)
                AND aggregate.current_revision_id <> incoming.revision_id
              )
              OR aggregate.last_verified_revision <> incoming.revision
              OR aggregate.last_verified_visibility <>
                incoming.target_visibility
              OR aggregate.live_revision IS NOT CASE
                WHEN incoming.target_visibility = 'public'
                  THEN incoming.revision
                ELSE NULL
              END
            )
          )`,
    )
    .bind(serializedPosts, siteId, publication.sequence, publication.id)
    .first<{ invalid_count: number }>();
  if (verification === null || verification.invalid_count > 0) {
    throw new ContentRevisionConfigurationError();
  }
}

export async function findVerifiedPublicationOrder(
  database: D1DatabaseBinding,
  publicationId: string,
): Promise<Readonly<{ id: string; sequence: number }>> {
  const row = await database
    .prepare(
      `SELECT sequence
       FROM blog_publication_reconciliation_order
       WHERE publication_id = ?1`,
    )
    .bind(publicationId)
    .first<{ sequence: number }>();
  if (row === null || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new ContentRevisionConfigurationError();
  }
  return { id: publicationId, sequence: row.sequence };
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

async function findContentRevisionFrom(
  connection: Pick<D1DatabaseBinding, "prepare">,
  workspaceId: ContentWorkspaceId,
  revision: number,
): Promise<ContentRevision | null> {
  const row = await connection
    .prepare(
      `${revisionProjection}
       WHERE workspace_id = ?1 AND revision = ?2`,
    )
    .bind(workspaceId, revision)
    .first<RevisionRow>();
  return row === null ? null : toRevision(row);
}

export function findContentRevision(
  database: D1DatabaseBinding,
  workspaceId: ContentWorkspaceId,
  revision: number,
): Promise<ContentRevision | null> {
  return findContentRevisionFrom(database, workspaceId, revision);
}

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
  initializationExtension?: D1ContentRevisionInitializationExtension,
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
    return findContentRevisionFrom(connection, workspaceId, revision);
  }

  async function replayPersistedRevision(
    session: D1DatabaseSessionBinding,
    command: Parameters<ContentRevisionStore["persist"]>[0],
    receipt: ReceiptRow,
  ) {
    assertContentRevisionIdempotency(
      receipt.request_hash,
      command.requestHash,
    );
    const revision = await getRevisionFrom(session, receipt.revision);
    if (revision === null) {
      throw new ContentRevisionConfigurationError();
    }
    const result = {
      resultHash: revision.inputs.contentHash,
      workspaceId,
      revision: revision.revision,
      contentHash: revision.inputs.contentHash,
    };
    if (command.joinedAudit !== undefined) {
      await session.batch([
        prepareMcpMutationReceiptInsert(
          session,
          command.joinedAudit,
          result,
        ),
        prepareJoinedMcpAuditInsert(session, command.joinedAudit, result),
      ]);
    }
    return {
      revision: withContentRevisionBookmark(
        revision,
        requireBookmark(session.getBookmark()),
      ),
      replayed: true,
    };
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
    async initialize(initialRevision, ownerActorId, joinedAudit) {
      const initialArtifacts = await Promise.all(
        initialRevision.definition.blog.posts.map((post) =>
          createBlogPostArtifactFingerprint({
            definition: initialRevision.definition,
            post,
            schemaVersion: initialRevision.definition.schemaVersion,
            rendererVersion: initialRevision.inputs.rendererVersion,
          }),
        ),
      );
      const initialPosts = initialRevision.definition.blog.posts.map(
        (post, index) => ({
          post,
          artifact: initialArtifacts[index]!,
        }),
      );
      const joinedResult: JoinedMcpMutationResult = {
        resultHash: initialRevision.inputs.contentHash,
        workspaceId,
        revision: initialRevision.revision,
        contentHash: initialRevision.inputs.contentHash,
      };
      const results = await database.batch([
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
        database
          .prepare(
            `INSERT INTO blog_posts (
               site_id, post_id, collection_state, current_revision,
               current_revision_id,
               live_revision, last_verified_revision,
               last_verified_visibility, last_verified_publication_id,
               last_verified_publication_sequence,
               version, updated_at
             )
             SELECT
               ?1,
               json_extract(entry.value, '$.post.id'),
               'active',
               json_extract(entry.value, '$.post.revision'),
               json_extract(entry.value, '$.artifact.postRevisionId'),
               CASE
                 WHEN json_extract(
                   entry.value,
                   '$.post.targetVisibility'
                 ) = 'public'
                   THEN json_extract(entry.value, '$.post.revision')
                 ELSE NULL
               END,
               json_extract(entry.value, '$.post.revision'),
               json_extract(entry.value, '$.post.targetVisibility'),
               (
                 SELECT publication_order.publication_id
                 FROM blog_publication_reconciliation_order
                   AS publication_order
                 JOIN content_publications AS publication
                   ON publication.id = publication_order.publication_id
                 WHERE publication.status = 'verified-live'
                 ORDER BY publication_order.sequence DESC
                 LIMIT 1
               ),
               (
                 SELECT publication_order.sequence
                 FROM blog_publication_reconciliation_order
                   AS publication_order
                 JOIN content_publications AS publication
                   ON publication.id = publication_order.publication_id
                 WHERE publication.status = 'verified-live'
                 ORDER BY publication_order.sequence DESC
                 LIMIT 1
               ),
               json_extract(entry.value, '$.post.revision'),
               ?3
             FROM json_each(?2) AS entry
             WHERE 1 = 1
             ON CONFLICT (site_id, post_id) DO UPDATE SET
               current_revision = excluded.current_revision,
               current_revision_id = excluded.current_revision_id,
               version = blog_posts.version + 1,
               updated_at = excluded.updated_at
             WHERE blog_posts.live_revision IS NULL
               AND (
                 blog_posts.last_verified_visibility = 'absent'
                 OR (
                   ?4 = 1
                   AND (
                     blog_posts.last_verified_visibility = 'unpublished'
                     OR EXISTS (
                       SELECT 1 FROM blog_post_collection_states
                       WHERE site_id = blog_posts.site_id
                         AND post_id = blog_posts.post_id
                         AND collection_state = 'archived'
                         AND restore_request_id IS NOT NULL
                     )
                   )
                 )
               )
               AND blog_posts.current_revision + 1 =
                   excluded.current_revision`,
          )
          .bind(
            siteId,
            JSON.stringify(initialPosts),
            initialRevision.createdAt,
            initializationExtension?.blogPostAdvanceAuthority ===
              "archived-restore"
              ? 1
              : 0,
          ),
        database
          .prepare(
            `INSERT INTO blog_post_revisions (
               revision_id, site_id, post_id, revision, workspace_id,
               content_revision, snapshot_json, created_at, created_by,
               content_hash, schema_version, renderer_version,
               serialization_version, rendered_bytes_hash,
               artifact_fingerprint
             )
             SELECT
               json_extract(entry.value, '$.artifact.postRevisionId'),
               ?1,
               json_extract(entry.value, '$.post.id'),
               json_extract(entry.value, '$.post.revision'),
               ?2, ?3,
               json_extract(entry.value, '$.post'),
               ?4, ?5,
               json_extract(entry.value, '$.artifact.contentHash'),
               json_extract(entry.value, '$.artifact.schemaVersion'),
               json_extract(entry.value, '$.artifact.rendererVersion'),
               json_extract(entry.value, '$.artifact.serializationVersion'),
               json_extract(entry.value, '$.artifact.renderedBytesHash'),
               json_extract(entry.value, '$.artifact.value')
             FROM json_each(?6) AS entry
             WHERE 1 = 1
             ON CONFLICT (revision_id) DO NOTHING`,
          )
          .bind(
            siteId,
            workspaceId,
            initialRevision.revision,
            initialRevision.createdAt,
            initialRevision.createdBy,
            JSON.stringify(initialPosts),
          ),
        prepareBlogRenderArtifactInsert(database, {
          workspaceId,
          contentRevision: initialRevision.revision,
          artifacts: initialArtifacts,
          createdAt: initialRevision.createdAt,
        }),
        ...(joinedAudit === undefined
          ? []
          : [
              prepareMcpMutationReceiptInsert(
                database,
                joinedAudit,
                joinedResult,
                {
                  sql: `EXISTS (
                    SELECT 1
                    FROM content_workspaces AS workspace
                    JOIN content_revisions AS revision
                      ON revision.workspace_id = workspace.workspace_id
                     AND revision.revision = ?13
                    WHERE workspace.workspace_id = ?14
                      AND workspace.site_id = ?15
                      AND workspace.owner_actor_id = ?16
                      AND revision.content_hash = ?17
                  )`,
                  bindings: [
                    initialRevision.revision,
                    workspaceId,
                    siteId,
                    ownerActorId,
                    initialRevision.inputs.contentHash,
                  ],
                },
              ),
              prepareJoinedMcpAuditInsert(
                database,
                joinedAudit,
                joinedResult,
              ),
            ]),
        ...(initializationExtension?.prepareStatements({
          revision: initialRevision,
          artifacts: initialArtifacts,
        }) ?? []),
      ]);
      return (results[0]?.meta.changes ?? 0) === 1;
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
            | BlogPost["targetVisibility"]
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
    async recordJoinedMcpAudit(audit, result) {
      await database.batch([
        prepareMcpMutationReceiptInsert(database, audit, result),
        prepareJoinedMcpAuditInsert(database, audit, result),
      ]);
    },
    async persist(command) {
      if (database.withSession === undefined) {
        throw new Error("content_revision_sessions_unavailable");
      }
      const session = database.withSession("first-primary");
      const existing = await findReceipt(session, command.idempotencyKey);
      if (existing !== null) {
        return replayPersistedRevision(session, command, existing);
      }

      const current = await getCurrentFrom(session);
      if (command.baseRevision !== current.revision) {
        const racedReceipt = await findReceipt(
          session,
          command.idempotencyKey,
        );
        if (racedReceipt !== null) {
          return replayPersistedRevision(session, command, racedReceipt);
        }
      }
      assertContentRevisionBase(command.baseRevision, current.revision);
      const mediaOccurrence = command.mediaOccurrence;
      const mediaCrop =
        mediaOccurrence?.crop === null || mediaOccurrence === undefined
          ? null
          : JSON.stringify(mediaOccurrence.crop);
      const mcpMutationGuard =
        command.joinedAudit === undefined
          ? ""
          : `AND (
               NOT EXISTS (
                 SELECT 1 FROM mcp_mutation_receipts
                 WHERE site_id = ?18
                   AND actor_id = ?19
                   AND operation = ?20
                   AND idempotency_key = ?21
               )
               OR EXISTS (
                 SELECT 1 FROM mcp_mutation_receipts
                 WHERE site_id = ?18
                   AND actor_id = ?19
                   AND operation = ?20
                   AND idempotency_key = ?21
                   AND input_hash = ?22
                   AND result_state = 'succeeded'
                   AND result_hash = ?4
                   AND workspace_id = ?1
                   AND revision = ?2
                   AND content_hash = ?4
                   AND preview_id IS NULL
               )
             )`;
      const blogGuardBindings: Array<string | number | null> = [];
      let blogGuardParameter =
        command.joinedAudit === undefined ? 18 : 23;
      const blogTransitionGuards = (command.blogTransitions ?? [])
        .map((transition) => {
          const bindGuardValue = (value: string | number | null) => {
            const parameter = blogGuardParameter;
            blogGuardParameter += 1;
            blogGuardBindings.push(value);
            return `?${parameter}`;
          };
          if (transition.beforeState === null) {
            if (transition.observedAggregate !== null) {
              return "AND 0 = 1";
            }
            const postParameter = bindGuardValue(transition.postId);
            return `AND NOT EXISTS (
              SELECT 1 FROM blog_posts
              WHERE site_id = ?14 AND post_id = ${postParameter}
            )`;
          }
          const observedAggregate = transition.observedAggregate;
          if (observedAggregate === null) {
            return "AND 0 = 1";
          }
          const postParameter = bindGuardValue(transition.postId);
          const currentRevisionParameter = bindGuardValue(
            observedAggregate.currentRevision,
          );
          const liveRevisionParameter = bindGuardValue(
            observedAggregate.liveRevision,
          );
          const lastVerifiedRevisionParameter = bindGuardValue(
            observedAggregate.lastVerifiedRevision,
          );
          const lastVerifiedVisibilityParameter = bindGuardValue(
            observedAggregate.lastVerifiedVisibility,
          );
          const versionParameter = bindGuardValue(
            observedAggregate.version,
          );
          const collectionAuthority =
            transition.commandType === "blog.post.unpublish"
              ? `(
                  COALESCE((
                    SELECT collection_state
                    FROM blog_post_collection_states
                    WHERE site_id = blog_posts.site_id
                      AND post_id = blog_posts.post_id
                  ), collection_state) = 'active'
                  OR EXISTS (
                    SELECT 1
                    FROM blog_post_collection_states AS withdrawal
                    WHERE withdrawal.site_id = blog_posts.site_id
                      AND withdrawal.post_id = blog_posts.post_id
                      AND withdrawal.collection_state = 'archiving'
                      AND withdrawal.withdrawal_workspace_id = ?1
                      AND withdrawal.withdrawal_content_revision = ?2
                      AND withdrawal.withdrawal_created_by = ?10
                  )
                )`
              : `COALESCE((
                  SELECT collection_state
                  FROM blog_post_collection_states
                  WHERE site_id = blog_posts.site_id
                    AND post_id = blog_posts.post_id
                ), collection_state) = 'active'`;
          return `AND EXISTS (
            SELECT 1 FROM blog_posts
            WHERE site_id = ?14
              AND post_id = ${postParameter}
              AND ${collectionAuthority}
              AND current_revision = ${currentRevisionParameter}
              AND live_revision IS ${liveRevisionParameter}
              AND last_verified_revision IS ${lastVerifiedRevisionParameter}
              AND last_verified_visibility IS ${lastVerifiedVisibilityParameter}
              AND version = ${versionParameter}
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
      // Successor drafts branch independently by workspace and immutable,
      // content-addressed revision ID. Only creation claims the site-global
      // identity here; verified-live reconciliation advances the aggregate.
      const blogAggregateStatements = (command.blogTransitions ?? [])
        .filter((transition) => transition.beforeState === null)
        .map((transition) =>
          session
            .prepare(
                  `INSERT INTO blog_posts (
                     site_id, post_id, collection_state, current_revision,
                     current_revision_id,
                     live_revision, last_verified_revision,
                     last_verified_visibility, last_verified_publication_id,
                     last_verified_publication_sequence,
                     version, updated_at
                   )
                   SELECT
                     ?1, ?2, 'active', ?3, ?4,
                     NULL, NULL, NULL, NULL, NULL, 1, ?5
                   WHERE EXISTS (
                     SELECT 1 FROM content_revision_receipts
                     WHERE idempotency_key = ?6
                       AND workspace_id = ?7
                       AND revision = ?8
                       AND request_hash = ?9
                   )
                   ON CONFLICT (site_id, post_id) DO NOTHING`,
              )
              .bind(
                siteId,
                transition.postId,
                transition.afterState!.revision,
                transition.revisionId,
                command.revision.createdAt,
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
                 content_revision, snapshot_json, created_at, created_by,
                 content_hash, schema_version, renderer_version,
                 serialization_version, rendered_bytes_hash,
                 artifact_fingerprint
               )
               SELECT
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 ?10, ?11, ?12, ?13, ?14, ?15
               WHERE EXISTS (
                 SELECT 1 FROM content_revision_receipts
                 WHERE idempotency_key = ?16
                   AND workspace_id = ?5
                   AND revision = ?6
                   AND request_hash = ?17
               )
               ON CONFLICT (revision_id) DO NOTHING`,
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
              transition.artifact.contentHash,
              transition.artifact.schemaVersion,
              transition.artifact.rendererVersion,
              transition.artifact.serializationVersion,
              transition.artifact.renderedBytesHash,
              transition.artifact.value,
              command.idempotencyKey,
              command.requestHash,
            );
        },
      );
      const blogArtifactStatement = prepareBlogRenderArtifactInsert(session, {
        workspaceId,
        contentRevision: command.revision.revision,
        artifacts: command.blogArtifacts,
        createdAt: command.revision.createdAt,
        receipt: {
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
        },
      });
      const joinedResult: JoinedMcpMutationResult = {
        resultHash: command.revision.inputs.contentHash,
        workspaceId,
        revision: command.revision.revision,
        contentHash: command.revision.inputs.contentHash,
      };
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
             ${mcpMutationGuard}
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
            ...(command.joinedAudit === undefined
              ? []
              : [
                  command.joinedAudit.siteId,
                  command.joinedAudit.actorId,
                  command.joinedAudit.operation,
                  command.joinedAudit.idempotencyKey,
                  command.joinedAudit.inputHash,
                ]),
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
        blogArtifactStatement,
        ...blogTransitionStatements,
        ...(command.joinedAudit === undefined
          ? []
          : [
              prepareMcpMutationReceiptInsert(
                session,
                command.joinedAudit,
                joinedResult,
                {
                  sql: `EXISTS (
                    SELECT 1
                    FROM content_revision_receipts AS receipt
                    JOIN content_revisions AS revision
                      ON revision.workspace_id = receipt.workspace_id
                     AND revision.revision = receipt.revision
                    WHERE receipt.idempotency_key = ?13
                      AND receipt.workspace_id = ?14
                      AND receipt.request_hash = ?15
                      AND receipt.revision = ?16
                      AND revision.content_hash = ?17
                  )`,
                  bindings: [
                    command.idempotencyKey,
                    workspaceId,
                    command.requestHash,
                    command.revision.revision,
                    command.revision.inputs.contentHash,
                  ],
                },
              ),
              prepareJoinedMcpAuditInsert(
                session,
                command.joinedAudit,
                joinedResult,
              ),
            ]),
      ]);

      if ((results[2]?.meta.changes ?? 0) > 0) {
        return {
          revision: withContentRevisionBookmark(
            command.revision,
            requireBookmark(session.getBookmark()),
          ),
          replayed: false,
        };
      }
      const racedReceipt = await findReceipt(
        session,
        command.idempotencyKey,
      );
      if (racedReceipt !== null) {
        return replayPersistedRevision(session, command, racedReceipt);
      }
      if (command.joinedAudit !== undefined) {
        const mutationReceipt = await session
          .prepare(
            `SELECT input_hash
             FROM mcp_mutation_receipts
             WHERE site_id = ?1
               AND actor_id = ?2
               AND operation = ?3
               AND idempotency_key = ?4`,
          )
          .bind(
            command.joinedAudit.siteId,
            command.joinedAudit.actorId,
            command.joinedAudit.operation,
            command.joinedAudit.idempotencyKey,
          )
          .first<{ input_hash: string }>();
        if (mutationReceipt !== null) {
          assertContentRevisionIdempotency(
            mutationReceipt.input_hash,
            command.joinedAudit.inputHash,
          );
        }
      }
      throw new ContentRevisionConflictError(
        (await getCurrentFrom(session)).revision,
      );
    },
  };
}

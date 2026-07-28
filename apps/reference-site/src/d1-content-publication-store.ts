import type {
  ContentApproval,
  ContentApprovalFingerprint,
  ContentApprovalId,
  ContentPublication,
  ContentPublicationClaim,
  ContentPublicationId,
  ContentPublicationStatus,
  ContentPublicationStore,
  ContentWorkspaceId,
  HumanMembershipId,
} from "@foundry/application";
import {
  assertContentPublicationIdempotency,
  ContentApprovalInvalidError,
  createContentActorId,
  createContentApprovalId,
  createContentPublicationId,
  createContentWorkspaceId,
  createHumanMembershipId,
  serializeContentPublicationCommandIdentity,
} from "@foundry/application";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type ApprovalRow = {
  id: string;
  workspace_id: string;
  revision: number;
  fingerprint: string;
  channel: "site";
  channel_configuration_hash: string;
  content_hash: string;
  design_hash: string;
  schema_version: "1.0.0";
  renderer_version: string;
  production_base: string;
  artifact_hash: string;
  serialization_version:
    "foundry.site-definition.canonical-json.v1";
  approved_by: string;
  approved_at: string;
  invalidated_at: string | null;
};

type PublicationRow = {
  id: string;
  workspace_id: string;
  revision: number;
  approval_id: string;
  fingerprint: string;
  idempotency_key: string;
  command_identity: string;
  requested_by: string;
  contributors_json: string;
  expected_head: string;
  status: ContentPublicationStatus;
  commit_sha: string | null;
  deployment_id: string | null;
  deployment_requested_at: string | null;
  detail: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  requested_at: string;
  updated_at: string;
  mutation_token: string;
};

const approvalProjection = `
  SELECT
    approval.id,
    approval.workspace_id,
    approval.revision,
    approval.fingerprint,
    approval.channel,
    approval.channel_configuration_hash,
    approval.content_hash,
    approval.design_hash,
    approval.schema_version,
    approval.renderer_version,
    approval.production_base,
    approval.artifact_hash,
    approval.serialization_version,
    approval.approved_by,
    approval.approved_at,
    invalidation.invalidated_at
  FROM content_approvals AS approval
  LEFT JOIN content_approval_invalidations AS invalidation
    ON invalidation.approval_id = approval.id
`;

const publicationProjection = `
  SELECT
    id,
    workspace_id,
    revision,
    approval_id,
    fingerprint,
    idempotency_key,
    command_identity,
    requested_by,
    contributors_json,
    expected_head,
    status,
    commit_sha,
    deployment_id,
    deployment_requested_at,
    detail,
    lease_token,
    lease_expires_at,
    requested_at,
    updated_at,
    mutation_token
  FROM content_publications
`;

function toApproval(row: ApprovalRow): ContentApproval {
  const fingerprint: ContentApprovalFingerprint = {
    value: row.fingerprint,
    channel: row.channel,
    channelConfigurationHash: row.channel_configuration_hash,
    contentHash: row.content_hash,
    designHash: row.design_hash,
    schemaVersion: row.schema_version,
    rendererVersion: row.renderer_version,
    productionBase: row.production_base,
    artifactHash: row.artifact_hash,
    serializationVersion: row.serialization_version,
  };
  return {
    id: createContentApprovalId(row.id),
    workspaceId: createContentWorkspaceId(row.workspace_id),
    revision: row.revision,
    fingerprint,
    approvedBy: createHumanMembershipId(row.approved_by),
    approvedAt: row.approved_at,
    invalidatedAt: row.invalidated_at,
  };
}

function toPublication(row: PublicationRow): ContentPublication {
  const contributors: unknown = JSON.parse(row.contributors_json);
  if (
    !Array.isArray(contributors) ||
    !contributors.every((actor) => typeof actor === "string")
  ) {
    throw new Error("content_publication_contributors_invalid");
  }
  return {
    id: createContentPublicationId(row.id),
    workspaceId: createContentWorkspaceId(row.workspace_id),
    revision: row.revision,
    approvalId: createContentApprovalId(row.approval_id),
    fingerprint: row.fingerprint,
    idempotencyKey: row.idempotency_key,
    requestedBy: createHumanMembershipId(row.requested_by),
    contributors: contributors.map(createContentActorId),
    expectedHead: row.expected_head,
    status: row.status,
    commitSha: row.commit_sha,
    deploymentId: row.deployment_id,
    deploymentRequestedAt: row.deployment_requested_at,
    detail: row.detail,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  };
}

export function createD1ContentPublicationStore(
  database: D1DatabaseBinding,
): ContentPublicationStore {
  async function findApproval(
    id: ContentApprovalId,
  ): Promise<ContentApproval | null> {
    const row = await database
      .prepare(`${approvalProjection} WHERE approval.id = ?1`)
      .bind(id)
      .first<ApprovalRow>();
    return row === null ? null : toApproval(row);
  }

  async function findPublication(
    id: ContentPublicationId,
  ): Promise<ContentPublication | null> {
    const row = await database
      .prepare(`${publicationProjection} WHERE id = ?1`)
      .bind(id)
      .first<PublicationRow>();
    return row === null ? null : toPublication(row);
  }

  async function findPublicationByKey(
    workspaceId: ContentWorkspaceId,
    idempotencyKey: string,
  ) {
    const row = await findPublicationRowByKey(workspaceId, idempotencyKey);
    return row === null ? null : toPublication(row);
  }

  async function findPublicationRowByKey(
    workspaceId: ContentWorkspaceId,
    idempotencyKey: string,
  ) {
    const row = await database
      .prepare(
        `${publicationProjection}
         WHERE workspace_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(workspaceId, idempotencyKey)
      .first<PublicationRow>();
    return row;
  }

  function insertPublicationStatement(
    publication: ContentPublication,
    requireCurrentApproval: boolean,
    mutationToken: string,
  ) {
    const statement = database.prepare(
      `INSERT INTO content_publications (
           id, workspace_id, revision, approval_id, fingerprint,
           idempotency_key, command_identity, requested_by, contributors_json,
           expected_head, status, commit_sha, deployment_id,
           deployment_requested_at, detail, lease_token, lease_expires_at,
           requested_at, updated_at, mutation_token
         )
         SELECT
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19, ?20
         ${requireCurrentApproval
           ? `WHERE EXISTS (
                SELECT 1
                FROM content_approvals AS approval
                JOIN content_workspaces AS workspace
                  ON workspace.workspace_id = approval.workspace_id
                WHERE approval.id = ?4
                  AND approval.workspace_id = ?2
                  AND approval.revision = ?3
                  AND approval.fingerprint = ?5
                  AND workspace.current_revision = ?3
                  AND NOT EXISTS (
                    SELECT 1 FROM content_approval_invalidations
                    WHERE approval_id = approval.id
                  )
              )`
           : ""}`,
    );
    return statement
      .bind(
        publication.id,
        publication.workspaceId,
        publication.revision,
        publication.approvalId,
        publication.fingerprint,
        publication.idempotencyKey,
        serializeContentPublicationCommandIdentity(publication),
        publication.requestedBy,
        JSON.stringify(publication.contributors),
        publication.expectedHead,
        publication.status,
        publication.commitSha,
        publication.deploymentId,
        publication.deploymentRequestedAt,
        publication.detail,
        publication.leaseToken,
        publication.leaseExpiresAt,
        publication.requestedAt,
        publication.updatedAt,
        mutationToken,
      );
  }

  function auditStatement(
    publication: ContentPublication,
    mutationToken: string,
  ) {
    return database
      .prepare(
        `INSERT INTO content_publication_audit_events (
           publication_id, status, detail, occurred_at
         )
         SELECT ?1, ?2, ?3, ?4
         WHERE EXISTS (
           SELECT 1 FROM content_publications
           WHERE id = ?1
             AND mutation_token = ?5
         )`,
      )
      .bind(
        publication.id,
        publication.status,
        publication.detail,
        publication.updatedAt,
        mutationToken,
      );
  }

  async function insertPublication(
    publication: ContentPublication,
    requireCurrentApproval: boolean,
  ) {
    const mutationToken = crypto.randomUUID();
    const results = await database.batch([
      insertPublicationStatement(
        publication,
        requireCurrentApproval,
        mutationToken,
      ),
      auditStatement(publication, mutationToken),
    ]);
    return results[0]?.meta.changes ?? 0;
  }

  async function findActivePublication() {
    const row = await database
      .prepare(
        `${publicationProjection}
         WHERE status IN (
           'requested', 'committed', 'building', 'deployed', 'unknown'
         )
         ORDER BY requested_at, id
         LIMIT 1`,
      )
      .first<PublicationRow>();
    return row === null ? null : toPublication(row);
  }

  return {
    async saveApproval(approval) {
      const duplicate = await database
        .prepare(
          `${approvalProjection}
           WHERE approval.workspace_id = ?1
             AND approval.revision = ?2
             AND approval.fingerprint = ?3
             AND approval.approved_by = ?4
             AND invalidation.approval_id IS NULL
           ORDER BY approval.approved_at DESC
           LIMIT 1`,
        )
        .bind(
          approval.workspaceId,
          approval.revision,
          approval.fingerprint.value,
          approval.approvedBy,
        )
        .first<ApprovalRow>();
      if (duplicate !== null) {
        return toApproval(duplicate);
      }
      await database.batch([
        database
          .prepare(
            `INSERT INTO content_approval_invalidations (
               approval_id, invalidated_at, reason
             )
            SELECT id, ?1, 'superseded'
             FROM content_approvals
             WHERE workspace_id = ?2
               AND EXISTS (
                 SELECT 1
                 FROM content_workspaces
                 WHERE workspace_id = ?2
                   AND current_revision = ?3
               )
               AND NOT EXISTS (
                 SELECT 1 FROM content_approval_invalidations
                 WHERE approval_id = content_approvals.id
               )`,
          )
          .bind(
            approval.approvedAt,
            approval.workspaceId,
            approval.revision,
          ),
        database
          .prepare(
            `INSERT INTO content_approvals (
               id, workspace_id, revision, fingerprint, channel,
               channel_configuration_hash, content_hash, design_hash,
               schema_version, renderer_version, production_base,
               artifact_hash, serialization_version, approved_by, approved_at
             )
             SELECT
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15
             WHERE EXISTS (
               SELECT 1
               FROM content_workspaces
               WHERE workspace_id = ?2
                 AND current_revision = ?3
             )`,
          )
          .bind(
            approval.id,
            approval.workspaceId,
            approval.revision,
            approval.fingerprint.value,
            approval.fingerprint.channel,
            approval.fingerprint.channelConfigurationHash,
            approval.fingerprint.contentHash,
            approval.fingerprint.designHash,
            approval.fingerprint.schemaVersion,
            approval.fingerprint.rendererVersion,
            approval.fingerprint.productionBase,
            approval.fingerprint.artifactHash,
            approval.fingerprint.serializationVersion,
            approval.approvedBy,
            approval.approvedAt,
          ),
      ]).then((results) => {
        if ((results[1]?.meta.changes ?? 0) < 1) {
          throw new ContentApprovalInvalidError("revision_not_current");
        }
      });
      return approval;
    },
    findApproval,
    async invalidateApproval({ approvalId, invalidatedAt, reason }) {
      await database
        .prepare(
          `INSERT INTO content_approval_invalidations (
             approval_id, invalidated_at, reason
           )
           SELECT id, ?1, ?2
           FROM content_approvals
           WHERE id = ?3
           ON CONFLICT (approval_id) DO NOTHING`,
        )
        .bind(invalidatedAt, reason, approvalId)
        .run();
      return findApproval(approvalId);
    },
    async claimPublication(publication): Promise<ContentPublicationClaim> {
      const replayRow = await findPublicationRowByKey(
        publication.workspaceId,
        publication.idempotencyKey,
      );
      if (replayRow !== null) {
        assertContentPublicationIdempotency(
          replayRow.command_identity,
          publication,
        );
        return {
          state: "replayed",
          publication: toPublication(replayRow),
        };
      }
      try {
        const inserted = await insertPublication(publication, true);
        if (inserted < 1) {
          const blocked = {
            ...publication,
            status: "blocked" as const,
            detail: "approval_stale",
            leaseToken: null,
            leaseExpiresAt: null,
          };
          await insertPublication(blocked, false);
          return { state: "blocked", publication: blocked };
        }
      } catch (error) {
        const racedReplay = await findPublicationRowByKey(
          publication.workspaceId,
          publication.idempotencyKey,
        );
        if (racedReplay !== null) {
          assertContentPublicationIdempotency(
            racedReplay.command_identity,
            publication,
          );
          return {
            state: "replayed",
            publication: toPublication(racedReplay),
          };
        }
        if (
          !(
            error instanceof Error &&
            error.message.includes("content_publications_one_active")
          ) ||
          (await findActivePublication()) === null
        ) {
          throw error;
        }
        const blocked = {
          ...publication,
          status: "blocked" as const,
          detail: "publication_in_progress",
          leaseToken: null,
          leaseExpiresAt: null,
        };
        try {
          await insertPublication(blocked, false);
          return { state: "blocked", publication: blocked };
        } catch {
          throw error;
        }
      }
      return { state: "claimed", publication };
    },
    async hasPublicationLease({ publicationId, leaseToken, now }) {
      const row = await database
        .prepare(
          `SELECT 1 AS held
           FROM content_publications
           WHERE id = ?1
             AND status = 'requested'
             AND lease_token = ?2
             AND lease_expires_at > ?3
             AND NOT EXISTS (
               SELECT 1 FROM content_approval_invalidations
               WHERE approval_id = content_publications.approval_id
             )
             AND EXISTS (
               SELECT 1 FROM content_workspaces
               WHERE workspace_id = content_publications.workspace_id
                 AND current_revision = content_publications.revision
             )`,
        )
        .bind(publicationId, leaseToken, now)
        .first<{ held: number }>();
      return row?.held === 1;
    },
    async renewPublicationLease({
      publicationId,
      leaseToken,
      now,
      leaseExpiresAt,
      expectedStatus = "requested",
      expectedDetail,
      expectedDeploymentId,
    }) {
      const result = await database
        .prepare(
          `UPDATE content_publications
           SET lease_expires_at = ?1,
               mutation_token = ?5
           WHERE id = ?2
             AND status = ?6
             AND lease_token = ?3
             AND lease_expires_at > ?4
             AND (?7 IS NULL OR detail = ?7)
             AND (?8 IS NULL OR deployment_id = ?8)
             AND NOT EXISTS (
               SELECT 1 FROM content_approval_invalidations
               WHERE approval_id = content_publications.approval_id
             )
             AND EXISTS (
               SELECT 1 FROM content_workspaces
               WHERE workspace_id = content_publications.workspace_id
                 AND current_revision = content_publications.revision
             )`,
        )
        .bind(
          leaseExpiresAt,
          publicationId,
          leaseToken,
          now,
          crypto.randomUUID(),
          expectedStatus,
          expectedDetail ?? null,
          expectedDeploymentId ?? null,
        )
        .run();
      return (result.meta.changes ?? 0) === 1;
    },
    async updatePublication(publication, options) {
      const expectedLeaseToken = options?.expectedLeaseToken ?? null;
      const expectedLeaseValidAt =
        options?.expectedLeaseValidAt ?? null;
      const expectedStatus = options?.expectedStatus ?? null;
      const expectedUpdatedAt = options?.expectedUpdatedAt ?? null;
      const mutationToken = crypto.randomUUID();
      const results = await database.batch([
        database
          .prepare(
            `UPDATE content_publications
             SET
               status = ?1,
               commit_sha = ?2,
               deployment_id = ?3,
               deployment_requested_at = ?4,
               detail = ?5,
               lease_token = ?6,
               lease_expires_at = ?7,
               updated_at = ?8,
               mutation_token = ?9
             WHERE id = ?10
               AND status <> 'verified-live'
               AND (
                 ?11 IS NULL
                 OR (
                   lease_token = ?11
                   AND (
                     status = 'requested'
                     OR (
                       status = 'committed'
                       AND detail = 'deployment_retry_dispatching'
                     )
                   )
                 )
               )
               AND (?12 IS NULL OR lease_expires_at > ?12)
               AND (?13 IS NULL OR status = ?13)
               AND (?14 IS NULL OR updated_at = ?14)
               AND (commit_sha IS NULL OR commit_sha = ?2)
               AND NOT (
                 status = 'deployed'
                 AND ?1 IN ('requested', 'committed', 'building', 'unknown')
               )
               AND NOT (
                 status = 'building'
                 AND ?1 IN ('requested', 'committed', 'unknown')
               )
               AND NOT (
                 status = 'committed'
                 AND ?1 IN ('requested', 'unknown')
                 AND NOT (
                   detail = 'deployment_retry_dispatching'
                   AND ?1 = 'unknown'
                 )
               )`,
          )
          .bind(
            publication.status,
            publication.commitSha,
            publication.deploymentId,
            publication.deploymentRequestedAt,
            publication.detail,
            publication.leaseToken,
            publication.leaseExpiresAt,
            publication.updatedAt,
            mutationToken,
            publication.id,
            expectedLeaseToken,
            expectedLeaseValidAt,
            expectedStatus,
            expectedUpdatedAt,
          ),
        auditStatement(publication, mutationToken),
      ]);
      if ((results[0]?.meta.changes ?? 0) < 1) {
        const current = await findPublication(publication.id);
        if (current !== null) {
          return current;
        }
        throw new Error("content_publication_not_found");
      }
      return publication;
    },
    findPublication,
    findPublicationByIdempotency({
      workspaceId,
      idempotencyKey,
    }) {
      return findPublicationByKey(workspaceId, idempotencyKey);
    },
    findActivePublication,
    async findLatestPublication(workspaceId) {
      const row = await database
        .prepare(
          `${publicationProjection}
           WHERE workspace_id = ?1
           ORDER BY
             CASE
               WHEN status IN (
                 'requested', 'committed', 'building', 'deployed', 'unknown'
               )
               THEN 0
               WHEN status = 'blocked'
                 AND detail = 'publication_in_progress'
               THEN 2
               ELSE 1
             END,
             requested_at DESC,
             id DESC
           LIMIT 1`,
        )
        .bind(workspaceId)
        .first<PublicationRow>();
      return row === null ? null : toPublication(row);
    },
  };
}

import type {
  ContentApproval,
  ContentApprovalFingerprint,
  ContentApprovalId,
  ContentPublication,
  ContentPublicationClaim,
  ContentPublicationEvent,
  ContentPublicationHistoryEntry,
  ContentPublicationId,
  ContentPublicationStatus,
  ContentPublicationStore,
  ContentPublicationMcpAuthority,
  ContentPublicationReservationProof,
  ContentWorkspaceId,
} from "@foundry/application";
import {
  assertContentPublicationIdempotency,
  ContentPublicationIdempotencyError,
  ContentPublicationValidationError,
  ContentApprovalInvalidError,
  createContentActorId,
  createContentApprovalId,
  createContentPublicationId,
  createContentWorkspaceId,
  createHumanMembershipId,
  isBlogPostArtifactFingerprint,
  serializeContentPublicationCommandIdentity,
  serializeContentRestoreIdentity,
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
  revision_content_hash: string | null;
  blog_post_artifacts_json: string | null;
  design_hash: string;
  schema_version: ContentApprovalFingerprint["schemaVersion"];
  renderer_version: string;
  production_base: string;
  artifact_hash: string;
  serialization_version:
    | "foundry.site-definition.canonical-json.v1"
    | "foundry.site-publication-artifacts.v2";
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
  schedule_execution_id: string | null;
  mcp_connection_id: string | null;
  mcp_actor_id: string | null;
  mcp_operation: string | null;
  mcp_required_scopes_json: string | null;
};

type PublicationEventRow = {
  status: ContentPublicationStatus;
  detail: string | null;
  commit_sha: string | null;
  deployment_id: string | null;
  approval_fingerprint: string | null;
  occurred_at: string;
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
    approval.revision_content_hash,
    approval.blog_post_artifacts_json,
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
    mutation_token,
    schedule_execution_id,
    mcp_connection_id,
    mcp_actor_id,
    mcp_operation,
    mcp_required_scopes_json
  FROM content_publications
`;

function toApproval(row: ApprovalRow): ContentApproval {
  const postArtifacts: unknown =
    row.blog_post_artifacts_json === null
      ? []
      : JSON.parse(row.blog_post_artifacts_json);
  if (
    !Array.isArray(postArtifacts) ||
    !postArtifacts.every(isBlogPostArtifactFingerprint)
  ) {
    throw new Error("content_approval_blog_post_artifacts_invalid");
  }
  const fingerprint: ContentApprovalFingerprint = {
    value: row.fingerprint,
    channel: row.channel,
    channelConfigurationHash: row.channel_configuration_hash,
    contentHash: row.content_hash,
    revisionContentHash:
      row.revision_content_hash ?? row.content_hash,
    designHash: row.design_hash,
    schemaVersion: row.schema_version,
    rendererVersion: row.renderer_version,
    productionBase: row.production_base,
    artifactHash: row.artifact_hash,
    serializationVersion: row.serialization_version,
    postArtifacts,
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
    requestedBy: createContentActorId(row.requested_by),
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

export type D1ContentPublicationStore = ContentPublicationStore & {
  hasScheduledPublicationOwnership(input: {
    publicationId: ContentPublicationId;
    executionId?: string;
  }): Promise<boolean>;
};

export function createD1ContentPublicationStore(
  database: D1DatabaseBinding,
): D1ContentPublicationStore {
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

  function requireReplayOwnership(
    row: PublicationRow,
    proof?: ContentPublicationReservationProof,
  ) {
    if (
      (proof === undefined && row.schedule_execution_id !== null) ||
      (
        proof !== undefined &&
        row.schedule_execution_id !== proof.executionId
      )
    ) {
      throw new ContentPublicationValidationError(
        "publication_reservation_lost",
      );
    }
  }

  function insertPublicationStatement(
    publication: ContentPublication,
    requireCurrentApproval: boolean,
    mutationToken: string,
    reservationProof?: ContentPublicationReservationProof,
    authority?: ContentPublicationMcpAuthority,
  ) {
    const currentMcpAuthorityGuard =
      authority === undefined
        ? ""
        : `AND EXISTS (
             SELECT 1
             FROM content_workspaces AS mcp_workspace
             JOIN mcp_connections AS mcp_connection
               ON mcp_connection.site_id = mcp_workspace.site_id
              AND mcp_connection.id = ?22
              AND mcp_connection.actor_id = ?23
              AND mcp_connection.status = 'active'
             WHERE mcp_workspace.workspace_id = ?2
               AND ?24 = CASE
                 WHEN ?21 IS NULL THEN 'foundry.publication.request'
                 ELSE 'foundry.publication.schedule'
               END
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?25) AS required_scope
                 WHERE NOT EXISTS (
                   SELECT 1
                   FROM mcp_connection_scopes AS granted_scope
                   WHERE granted_scope.connection_id = mcp_connection.id
                     AND granted_scope.scope = required_scope.value
                 )
               )
           )`;
    const reservationGuard =
      reservationProof === undefined
        ? `${authority === undefined
            ? `AND EXISTS (
                 SELECT 1
                 FROM content_workspaces AS authority_workspace
                 JOIN human_memberships AS authority_membership
                   ON authority_membership.site_id =
                     authority_workspace.site_id
                  AND authority_membership.id = ?8
                  AND authority_membership.status = 'active'
                  AND authority_membership.role IN ('owner', 'editor')
                 WHERE authority_workspace.workspace_id = ?2
               )`
            : currentMcpAuthorityGuard}
           AND NOT EXISTS (
             SELECT 1
             FROM blog_post_schedule_publication_reservations
             WHERE state = 'reserved'
           )`
        : `AND EXISTS (
             SELECT 1
             FROM blog_post_schedule_publication_reservations AS reservation
             JOIN blog_post_schedule_executions AS execution
               ON execution.execution_id = reservation.execution_id
             JOIN blog_post_schedules AS schedule
               ON schedule.id = execution.schedule_id
             WHERE reservation.execution_id = ?26
               AND reservation.attempt = ?27
               AND reservation.lease_token = ?28
               AND reservation.state = 'reserved'
               AND reservation.publication_idempotency_key = ?6
               AND execution.execution_id = ?26
               AND execution.attempt = ?27
               AND execution.lease_token = ?28
               AND execution.state = 'claimed'
               AND execution.lease_expires_at > ?18
               AND schedule.workspace_id = ?2
               AND schedule.content_revision = ?3
               AND schedule.approval_id = ?4
               AND schedule.approval_fingerprint = ?5
               AND ?8 = CASE
                 WHEN execution.attempt_actor_id = 'system:scheduler'
                   THEN schedule.activated_by
                 ELSE execution.attempt_actor_id
               END
           )
           ${currentMcpAuthorityGuard}`;
    const statement = database.prepare(
      `INSERT INTO content_publications (
           id, workspace_id, revision, approval_id, fingerprint,
           idempotency_key, command_identity, requested_by, contributors_json,
           expected_head, status, commit_sha, deployment_id,
           deployment_requested_at, detail, lease_token, lease_expires_at,
           requested_at, updated_at, mutation_token, schedule_execution_id,
           mcp_connection_id, mcp_actor_id, mcp_operation,
           mcp_required_scopes_json
         )
         SELECT
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25
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
              )
              ${reservationGuard}`
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
        reservationProof?.executionId ?? null,
        authority?.connectionId ?? null,
        authority?.actorId ?? null,
        authority?.operation ?? null,
        authority === undefined
          ? null
          : JSON.stringify([...authority.requiredScopes].sort()),
        ...(reservationProof === undefined
          ? []
          : [
              reservationProof.executionId,
              reservationProof.attempt,
              reservationProof.leaseToken,
            ]),
      );
  }

  function auditStatement(
    publication: ContentPublication,
    mutationToken: string,
  ) {
    return database
      .prepare(
        `INSERT INTO content_publication_audit_events (
           publication_id, status, detail, commit_sha, deployment_id,
           approval_fingerprint, occurred_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (
           SELECT 1 FROM content_publications
           WHERE id = ?1
             AND mutation_token = ?8
         )`,
      )
      .bind(
        publication.id,
        publication.status,
        publication.detail,
        publication.commitSha,
        publication.deploymentId,
        publication.fingerprint,
        publication.updatedAt,
        mutationToken,
      );
  }

  function reconciliationOrderStatement(
    publication: ContentPublication,
    mutationToken: string,
  ) {
    return database
      .prepare(
        `INSERT INTO blog_publication_reconciliation_order (publication_id)
         SELECT id
         FROM content_publications
         WHERE id = ?1 AND mutation_token = ?2
         ON CONFLICT (publication_id) DO NOTHING`,
      )
      .bind(publication.id, mutationToken);
  }

  function mcpAuditStatement(
    publication: ContentPublication,
    mutationToken: string,
    authority?: ContentPublicationMcpAuthority,
  ) {
    const audit = authority?.audit;
    if (audit === undefined) return null;
    return database
      .prepare(
        `INSERT INTO mcp_audit_events (
           invocation_id, connection_id, actor_id, site_id, operation,
           input_hash, protocol_version, scopes_json, outcome, reason,
           human_actor_id, revocation_reason, occurred_at, contract_version,
           idempotency_key, result_hash, replayed, workspace_id, revision,
           approval_id, publication_id, schedule_id
         )
         SELECT
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'allowed', NULL,
           NULL, NULL, ?9, ?10, ?11, ?12, 0, ?13, ?14, ?15, ?16, NULL
         WHERE EXISTS (
           SELECT 1 FROM content_publications
           WHERE id = ?16 AND mutation_token = ?17
         )
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
        audit.resultHash,
        audit.workspaceId,
        audit.revision,
        audit.approvalId,
        publication.id,
        mutationToken,
      );
  }

  async function insertPublication(
    publication: ContentPublication,
    requireCurrentApproval: boolean,
    reservationProof?: ContentPublicationReservationProof,
    authority?: ContentPublicationMcpAuthority,
  ) {
    const mutationToken = crypto.randomUUID();
    const linkedAudit = mcpAuditStatement(
      publication,
      mutationToken,
      authority,
    );
    const results = await database.batch([
      insertPublicationStatement(
        publication,
        requireCurrentApproval,
        mutationToken,
        reservationProof,
        authority,
      ),
      auditStatement(publication, mutationToken),
      reconciliationOrderStatement(publication, mutationToken),
      ...(linkedAudit === null ? [] : [linkedAudit]),
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

  async function reservationProofIsCurrent(
    publication: ContentPublication,
    proof: ContentPublicationReservationProof,
  ) {
    const row = await database
      .prepare(
        `SELECT 1 AS valid
         FROM blog_post_schedule_publication_reservations AS reservation
         JOIN blog_post_schedule_executions AS execution
           ON execution.execution_id = reservation.execution_id
         JOIN blog_post_schedules AS schedule
           ON schedule.id = execution.schedule_id
         WHERE reservation.execution_id = ?1
           AND reservation.attempt = ?2
           AND reservation.lease_token = ?3
           AND reservation.state = 'reserved'
           AND reservation.publication_idempotency_key = ?4
           AND execution.attempt = ?2
           AND execution.lease_token = ?3
           AND execution.state = 'claimed'
           AND execution.lease_expires_at > ?5
           AND schedule.workspace_id = ?6
           AND schedule.content_revision = ?7
           AND schedule.approval_id = ?8
           AND schedule.approval_fingerprint = ?9
           AND ?10 = CASE
             WHEN execution.attempt_actor_id = 'system:scheduler'
               THEN schedule.activated_by
             ELSE execution.attempt_actor_id
           END`,
      )
      .bind(
        proof.executionId,
        proof.attempt,
        proof.leaseToken,
        publication.idempotencyKey,
        publication.requestedAt,
        publication.workspaceId,
        publication.revision,
        publication.approvalId,
        publication.fingerprint,
        publication.requestedBy,
      )
      .first<{ valid: number }>();
    return row !== null;
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
      try {
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
               revision_content_hash,
               blog_post_artifacts_json,
               schema_version, renderer_version, production_base,
               artifact_hash, serialization_version, approved_by, approved_at
             )
             SELECT
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17
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
            approval.fingerprint.revisionContentHash ??
              approval.fingerprint.contentHash,
            JSON.stringify(approval.fingerprint.postArtifacts),
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
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("blog_post_collection_authority_stale")
        ) {
          throw new ContentApprovalInvalidError("approval_stale");
        }
        throw error;
      }
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
    async claimPublication(
      publication,
      reservationProof,
      authority,
    ): Promise<ContentPublicationClaim> {
      const replayRow = await findPublicationRowByKey(
        publication.workspaceId,
        publication.idempotencyKey,
      );
      if (replayRow !== null) {
        requireReplayOwnership(replayRow, reservationProof);
        assertContentPublicationIdempotency(
          replayRow.command_identity,
          publication,
        );
        return {
          state: "replayed",
          publication: toPublication(replayRow),
        };
      }
      if (reservationProof === undefined) {
        const attributed = await database
          .prepare(
            `SELECT 1 AS attributed
             FROM blog_post_schedule_publication_attributions
             WHERE publication_idempotency_key = ?1`,
          )
          .bind(publication.idempotencyKey)
          .first<{ attributed: number }>();
        if (attributed !== null) {
          throw new ContentPublicationValidationError(
            "publication_reservation_lost",
          );
        }
        const reservation = await database
          .prepare(
            `SELECT publication_idempotency_key
             FROM blog_post_schedule_publication_reservations
             WHERE state = 'reserved'
             LIMIT 1`,
          )
          .first<{ publication_idempotency_key: string }>();
        if (
          reservation?.publication_idempotency_key ===
          publication.idempotencyKey
        ) {
          throw new ContentPublicationValidationError(
            "publication_reservation_lost",
          );
        }
        if (reservation !== null) {
          const blocked = {
            ...publication,
            status: "blocked" as const,
            detail: "publication_in_progress",
            leaseToken: null,
            leaseExpiresAt: null,
          };
          await insertPublication(blocked, false, undefined, authority);
          return { state: "blocked", publication: blocked };
        }
      }
      if (
        reservationProof !== undefined &&
        !(await reservationProofIsCurrent(publication, reservationProof))
      ) {
        throw new ContentPublicationValidationError(
          "publication_reservation_lost",
        );
      }
      try {
        const inserted = await insertPublication(
          publication,
          true,
          reservationProof,
          authority,
        );
        if (inserted < 1) {
          if (
            reservationProof !== undefined &&
            !(await reservationProofIsCurrent(
              publication,
              reservationProof,
            ))
          ) {
            throw new ContentPublicationValidationError(
              "publication_reservation_lost",
            );
          }
          if (authority !== undefined) {
            throw new ContentPublicationValidationError(
              "publication_authority_not_current",
            );
          }
          if (reservationProof === undefined) {
            const currentRequester = await database
              .prepare(
                `SELECT 1 AS allowed
                 FROM content_workspaces AS workspace
                 JOIN human_memberships AS membership
                   ON membership.site_id = workspace.site_id
                  AND membership.id = ?1
                  AND membership.status = 'active'
                  AND membership.role IN ('owner', 'editor')
                 WHERE workspace.workspace_id = ?2`,
              )
              .bind(
                publication.requestedBy,
                publication.workspaceId,
              )
              .first();
            if (currentRequester === null) {
              throw new ContentPublicationValidationError(
                "publication_requester_not_active",
              );
            }
          }
          const blocked = {
            ...publication,
            status: "blocked" as const,
            detail: "approval_stale",
            leaseToken: null,
            leaseExpiresAt: null,
          };
          await insertPublication(
            blocked,
            false,
            reservationProof,
            authority,
          );
          return { state: "blocked", publication: blocked };
        }
      } catch (error) {
        const racedReplay = await findPublicationRowByKey(
          publication.workspaceId,
          publication.idempotencyKey,
        );
        if (racedReplay !== null) {
          requireReplayOwnership(racedReplay, reservationProof);
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
          error instanceof Error &&
          error.message.includes("blog_post_collection_authority_stale")
        ) {
          const blocked = {
            ...publication,
            status: "blocked" as const,
            detail: "approval_stale",
            leaseToken: null,
            leaseExpiresAt: null,
          };
          await insertPublication(
            blocked,
            false,
            reservationProof,
            authority,
          );
          return { state: "blocked", publication: blocked };
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
          await insertPublication(
            blocked,
            false,
            reservationProof,
            authority,
          );
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
             )
             AND (
               mcp_connection_id IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM content_workspaces AS mcp_workspace
                 JOIN mcp_connections AS mcp_connection
                   ON mcp_connection.site_id = mcp_workspace.site_id
                  AND mcp_connection.id =
                        content_publications.mcp_connection_id
                  AND mcp_connection.actor_id =
                        content_publications.mcp_actor_id
                  AND mcp_connection.status = 'active'
                 WHERE mcp_workspace.workspace_id =
                       content_publications.workspace_id
                   AND content_publications.mcp_operation = CASE
                     WHEN content_publications.schedule_execution_id IS NULL
                       THEN 'foundry.publication.request'
                     ELSE 'foundry.publication.schedule'
                   END
                   AND NOT EXISTS (
                     SELECT 1
                     FROM json_each(
                       content_publications.mcp_required_scopes_json
                     ) AS required_scope
                     WHERE NOT EXISTS (
                       SELECT 1
                       FROM mcp_connection_scopes AS granted_scope
                       WHERE granted_scope.connection_id =
                             mcp_connection.id
                         AND granted_scope.scope = required_scope.value
                     )
                   )
               )
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
      reservationProof,
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
             )
             AND (
               mcp_connection_id IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM content_workspaces AS mcp_workspace
                 JOIN mcp_connections AS mcp_connection
                   ON mcp_connection.site_id = mcp_workspace.site_id
                  AND mcp_connection.id =
                        content_publications.mcp_connection_id
                  AND mcp_connection.actor_id =
                        content_publications.mcp_actor_id
                  AND mcp_connection.status = 'active'
                 WHERE mcp_workspace.workspace_id =
                       content_publications.workspace_id
                   AND content_publications.mcp_operation = CASE
                     WHEN content_publications.schedule_execution_id IS NULL
                       THEN 'foundry.publication.request'
                     ELSE 'foundry.publication.schedule'
                   END
                   AND NOT EXISTS (
                     SELECT 1
                     FROM json_each(
                       content_publications.mcp_required_scopes_json
                     ) AS required_scope
                     WHERE NOT EXISTS (
                       SELECT 1
                       FROM mcp_connection_scopes AS granted_scope
                       WHERE granted_scope.connection_id =
                             mcp_connection.id
                         AND granted_scope.scope = required_scope.value
                     )
                   )
               )
             )
             AND (
               NOT EXISTS (
                 SELECT 1
                 FROM blog_post_schedule_publication_reservations
                 WHERE publication_idempotency_key =
                       content_publications.idempotency_key
               )
               OR (
                 ?9 IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                   FROM blog_post_schedule_publication_reservations AS reservation
                   JOIN blog_post_schedule_executions AS execution
                     ON execution.execution_id = reservation.execution_id
                   WHERE reservation.publication_idempotency_key =
                           content_publications.idempotency_key
                     AND reservation.execution_id = ?9
                     AND content_publications.schedule_execution_id = ?9
                     AND reservation.attempt = ?10
                     AND reservation.lease_token = ?11
                     AND reservation.state = 'reserved'
                     AND execution.state = 'claimed'
                     AND execution.attempt = ?10
                     AND execution.lease_token = ?11
                     AND execution.lease_expires_at > ?4
                 )
               )
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
          reservationProof?.executionId ?? null,
          reservationProof?.attempt ?? null,
          reservationProof?.leaseToken ?? null,
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
      const reservationProof = options?.reservationProof;
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
               )
               AND (
                 NOT EXISTS (
                   SELECT 1
                   FROM blog_post_schedule_publication_reservations
                   WHERE publication_idempotency_key =
                         content_publications.idempotency_key
                 )
                 OR (
                   ?15 IS NOT NULL
                   AND EXISTS (
                     SELECT 1
                     FROM blog_post_schedule_publication_reservations AS reservation
                     JOIN blog_post_schedule_executions AS execution
                       ON execution.execution_id = reservation.execution_id
                     WHERE reservation.publication_idempotency_key =
                             content_publications.idempotency_key
                       AND reservation.execution_id = ?15
                       AND content_publications.schedule_execution_id = ?15
                       AND reservation.attempt = ?16
                       AND reservation.lease_token = ?17
                       AND reservation.state = 'reserved'
                       AND execution.state = 'claimed'
                       AND execution.attempt = ?16
                       AND execution.lease_token = ?17
                       AND execution.lease_expires_at > ?8
                   )
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
            reservationProof?.executionId ?? null,
            reservationProof?.attempt ?? null,
            reservationProof?.leaseToken ?? null,
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
    async hasScheduledPublicationOwnership({
      publicationId,
      executionId,
    }) {
      const row = await database
        .prepare(
          `SELECT 1 AS owned
           FROM content_publications AS publication
           JOIN blog_post_schedule_executions AS execution
             ON execution.execution_id =
                publication.schedule_execution_id
           JOIN blog_post_schedule_publication_attributions AS attribution
             ON attribution.schedule_id = execution.schedule_id
            AND attribution.publication_idempotency_key =
                publication.idempotency_key
           WHERE publication.id = ?1
             AND (?2 IS NULL OR execution.execution_id = ?2)`,
        )
        .bind(publicationId, executionId ?? null)
        .first<{ owned: number }>();
      return row !== null;
    },
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
    async claimRestoreIdentity(input) {
      const requestIdentity = serializeContentRestoreIdentity(input);
      await database
        .prepare(
          `INSERT INTO content_publication_restore_identities (
             workspace_id, source_publication_id, actor_id,
             idempotency_key, request_identity
           ) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (workspace_id) DO NOTHING`,
        )
        .bind(
          input.workspaceId,
          input.sourcePublicationId,
          input.actorId,
          input.idempotencyKey,
          requestIdentity,
        )
        .run();
      const recorded = await database
        .prepare(
          `SELECT request_identity
           FROM content_publication_restore_identities
           WHERE workspace_id = ?1`,
        )
        .bind(input.workspaceId)
        .first<{ request_identity: string }>();
      if (
        recorded === null ||
        recorded.request_identity !== requestIdentity
      ) {
        throw new ContentPublicationIdempotencyError();
      }
    },
    async listPublicationHistory(limit = 50) {
      const boundedLimit = Math.min(Math.max(limit, 1), 100);
      const rows = await database
        .prepare(
          `${publicationProjection}
           ORDER BY requested_at DESC, id DESC
           LIMIT ?1`,
        )
        .bind(boundedLimit)
        .all<PublicationRow>();
      const statements = rows.results.flatMap((row) => [
        database
          .prepare(`${approvalProjection} WHERE approval.id = ?1`)
          .bind(row.approval_id),
        database
          .prepare(
            `SELECT
               status, detail, commit_sha, deployment_id,
               approval_fingerprint, occurred_at
             FROM content_publication_audit_events
             WHERE publication_id = ?1
             ORDER BY id`,
          )
          .bind(row.id),
      ]);
      const evidence =
        statements.length === 0 ? [] : await database.batch(statements);
      const history: ContentPublicationHistoryEntry[] = [];
      for (const [index, row] of rows.results.entries()) {
        const publication = toPublication(row);
        const approvalRow = evidence[index * 2]?.results?.[0] as
          | ApprovalRow
          | undefined;
        if (approvalRow === undefined) {
          continue;
        }
        const approval = toApproval(approvalRow);
        const eventRows = (evidence[index * 2 + 1]?.results ??
          []) as PublicationEventRow[];
        const events: ContentPublicationEvent[] = eventRows.map(
          (event) => ({
            status: event.status,
            detail: event.detail,
            commitSha: event.commit_sha,
            deploymentId: event.deployment_id,
            approvalFingerprint:
              event.approval_fingerprint ?? publication.fingerprint,
            occurredAt: event.occurred_at,
          }),
        );
        history.push({ publication, approval, events });
      }
      return history;
    },
  };
}

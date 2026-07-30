import {
  BlogPostOperationError,
  createBlogPostOperationsApplication,
  createContentApprovalId,
  createContentWorkspaceId,
  type BlogPostApprovalEvidence,
  type BlogPostArchiveResult,
  type BlogPostOperationalState,
  type BlogPostOperationsStore,
  type BlogPostSchedule,
  type BlogPostScheduleExecution,
  type BlogPostScheduleProposal,
  type ContentActorId,
  type McpBlogScheduleAuthority,
  type RestoredBlogPostDraft,
} from "@foundry/application";
import type { BlogPostId, SiteId } from "@foundry/site-definition";
import type { SiteDefinition } from "@foundry/site-definition";

import {
  prepareAcceptedBlogPostAudit,
  recordD1BlogPostAudit,
} from "./d1-blog-post-operation-audit";
import type { D1DatabaseBinding } from "./d1-human-access-store";

type ScheduleRow = {
  id: string;
  site_id: string;
  post_id: string;
  workspace_id: string;
  content_revision: number;
  post_revision_id: string;
  approval_id: string;
  approval_fingerprint: string;
  authority_post_revision_id: string;
  authority_version: number;
  local_date_time: string;
  iana_time_zone: string;
  utc_offset_choice: string;
  execute_at_utc: string;
  time_zone_database_version: string;
  created_by: string;
  activated_by: string;
  activation_audit_id: string;
  activated_at: string;
  state: BlogPostSchedule["state"];
  detail: string | null;
};

type ScheduleProposalRow = {
  id: string;
  site_id: string;
  post_id: string;
  workspace_id: string;
  content_revision: number;
  post_revision_id: string;
  authority_version: number;
  local_date_time: string;
  iana_time_zone: string;
  utc_offset_choice: string;
  execute_at_utc: string;
  time_zone_database_version: string;
  created_by: string;
  proposal_audit_id: string;
  created_at: string;
};

type ExecutionRow = {
  execution_id: string;
  schedule_id: string;
  publication_idempotency_key: string;
  scheduled_instant: string;
  attempt: number;
  attempt_actor_id: string;
  attempt_request_id: string;
  lease_token: string;
  lease_expires_at: string;
  outcome_request_id: string | null;
  outcome_response_json: string | null;
  state: BlogPostScheduleExecution["state"];
  detail: string | null;
  claimed_at: string;
  updated_at: string;
};

function parseApprovalArtifacts(
  value: string | null,
): ReadonlyArray<{ postId: string; postRevisionId: string }> {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (
        artifact,
      ): artifact is { postId: string; postRevisionId: string } =>
        typeof artifact === "object" &&
        artifact !== null &&
        typeof (artifact as { postId?: unknown }).postId === "string" &&
        typeof (artifact as { postRevisionId?: unknown }).postRevisionId ===
          "string",
    );
  } catch {
    return [];
  }
}

function scheduleFromRow(row: ScheduleRow): BlogPostSchedule {
  return {
    id: row.id,
    siteId: row.site_id,
    postId: row.post_id,
    workspaceId: createContentWorkspaceId(row.workspace_id),
    contentRevision: row.content_revision,
    postRevisionId: row.post_revision_id,
    approvalId: createContentApprovalId(row.approval_id),
    approvalFingerprint: row.approval_fingerprint,
    authorityPostRevisionId: row.authority_post_revision_id,
    authorityVersion: row.authority_version,
    localDateTime: row.local_date_time,
    ianaTimeZone: row.iana_time_zone,
    utcOffsetChoice: row.utc_offset_choice,
    executeAtUtc: row.execute_at_utc,
    timeZoneDatabaseVersion: row.time_zone_database_version,
    createdBy: row.created_by as BlogPostSchedule["createdBy"],
    activatedBy: row.activated_by as BlogPostSchedule["activatedBy"],
    activationAuditId: row.activation_audit_id,
    activatedAt: row.activated_at,
    state: row.state,
    detail: row.detail,
  };
}

async function prepareMcpScheduleAudit(
  database: D1DatabaseBinding,
  authority: McpBlogScheduleAuthority | undefined,
  schedule: BlogPostSchedule,
  command: "activate" | "cancel",
  requestId: string,
) {
  const audit = authority?.audit;
  if (audit === undefined) return null;
  const resultHash = await audit.deriveResultHash({
    operationId: schedule.id,
    state: schedule.state,
  });
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
         NULL, NULL, ?9, ?10, ?11, ?12, 0, ?13, ?14, ?15, NULL, ?16
       WHERE (
         ?17 = 'activate'
         AND EXISTS (
           SELECT 1 FROM blog_post_schedules
           WHERE id = ?16 AND idempotency_key = ?18
         )
       ) OR (
         ?17 = 'cancel'
         AND EXISTS (
           SELECT 1 FROM blog_post_schedule_cancellations
           WHERE site_id = ?4 AND schedule_id = ?16 AND request_id = ?18
         )
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
      resultHash,
      audit.workspaceId,
      audit.revision,
      audit.approvalId,
      schedule.id,
      command,
      requestId,
    );
}

function scheduleProposalFromRow(
  row: ScheduleProposalRow,
): BlogPostScheduleProposal {
  return {
    id: row.id,
    siteId: row.site_id,
    postId: row.post_id,
    workspaceId: createContentWorkspaceId(row.workspace_id),
    contentRevision: row.content_revision,
    postRevisionId: row.post_revision_id,
    authorityVersion: row.authority_version,
    localDateTime: row.local_date_time,
    ianaTimeZone: row.iana_time_zone,
    utcOffsetChoice: row.utc_offset_choice,
    executeAtUtc: row.execute_at_utc,
    timeZoneDatabaseVersion: row.time_zone_database_version,
    createdBy: row.created_by as BlogPostScheduleProposal["createdBy"],
    proposalAuditId: row.proposal_audit_id,
    createdAt: row.created_at,
  };
}

function scheduleProposalMatches(
  row: ScheduleProposalRow,
  proposal: BlogPostScheduleProposal,
) {
  return (
    row.workspace_id === proposal.workspaceId &&
    row.content_revision === proposal.contentRevision &&
    row.post_revision_id === proposal.postRevisionId &&
    row.authority_version === proposal.authorityVersion &&
    row.local_date_time === proposal.localDateTime &&
    row.iana_time_zone === proposal.ianaTimeZone &&
    row.utc_offset_choice === proposal.utcOffsetChoice &&
    row.execute_at_utc === proposal.executeAtUtc &&
    row.time_zone_database_version === proposal.timeZoneDatabaseVersion &&
    row.created_by === proposal.createdBy &&
    row.proposal_audit_id === proposal.proposalAuditId
  );
}

function executionFromRow(
  row: ExecutionRow,
): BlogPostScheduleExecution {
  return {
    executionId: row.execution_id,
    scheduleId: row.schedule_id,
    publicationIdempotencyKey: row.publication_idempotency_key,
    scheduledInstant: row.scheduled_instant,
    attempt: row.attempt,
    attemptActorId: row.attempt_actor_id,
    attemptRequestId: row.attempt_request_id,
    leaseExpiresAt: row.lease_expires_at,
    state: row.state,
    detail: row.detail,
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

function leasedExecutionFromRow(
  row: ExecutionRow,
  schedule: ScheduleRow,
) {
  const execution = executionFromRow(row);
  return {
    siteId: schedule.site_id,
    postId: schedule.post_id,
    execution,
    leaseToken: row.lease_token,
  };
}

export function createD1BlogPostOperationsStore(
  database: D1DatabaseBinding,
): BlogPostOperationsStore {
  async function hasActivePublicationForPost(
    siteId: SiteId | string,
    postId: BlogPostId | string,
  ) {
    return (await database
      .prepare(
        `SELECT 1 AS active
         FROM content_publications AS publication
         JOIN content_approvals AS approval
           ON approval.id = publication.approval_id
         JOIN content_workspaces AS workspace
           ON workspace.workspace_id = approval.workspace_id
         JOIN json_each(
           COALESCE(approval.blog_post_artifacts_json, '[]')
         ) AS artifact
         WHERE workspace.site_id = ?1
           AND json_extract(artifact.value, '$.postId') = ?2
           AND (
             publication.status IN (
               'requested', 'committed', 'building', 'deployed', 'unknown'
             )
             OR (
               publication.status = 'verified-live'
               AND NOT EXISTS (
                 SELECT 1
                 FROM blog_posts AS reconciled_post
                 JOIN blog_publication_reconciliation_order
                   AS reconciliation
                   ON reconciliation.publication_id = publication.id
                 WHERE reconciled_post.site_id = workspace.site_id
                   AND reconciled_post.post_id = ?2
                   AND reconciled_post.last_verified_publication_sequence >=
                       reconciliation.sequence
               )
             )
           )
         LIMIT 1`,
      )
      .bind(siteId, postId)
      .first()) !== null;
  }

  async function withScheduleAuthorityErrors<Result>(
    operation: () => Promise<Result>,
    ownedPublicationIdempotencyKey?: string,
  ): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("blog_post_schedule_in_flight")
      ) {
        throw new BlogPostOperationError(
          "production_operation_in_progress",
        );
      }
      if (
        error instanceof Error &&
        error.message.includes(
          "blog_post_schedule_publication_ownership_conflict",
        )
      ) {
        throw new BlogPostOperationError(
          "production_operation_in_progress",
        );
      }
      if (
        !(error instanceof Error) ||
        !error.message.includes("blog_post_schedule_authority_stale")
      ) {
        throw error;
      }
      if (ownedPublicationIdempotencyKey !== undefined) {
        const activePublication = await database
          .prepare(
            `SELECT 1 AS active
             FROM content_publications
             WHERE status IN (
               'requested', 'committed', 'building', 'deployed', 'unknown'
             )
               AND idempotency_key <> ?1
             LIMIT 1`,
          )
          .bind(ownedPublicationIdempotencyKey)
          .first<{ active: number }>();
        const activeReservation = await database
          .prepare(
            `SELECT 1 AS active
             FROM blog_post_schedule_publication_reservations
             WHERE state = 'reserved'
               AND publication_idempotency_key <> ?1
             LIMIT 1`,
          )
          .bind(ownedPublicationIdempotencyKey)
          .first<{ active: number }>();
        if (
          activePublication !== null ||
          activeReservation !== null
        ) {
          throw new BlogPostOperationError(
            "production_operation_in_progress",
          );
        }
      }
      throw new BlogPostOperationError("approval_stale");
    }
  }

  async function findScheduleRow(id: string) {
    return database
      .prepare(
        `SELECT id, site_id, post_id, workspace_id, content_revision,
                post_revision_id, approval_id, approval_fingerprint,
                authority_post_revision_id, authority_version,
                local_date_time, iana_time_zone, utc_offset_choice,
                execute_at_utc, time_zone_database_version, created_by,
                activated_by, activation_audit_id, activated_at, state, detail
         FROM blog_post_schedules
         WHERE id = ?1`,
      )
      .bind(id)
      .first<ScheduleRow>();
  }

  async function findExecutionRow(executionId: string) {
    return database
      .prepare(
        `SELECT execution_id, schedule_id, scheduled_instant,
                publication_idempotency_key, attempt, state, detail,
                attempt_actor_id, attempt_request_id,
                claimed_at, updated_at, lease_token, lease_expires_at,
                outcome_request_id, outcome_response_json
         FROM blog_post_schedule_executions
         WHERE execution_id = ?1`,
      )
      .bind(executionId)
      .first<ExecutionRow>();
  }

  async function requireRevision(
    siteId: SiteId | string,
    postId: BlogPostId | string,
    revisionId: string,
  ) {
    const row = await database
      .prepare(
        `SELECT revision_id
         FROM blog_post_revisions
         WHERE site_id = ?1 AND post_id = ?2 AND revision_id = ?3`,
      )
      .bind(siteId, postId, revisionId)
      .first<{ revision_id: string }>();
    if (row === null) {
      throw new BlogPostOperationError("revision_not_found");
    }
  }

  const store: BlogPostOperationsStore = {
    async findPost(siteId, postId) {
      const row = await database
        .prepare(
          `SELECT post.site_id, post.post_id,
                  revision.workspace_id, revision.content_revision,
                  post.current_revision, post.current_revision_id,
                  COALESCE(state.collection_state, 'active') AS collection_state,
                  COALESCE(state.workflow_state, 'editing') AS workflow_state,
                  CASE WHEN post.live_revision IS NULL
                    THEN NULL
                    ELSE live_revision.revision_id
                  END AS live_revision_id,
                  post.version
           FROM blog_posts AS post
           JOIN blog_post_revisions AS revision
             ON revision.revision_id = post.current_revision_id
           LEFT JOIN blog_post_revisions AS live_revision
             ON live_revision.site_id = post.site_id
            AND live_revision.post_id = post.post_id
            AND live_revision.revision = post.live_revision
           LEFT JOIN blog_post_collection_states AS state
             ON state.site_id = post.site_id
            AND state.post_id = post.post_id
           WHERE post.site_id = ?1 AND post.post_id = ?2`,
        )
        .bind(siteId, postId)
        .first<{
          site_id: string;
          post_id: string;
          workspace_id: string;
          content_revision: number;
          current_revision: number;
          current_revision_id: string;
          collection_state: BlogPostOperationalState["collectionState"];
          workflow_state: BlogPostOperationalState["workflowState"];
          live_revision_id: string | null;
          version: number;
        }>();
      return row === null
        ? null
        : {
            siteId: row.site_id,
            postId: row.post_id,
            workspaceId: createContentWorkspaceId(row.workspace_id),
            contentRevision: row.content_revision,
            postRevision: row.current_revision,
            postRevisionId: row.current_revision_id,
            collectionState: row.collection_state,
            workflowState: row.workflow_state,
            liveRevisionId: row.live_revision_id,
            version: row.version,
          };
    },
    async findApproval(approvalId) {
      const row = await database
        .prepare(
          `SELECT approval.id, approval.workspace_id, workspace.site_id,
                  approval.revision,
                  approval.fingerprint,
                  COALESCE(
                    approval.blog_post_artifacts_json,
                    '[]'
                  ) AS blog_post_artifacts_json,
                  invalidation.invalidated_at
           FROM content_approvals AS approval
           JOIN content_workspaces AS workspace
             ON workspace.workspace_id = approval.workspace_id
           LEFT JOIN content_approval_invalidations AS invalidation
             ON invalidation.approval_id = approval.id
           WHERE approval.id = ?1`,
        )
        .bind(approvalId)
        .first<{
          id: string;
          workspace_id: string;
          site_id: string;
          revision: number;
          fingerprint: string;
          blog_post_artifacts_json: string | null;
          invalidated_at: string | null;
        }>();
      if (row === null) {
        return null;
      }
      const artifacts = parseApprovalArtifacts(
        row.blog_post_artifacts_json,
      );
      const result: BlogPostApprovalEvidence = {
        id: createContentApprovalId(row.id),
        siteId: row.site_id,
        workspaceId: createContentWorkspaceId(row.workspace_id),
        contentRevision: row.revision,
        fingerprint: row.fingerprint,
        postArtifacts: artifacts,
        invalidatedAt: row.invalidated_at,
      };
      return result;
    },
    async hasCurrentApprovalAuthority(input) {
      return (await database
        .prepare(
          `SELECT 1 AS current
           FROM blog_posts AS post
           JOIN content_workspaces AS workspace
             ON workspace.workspace_id = ?4
            AND workspace.site_id = post.site_id
            AND workspace.current_revision = ?5
           JOIN content_approvals AS approval
             ON approval.id = ?3
            AND approval.workspace_id = workspace.workspace_id
            AND approval.revision = ?5
            AND approval.fingerprint = ?7
           JOIN blog_post_revisions AS revision
             ON revision.revision_id = ?6
            AND revision.site_id = post.site_id
            AND revision.post_id = post.post_id
            AND revision.workspace_id = workspace.workspace_id
            AND revision.content_revision = approval.revision
           JOIN json_each(
             COALESCE(approval.blog_post_artifacts_json, '[]')
           ) AS artifact
             ON json_extract(artifact.value, '$.postId') = post.post_id
            AND json_extract(artifact.value, '$.postRevisionId') =
                revision.revision_id
            AND json_extract(artifact.value, '$.value') =
                revision.artifact_fingerprint
           WHERE post.site_id = ?1
             AND post.post_id = ?2
             AND post.current_revision_id = ?8
             AND (
               revision.revision > post.current_revision
               OR revision.revision_id = post.current_revision_id
             )
             AND post.version = ?9
             AND NOT EXISTS (
               SELECT 1 FROM content_approval_invalidations
               WHERE approval_id = approval.id
             )
           LIMIT 1`,
        )
        .bind(
          input.siteId,
          input.postId,
          input.approvalId,
          input.workspaceId,
          input.contentRevision,
          input.postRevisionId,
          input.approvalFingerprint,
          input.authorityPostRevisionId,
          input.authorityVersion,
        )
        .first()) !== null;
    },
    async hasHumanContentAuthority(input) {
      return (await database
        .prepare(
          `SELECT id
           FROM human_memberships
           WHERE site_id = ?1 AND id = ?2
             AND status = 'active'
             AND role IN ('owner', 'editor')`,
        )
        .bind(input.siteId, input.actorId)
        .first<{ id: string }>()) !== null;
    },
    async hasScheduleProposalAuthority(input) {
      return (await database
        .prepare(
          `SELECT id
           FROM human_memberships
           WHERE site_id = ?1
             AND id = ?2
             AND status = 'active'
             AND role IN ('owner', 'editor')
           LIMIT 1`,
        )
        .bind(input.siteId, input.actorId)
        .first<{ id: string }>()) !== null;
    },
    async hasMcpScheduleAuthority(input) {
      return (await database
        .prepare(
          `SELECT connection.id
           FROM mcp_connections AS connection
           JOIN mcp_connection_scopes AS scope
             ON scope.connection_id = connection.id
            AND scope.scope = 'publication.schedule'
           WHERE connection.id = ?1
             AND connection.actor_id = ?2
             AND connection.site_id = ?3
             AND connection.status = 'active'
             AND NOT EXISTS (
               SELECT 1
               FROM json_each(?4) AS required
               WHERE NOT EXISTS (
                 SELECT 1
                 FROM mcp_connection_scopes AS granted
                 WHERE granted.connection_id = connection.id
                   AND granted.scope = required.value
               )
             )
           LIMIT 1`,
        )
        .bind(
          input.connectionId,
          input.actorId,
          input.siteId,
          JSON.stringify(input.requiredScopes),
        )
        .first<{ id: string }>()) !== null;
    },
    async findMcpScheduleAuthority(scheduleId) {
      const row = await database
        .prepare(
          `SELECT connection_id, actor_id, operation, required_scopes_json
           FROM mcp_blog_schedule_authorities
           WHERE schedule_id = ?1`,
        )
        .bind(scheduleId)
        .first<{
          connection_id: string;
          actor_id: string;
          operation: "foundry.publication.schedule";
          required_scopes_json: string;
        }>();
      if (row === null) return null;
      const requiredScopes: unknown = JSON.parse(
        row.required_scopes_json,
      );
      if (
        !Array.isArray(requiredScopes) ||
        requiredScopes.some((scope) => typeof scope !== "string")
      ) {
        throw new BlogPostOperationError(
          "mcp_schedule_authority_invalid",
        );
      }
      return {
        kind: "mcp",
        connectionId: row.connection_id,
        actorId: row.actor_id,
        operation: row.operation,
        requiredScopes,
      };
    },
    async findSchedulablePostForApproval(input) {
      const candidates = await database
        .prepare(
          `SELECT post.post_id
           FROM blog_posts AS post
           JOIN blog_post_revisions AS revision
             ON revision.revision_id = post.current_revision_id
            AND revision.site_id = post.site_id
            AND revision.post_id = post.post_id
           JOIN content_workspaces AS workspace
             ON workspace.workspace_id = ?2
            AND workspace.site_id = post.site_id
            AND workspace.current_revision = ?3
           JOIN content_approvals AS approval
             ON approval.id = ?4
            AND approval.workspace_id = workspace.workspace_id
            AND approval.revision = ?3
           JOIN json_each(
             COALESCE(approval.blog_post_artifacts_json, '[]')
           ) AS artifact
             ON json_extract(artifact.value, '$.postId') = post.post_id
            AND json_extract(artifact.value, '$.postRevisionId') =
                revision.revision_id
            AND json_extract(artifact.value, '$.value') =
                revision.artifact_fingerprint
           LEFT JOIN blog_post_collection_states AS collection
             ON collection.site_id = post.site_id
            AND collection.post_id = post.post_id
           WHERE post.site_id = ?1
             AND revision.workspace_id = workspace.workspace_id
             AND revision.content_revision = ?3
             AND COALESCE(collection.collection_state, 'active') =
                 'active'
             AND NOT EXISTS (
               SELECT 1 FROM content_approval_invalidations
               WHERE approval_id = approval.id
             )
           ORDER BY post.post_id
           LIMIT 2`,
        )
        .bind(
          input.siteId,
          input.workspaceId,
          input.contentRevision,
          input.approvalId,
        )
        .all<{ post_id: string }>();
      if (candidates.results.length !== 1) {
        return null;
      }
      return store.findPost(
        input.siteId,
        candidates.results[0]!.post_id,
      );
    },
    async saveScheduleProposal(proposal, idempotencyKey) {
      const replay = await database
        .prepare(
          `SELECT id, site_id, post_id, workspace_id, content_revision,
                  post_revision_id, authority_version,
                  local_date_time, iana_time_zone, utc_offset_choice,
                  execute_at_utc, time_zone_database_version, created_by,
                  proposal_audit_id, created_at
           FROM blog_post_schedule_proposals
           WHERE site_id = ?1 AND idempotency_key = ?3`,
        )
        .bind(proposal.siteId, proposal.postId, idempotencyKey)
        .first<ScheduleProposalRow>();
      if (replay !== null) {
        if (!scheduleProposalMatches(replay, proposal)) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return scheduleProposalFromRow(replay);
      }
      const beforeState = await store.findPost(
        proposal.siteId,
        proposal.postId,
      );
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO blog_post_schedule_proposals (
               id, site_id, post_id, workspace_id, content_revision,
               post_revision_id, authority_version,
               local_date_time, iana_time_zone, utc_offset_choice,
               execute_at_utc, time_zone_database_version, created_by,
               proposal_audit_id, created_at, idempotency_key
             )
             SELECT
               ?1, ?2, ?3, ?4, ?5, ?14, ?15,
               ?6, ?7, ?8, ?9, ?10, ?11, ?16, ?12, ?13
             WHERE EXISTS (
               SELECT 1
               FROM blog_posts AS post
               JOIN blog_post_revisions AS revision
                 ON revision.revision_id = post.current_revision_id
                AND revision.site_id = post.site_id
                AND revision.post_id = post.post_id
               LEFT JOIN blog_post_collection_states AS collection
                 ON collection.site_id = post.site_id
                AND collection.post_id = post.post_id
               WHERE post.site_id = ?2 AND post.post_id = ?3
                 AND COALESCE(collection.collection_state, 'active') = 'active'
                 AND revision.workspace_id = ?4
                 AND revision.content_revision = ?5
                 AND post.current_revision_id = ?14
                 AND post.version = ?15
             )
             AND EXISTS (
               SELECT membership.id
               FROM human_memberships AS membership
               WHERE membership.site_id = ?2
                 AND membership.id = ?11
                 AND membership.status = 'active'
                 AND membership.role IN ('owner', 'editor')
             )
             AND NOT EXISTS (
               SELECT 1 FROM blog_post_operation_audit_events
               WHERE site_id = ?2
                 AND command_type = 'blog.post.schedule.propose'
                 AND request_id = ?13 AND outcome = 'accepted'
             )
             ON CONFLICT (site_id, post_id, idempotency_key) DO NOTHING`,
          )
          .bind(
            proposal.id,
            proposal.siteId,
            proposal.postId,
            proposal.workspaceId,
            proposal.contentRevision,
            proposal.localDateTime,
            proposal.ianaTimeZone,
            proposal.utcOffsetChoice,
            proposal.executeAtUtc,
            proposal.timeZoneDatabaseVersion,
            proposal.createdBy,
            proposal.createdAt,
            idempotencyKey,
            proposal.postRevisionId,
            proposal.authorityVersion,
            proposal.proposalAuditId,
          ),
        prepareAcceptedBlogPostAudit(
          database,
          {
            siteId: proposal.siteId,
            postId: proposal.postId,
            actorId: proposal.createdBy,
            commandType: "blog.post.schedule.propose",
            requestId: idempotencyKey,
            eventId: proposal.proposalAuditId,
            beforeState,
            afterState: proposal,
            occurredAt: proposal.createdAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_schedule_proposals
             WHERE id = ?10 AND site_id = ?11 AND post_id = ?12
           )`,
          [proposal.id, proposal.siteId, proposal.postId],
        ),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const concurrentReplay = await database
          .prepare(
            `SELECT id, site_id, post_id, workspace_id, content_revision,
                    post_revision_id, authority_version,
                    local_date_time, iana_time_zone, utc_offset_choice,
                    execute_at_utc, time_zone_database_version, created_by,
                    proposal_audit_id, created_at
             FROM blog_post_schedule_proposals
             WHERE site_id = ?1 AND idempotency_key = ?3`,
          )
          .bind(proposal.siteId, proposal.postId, idempotencyKey)
          .first<ScheduleProposalRow>();
        if (
          concurrentReplay !== null &&
          scheduleProposalMatches(concurrentReplay, proposal)
        ) {
          return scheduleProposalFromRow(concurrentReplay);
        }
        if (
          concurrentReplay === null &&
          !(await store.hasScheduleProposalAuthority({
            siteId: proposal.siteId,
            postId: proposal.postId,
            actorId: proposal.createdBy,
          }))
        ) {
          throw new BlogPostOperationError(
            "schedule_proposal_authority_required",
          );
        }
        throw new BlogPostOperationError(
          concurrentReplay === null
            ? "schedule_proposal_stale"
            : "idempotency_key_conflict",
        );
      }
      return proposal;
    },
    async findScheduleProposalByRequest(input) {
      const row = await database
        .prepare(
          `SELECT id, site_id, post_id, workspace_id, content_revision,
                  post_revision_id, authority_version,
                  local_date_time, iana_time_zone, utc_offset_choice,
                  execute_at_utc, time_zone_database_version, created_by,
                  proposal_audit_id, created_at
           FROM blog_post_schedule_proposals
           WHERE site_id = ?1 AND idempotency_key = ?3`,
        )
        .bind(input.siteId, input.postId, input.idempotencyKey)
        .first<ScheduleProposalRow>();
      return row === null ? null : scheduleProposalFromRow(row);
    },
    async saveSchedule(schedule, idempotencyKey, authority) {
      const beforeState = await store.findPost(
        schedule.siteId,
        schedule.postId,
      );
      const replay = await database
        .prepare(
          `SELECT id, site_id, post_id, workspace_id, content_revision,
                  post_revision_id, approval_id, approval_fingerprint,
                  authority_post_revision_id, authority_version,
                  local_date_time, iana_time_zone, utc_offset_choice,
                  execute_at_utc, time_zone_database_version, created_by,
                  activated_by, activation_audit_id, activated_at, state, detail
           FROM blog_post_schedules
           WHERE workspace_id = ?1 AND idempotency_key = ?2`,
        )
        .bind(schedule.workspaceId, idempotencyKey)
        .first<ScheduleRow>();
      if (replay !== null) {
        if (
          replay.post_id !== schedule.postId ||
          replay.site_id !== schedule.siteId ||
          replay.workspace_id !== schedule.workspaceId ||
          replay.content_revision !== schedule.contentRevision ||
          replay.post_revision_id !== schedule.postRevisionId ||
          replay.approval_id !== schedule.approvalId ||
          replay.approval_fingerprint !== schedule.approvalFingerprint ||
          replay.authority_post_revision_id !==
            schedule.authorityPostRevisionId ||
          replay.authority_version !== schedule.authorityVersion ||
          replay.local_date_time !== schedule.localDateTime ||
          replay.iana_time_zone !== schedule.ianaTimeZone ||
          replay.utc_offset_choice !== schedule.utcOffsetChoice ||
          replay.execute_at_utc !== schedule.executeAtUtc ||
          replay.time_zone_database_version !==
            schedule.timeZoneDatabaseVersion ||
          replay.created_by !== schedule.createdBy ||
          replay.activated_by !== schedule.activatedBy
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return scheduleFromRow(replay);
      }
      const linkedScheduleAudit = await prepareMcpScheduleAudit(
        database,
        authority,
        schedule,
        "activate",
        idempotencyKey,
      );
      const results = await withScheduleAuthorityErrors(
        () => database.batch([
        database
          .prepare(
            `INSERT INTO blog_post_collection_states (
               site_id, post_id, collection_state, workflow_state,
               version, updated_at
             )
             SELECT ?1, ?2, 'active', 'scheduled', 2, ?3
             WHERE ?5 > ?3
             AND (
               (
                 ?6 IS NULL
                 AND EXISTS (
                   SELECT 1 FROM human_memberships
                   WHERE site_id = ?1 AND id = ?4
                     AND status = 'active'
                     AND role IN ('owner', 'editor')
                 )
               )
               OR (
                 ?6 = 'mcp'
                 AND ?4 = 'mcp-' || ?8
                 AND EXISTS (
                   SELECT 1
                   FROM mcp_connections AS connection
                   JOIN mcp_connection_scopes AS scope
                     ON scope.connection_id = connection.id
                    AND scope.scope = 'publication.schedule'
                   WHERE connection.id = ?7
                     AND connection.actor_id = ?8
                     AND connection.site_id = ?1
                     AND connection.status = 'active'
                     AND NOT EXISTS (
                       SELECT 1 FROM json_each(?9) AS required
                       WHERE NOT EXISTS (
                         SELECT 1 FROM mcp_connection_scopes AS granted
                         WHERE granted.connection_id = connection.id
                           AND granted.scope = required.value
                       )
                     )
                 )
               )
             )
             ON CONFLICT (site_id, post_id) DO UPDATE SET
               workflow_state = 'scheduled',
               version = blog_post_collection_states.version + 1,
               updated_at = excluded.updated_at
             WHERE ?5 > ?3
             AND (
               (
                 ?6 IS NULL
                 AND EXISTS (
                   SELECT 1 FROM human_memberships
                   WHERE site_id = ?1 AND id = ?4
                     AND status = 'active'
                     AND role IN ('owner', 'editor')
                 )
               )
               OR (
                 ?6 = 'mcp'
                 AND ?4 = 'mcp-' || ?8
                 AND EXISTS (
                   SELECT 1
                   FROM mcp_connections AS connection
                   JOIN mcp_connection_scopes AS scope
                     ON scope.connection_id = connection.id
                    AND scope.scope = 'publication.schedule'
                   WHERE connection.id = ?7
                     AND connection.actor_id = ?8
                     AND connection.site_id = ?1
                     AND connection.status = 'active'
                     AND NOT EXISTS (
                       SELECT 1 FROM json_each(?9) AS required
                       WHERE NOT EXISTS (
                         SELECT 1 FROM mcp_connection_scopes AS granted
                         WHERE granted.connection_id = connection.id
                           AND granted.scope = required.value
                       )
                     )
                 )
               )
             )`,
          )
          .bind(
            schedule.siteId,
            schedule.postId,
            schedule.activatedAt,
            schedule.activatedBy,
            schedule.executeAtUtc,
            authority?.kind ?? null,
            authority?.connectionId ?? null,
            authority?.actorId ?? null,
            JSON.stringify(authority?.requiredScopes ?? []),
          ),
        database
          .prepare(
            `UPDATE blog_post_schedules
             SET state = 'cancelled', detail = 'rescheduled'
             WHERE site_id = ?1 AND post_id = ?2 AND state = 'active'
               AND ?4 > ?5
               AND (
                 (
                   ?6 IS NULL
                   AND EXISTS (
                     SELECT 1 FROM human_memberships
                     WHERE site_id = ?1 AND id = ?3
                       AND status = 'active'
                       AND role IN ('owner', 'editor')
                   )
                 )
                 OR (
                   ?6 = 'mcp'
                   AND ?3 = 'mcp-' || ?8
                   AND EXISTS (
                     SELECT 1
                     FROM mcp_connections AS connection
                     JOIN mcp_connection_scopes AS scope
                       ON scope.connection_id = connection.id
                      AND scope.scope = 'publication.schedule'
                     WHERE connection.id = ?7
                       AND connection.actor_id = ?8
                       AND connection.site_id = ?1
                       AND connection.status = 'active'
                       AND NOT EXISTS (
                         SELECT 1 FROM json_each(?9) AS required
                         WHERE NOT EXISTS (
                           SELECT 1 FROM mcp_connection_scopes AS granted
                           WHERE granted.connection_id = connection.id
                             AND granted.scope = required.value
                         )
                       )
                   )
                 )
               )`,
          )
          .bind(
            schedule.siteId,
            schedule.postId,
            schedule.activatedBy,
            schedule.executeAtUtc,
            schedule.activatedAt,
            authority?.kind ?? null,
            authority?.connectionId ?? null,
            authority?.actorId ?? null,
            JSON.stringify(authority?.requiredScopes ?? []),
          ),
        database
          .prepare(
            `INSERT INTO blog_post_schedules (
               id, site_id, post_id, workspace_id, content_revision,
               post_revision_id, approval_id, approval_fingerprint,
               authority_post_revision_id, authority_version,
               local_date_time, iana_time_zone, utc_offset_choice,
               execute_at_utc, time_zone_database_version, created_by,
               activated_by, activation_audit_id, activated_at, state, detail,
               idempotency_key
             )
             SELECT
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
               ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
               'active', NULL, ?20
             WHERE (
               (
                 ?21 IS NULL
                 AND EXISTS (
                   SELECT 1 FROM human_memberships
                   WHERE site_id = ?2 AND id = ?17
                     AND status = 'active'
                     AND role IN ('owner', 'editor')
                 )
               )
               OR (
                 ?21 = 'mcp'
                 AND ?17 = 'mcp-' || ?23
                 AND EXISTS (
                   SELECT 1
                   FROM mcp_connections AS connection
                   JOIN mcp_connection_scopes AS scope
                     ON scope.connection_id = connection.id
                    AND scope.scope = 'publication.schedule'
                   WHERE connection.id = ?22
                     AND connection.actor_id = ?23
                     AND connection.site_id = ?2
                     AND connection.status = 'active'
                     AND NOT EXISTS (
                       SELECT 1 FROM json_each(?24) AS required
                       WHERE NOT EXISTS (
                         SELECT 1 FROM mcp_connection_scopes AS granted
                         WHERE granted.connection_id = connection.id
                           AND granted.scope = required.value
                       )
                     )
                 )
               )
             )
             AND ?14 > ?19`,
          )
          .bind(
            schedule.id,
            schedule.siteId,
            schedule.postId,
            schedule.workspaceId,
            schedule.contentRevision,
            schedule.postRevisionId,
            schedule.approvalId,
            schedule.approvalFingerprint,
            schedule.authorityPostRevisionId,
            schedule.authorityVersion,
            schedule.localDateTime,
            schedule.ianaTimeZone,
            schedule.utcOffsetChoice,
            schedule.executeAtUtc,
            schedule.timeZoneDatabaseVersion,
            schedule.createdBy,
            schedule.activatedBy,
            schedule.activationAuditId,
            schedule.activatedAt,
            idempotencyKey,
            authority?.kind ?? null,
            authority?.connectionId ?? null,
            authority?.actorId ?? null,
            JSON.stringify(authority?.requiredScopes ?? []),
          ),
        database
          .prepare(
            `INSERT INTO blog_post_schedule_publication_attributions (
               schedule_id, publication_idempotency_key, created_at
             )
             SELECT id, ?2, ?3
             FROM blog_post_schedules
             WHERE id = ?1
             ON CONFLICT (schedule_id) DO NOTHING`,
          )
          .bind(
            schedule.id,
            `scheduled-publication:${schedule.id}`,
            schedule.activatedAt,
          ),
        database
          .prepare(
            `INSERT INTO mcp_blog_schedule_authorities (
               schedule_id, connection_id, actor_id, operation,
               required_scopes_json, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
             FROM mcp_connections AS connection
             WHERE ?7 = 'mcp'
               AND connection.id = ?2
               AND connection.actor_id = ?3
               AND connection.site_id = ?8
               AND connection.status = 'active'
               AND EXISTS (
                 SELECT 1 FROM blog_post_schedules WHERE id = ?1
               )
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?5) AS required
                 WHERE NOT EXISTS (
                   SELECT 1 FROM mcp_connection_scopes AS granted
                   WHERE granted.connection_id = connection.id
                     AND granted.scope = required.value
                 )
               )`,
          )
          .bind(
            schedule.id,
            authority?.connectionId ?? null,
            authority?.actorId ?? null,
            authority?.operation ?? "foundry.publication.schedule",
            JSON.stringify(authority?.requiredScopes ?? []),
            schedule.activatedAt,
            authority?.kind ?? null,
            schedule.siteId,
          ),
        prepareAcceptedBlogPostAudit(
          database,
          {
            siteId: schedule.siteId,
            postId: schedule.postId,
            actorId: schedule.activatedBy,
            commandType: "blog.post.schedule.activate",
            requestId: idempotencyKey,
            eventId: schedule.activationAuditId,
            beforeState,
            afterState:
              beforeState === null
                ? null
                : {
                    ...beforeState,
                    workflowState: "scheduled",
                  },
            occurredAt: schedule.activatedAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_schedules
             WHERE id = ?10 AND idempotency_key = ?11
           )`,
          [schedule.id, idempotencyKey],
        ),
        ...(linkedScheduleAudit === null ? [] : [linkedScheduleAudit]),
        ]),
        undefined,
      );
      if ((results[2]?.meta.changes ?? 0) !== 1) {
        const hasAuthority =
          authority === undefined
            ? await store.hasHumanContentAuthority({
                siteId: schedule.siteId,
                actorId: schedule.activatedBy,
              })
            : await store.hasMcpScheduleAuthority({
                siteId: schedule.siteId,
                connectionId: authority.connectionId,
                actorId: authority.actorId,
                requiredScopes: authority.requiredScopes,
              });
        if (!hasAuthority) {
          throw new BlogPostOperationError(
            authority === undefined
              ? "human_authority_required"
              : "mcp_schedule_authority_required",
          );
        }
        throw new BlogPostOperationError("schedule_activation_failed");
      }
      return schedule;
    },
    async findScheduleByRequest(input) {
      const row = await database
        .prepare(
          `SELECT id, site_id, post_id, workspace_id, content_revision,
                  post_revision_id, approval_id, approval_fingerprint,
                  authority_post_revision_id, authority_version,
                  local_date_time, iana_time_zone, utc_offset_choice,
                  execute_at_utc, time_zone_database_version, created_by,
                  activated_by, activation_audit_id, activated_at, state, detail
           FROM blog_post_schedules
           WHERE site_id = ?1 AND post_id = ?2 AND idempotency_key = ?3
           ORDER BY activated_at DESC LIMIT 1`,
        )
        .bind(input.siteId, input.postId, input.idempotencyKey)
        .first<ScheduleRow>();
      return row === null ? null : scheduleFromRow(row);
    },
    async findScheduleByWorkspaceRequest(input) {
      const row = await database
        .prepare(
          `SELECT id, site_id, post_id, workspace_id, content_revision,
                  post_revision_id, approval_id, approval_fingerprint,
                  authority_post_revision_id, authority_version,
                  local_date_time, iana_time_zone, utc_offset_choice,
                  execute_at_utc, time_zone_database_version, created_by,
                  activated_by, activation_audit_id, activated_at, state, detail
           FROM blog_post_schedules
           WHERE site_id = ?1
             AND workspace_id = ?2
             AND idempotency_key = ?3
           ORDER BY activated_at DESC LIMIT 1`,
        )
        .bind(
          input.siteId,
          input.workspaceId,
          input.idempotencyKey,
        )
        .first<ScheduleRow>();
      return row === null ? null : scheduleFromRow(row);
    },
    async findSchedule(scheduleId) {
      const row = await findScheduleRow(scheduleId);
      return row === null ? null : scheduleFromRow(row);
    },
    async findScheduleCancellationByRequest(input) {
      const row = await database
        .prepare(
          `SELECT schedule_id
           FROM blog_post_schedule_cancellations
           WHERE site_id = ?1 AND request_id = ?2`,
        )
        .bind(input.siteId, input.requestId)
        .first<{ schedule_id: string }>();
      if (row === null) return null;
      const schedule = await findScheduleRow(row.schedule_id);
      return schedule === null ? null : scheduleFromRow(schedule);
    },
    async cancelSchedule(input) {
      const findReplay = () =>
        database
          .prepare(
            `SELECT post_id, schedule_id, actor_id, response_json
             FROM blog_post_schedule_cancellations
             WHERE site_id = ?1 AND request_id = ?3`,
          )
          .bind(input.siteId, input.postId, input.requestId)
          .first<{
            post_id: string;
            schedule_id: string;
            actor_id: string;
            response_json: string;
          }>();
      const replay = await findReplay();
      if (replay !== null) {
        if (
          replay.schedule_id !== input.scheduleId ||
          replay.actor_id !== input.actorId ||
          replay.post_id !== input.postId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return JSON.parse(replay.response_json) as BlogPostSchedule;
      }
      const observed = await findScheduleRow(input.scheduleId);
      if (
        observed === null ||
        observed.site_id !== input.siteId ||
        observed.post_id !== input.postId
      ) {
        throw new BlogPostOperationError("schedule_not_found");
      }
      if (observed.state !== "active") {
        throw new BlogPostOperationError("too_late_to_cancel");
      }
      const beforeState = await store.findPost(input.siteId, input.postId);
      const cancelled: BlogPostSchedule = {
        ...scheduleFromRow(observed),
        state: "cancelled",
        detail: "human_cancelled",
      };
      const linkedCancellationAudit = await prepareMcpScheduleAudit(
        database,
        input.authority,
        cancelled,
        "cancel",
        input.requestId,
      );
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO blog_post_schedule_cancellations (
               site_id, post_id, request_id, schedule_id, actor_id,
               response_json, occurred_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
             WHERE EXISTS (
               SELECT 1 FROM blog_post_schedules
               WHERE id = ?4 AND site_id = ?1 AND post_id = ?2
                 AND state = 'active'
             )
             AND (
               (
                 ?8 IS NULL
                 AND EXISTS (
                   SELECT 1 FROM human_memberships
                   WHERE site_id = ?1 AND id = ?5
                     AND status = 'active'
                     AND role IN ('owner', 'editor')
                 )
               )
               OR (
                 ?8 = 'mcp'
                 AND ?5 = 'mcp-' || ?10
                 AND EXISTS (
                   SELECT 1
                   FROM mcp_connections AS connection
                   JOIN mcp_connection_scopes AS scope
                     ON scope.connection_id = connection.id
                    AND scope.scope = 'publication.schedule'
                   WHERE connection.id = ?9
                     AND connection.actor_id = ?10
                     AND connection.site_id = ?1
                     AND connection.status = 'active'
                     AND NOT EXISTS (
                       SELECT 1 FROM json_each(?11) AS required
                       WHERE NOT EXISTS (
                         SELECT 1 FROM mcp_connection_scopes AS granted
                         WHERE granted.connection_id = connection.id
                           AND granted.scope = required.value
                       )
                     )
                 )
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM blog_post_operation_audit_events
               WHERE site_id = ?1
                 AND command_type = 'blog.post.schedule.cancel'
                 AND request_id = ?3 AND outcome = 'accepted'
             )
             ON CONFLICT (site_id, post_id, request_id) DO NOTHING`,
          )
          .bind(
            input.siteId,
            input.postId,
            input.requestId,
            input.scheduleId,
            input.actorId,
            JSON.stringify(cancelled),
            input.occurredAt,
            input.authority?.kind ?? null,
            input.authority?.connectionId ?? null,
            input.authority?.actorId ?? null,
            input.authority === undefined
              ? "[]"
              : JSON.stringify([...input.authority.requiredScopes].sort()),
          ),
        database
          .prepare(
            `UPDATE blog_post_schedules
             SET state = 'cancelled', detail = 'human_cancelled'
             WHERE id = ?1 AND site_id = ?2 AND post_id = ?3
               AND state = 'active'
               AND EXISTS (
                 SELECT 1 FROM blog_post_schedule_cancellations
                 WHERE site_id = ?2 AND post_id = ?3
                   AND request_id = ?4 AND schedule_id = ?1
               )`,
          )
          .bind(
            input.scheduleId,
            input.siteId,
            input.postId,
            input.requestId,
          ),
        database
          .prepare(
            `UPDATE blog_post_collection_states
             SET workflow_state = 'approved',
                 version = version + 1,
                 updated_at = ?1
             WHERE site_id = ?2 AND post_id = ?3
               AND EXISTS (
                 SELECT 1 FROM blog_post_schedule_cancellations
                 WHERE site_id = ?2 AND post_id = ?3
                   AND request_id = ?4 AND schedule_id = ?5
               )`,
          )
          .bind(
            input.occurredAt,
            input.siteId,
            input.postId,
            input.requestId,
            input.scheduleId,
          ),
        prepareAcceptedBlogPostAudit(
          database,
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.schedule.cancel",
            requestId: input.requestId,
            beforeState,
            afterState: cancelled,
            occurredAt: input.occurredAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_schedule_cancellations
             WHERE site_id = ?10 AND post_id = ?11
               AND request_id = ?12 AND schedule_id = ?13
           )`,
          [
            input.siteId,
            input.postId,
            input.requestId,
            input.scheduleId,
          ],
        ),
        ...(linkedCancellationAudit === null
          ? []
          : [linkedCancellationAudit]),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 1) {
        return cancelled;
      }
      const concurrentReplay = await findReplay();
      if (
        concurrentReplay !== null &&
        concurrentReplay.schedule_id === input.scheduleId &&
        concurrentReplay.actor_id === input.actorId
      ) {
        return JSON.parse(
          concurrentReplay.response_json,
        ) as BlogPostSchedule;
      }
      if (concurrentReplay !== null) {
        throw new BlogPostOperationError("idempotency_key_conflict");
      }
      const hasAuthority =
        input.authority === undefined
          ? await store.hasHumanContentAuthority({
              siteId: input.siteId,
              actorId: input.actorId,
            })
          : await store.hasMcpScheduleAuthority({
              siteId: input.siteId,
              connectionId: input.authority.connectionId,
              actorId: input.authority.actorId,
              requiredScopes: input.authority.requiredScopes,
            });
      if (!hasAuthority) {
        throw new BlogPostOperationError(
          input.authority === undefined
            ? "human_authority_required"
            : "mcp_schedule_authority_required",
        );
      }
      throw new BlogPostOperationError("too_late_to_cancel");
    },
    async listDueSchedules(observedAt, limit) {
      const rows = await database
        .prepare(
          `SELECT id, site_id, post_id, workspace_id, content_revision,
                  post_revision_id, approval_id, approval_fingerprint,
                  authority_post_revision_id, authority_version,
                  local_date_time, iana_time_zone, utc_offset_choice,
                  execute_at_utc, time_zone_database_version, created_by,
                  activated_by, activation_audit_id, activated_at, state, detail
           FROM blog_post_schedules
           WHERE state = 'active' AND execute_at_utc <= ?1
           ORDER BY execute_at_utc, id
           LIMIT ?2`,
        )
        .bind(observedAt, Math.min(Math.max(limit, 1), 100))
        .all<ScheduleRow>();
      return rows.results.map(scheduleFromRow);
    },
    async cancelSchedulesForSuccessor(input) {
      await database
        .prepare(
          `UPDATE blog_post_schedules
           SET state = 'cancelled', detail = 'revision_changed'
           WHERE site_id = ?1 AND post_id = ?2
             AND (
               workspace_id <> ?3
               OR content_revision < ?4
             )
             AND state = 'active'`,
        )
        .bind(
          input.siteId,
          input.postId,
          input.workspaceId,
          input.contentRevision,
        )
        .run();
    },
    async claimSchedule(input) {
      const schedule = await findScheduleRow(input.scheduleId);
      if (schedule === null) {
        throw new BlogPostOperationError("schedule_inactive");
      }
      const existing = await database
        .prepare(
          `SELECT execution_id, schedule_id, scheduled_instant,
                  publication_idempotency_key, attempt, state, detail,
                  attempt_actor_id, attempt_request_id,
                  claimed_at, updated_at, lease_token, lease_expires_at,
                  outcome_request_id, outcome_response_json
           FROM blog_post_schedule_executions
           WHERE schedule_id = ?1`,
        )
        .bind(input.scheduleId)
        .first<ExecutionRow>();
      if (existing !== null) {
        if (
          (
            existing.state === "claimed" ||
            existing.state === "unknown"
          ) &&
          existing.lease_expires_at <= input.now
        ) {
          const reclaimedExecution: BlogPostScheduleExecution = {
            ...executionFromRow(existing),
            attempt: existing.attempt + 1,
            attemptActorId: input.attemptActorId,
            attemptRequestId: input.attemptRequestId,
            state: "claimed",
            detail: null,
            leaseExpiresAt: input.leaseExpiresAt,
            updatedAt: input.now,
          };
          const reclaimedResults = await withScheduleAuthorityErrors(
            () => database.batch([
            database.prepare(
              `UPDATE blog_post_schedule_executions
               SET state = 'claimed', detail = NULL,
                   attempt = attempt + 1,
                   attempt_actor_id = ?5, attempt_request_id = ?6,
                   lease_token = ?1, lease_expires_at = ?2,
                   updated_at = ?3, outcome_request_id = NULL,
                   outcome_response_json = NULL
               WHERE execution_id = ?4 AND lease_expires_at <= ?3
                 AND state IN ('claimed', 'unknown')`,
            ).bind(
              input.leaseToken,
              input.leaseExpiresAt,
              input.now,
              existing.execution_id,
              input.attemptActorId,
              input.attemptRequestId,
            ),
            database.prepare(
              `UPDATE blog_post_schedules
               SET state = 'claimed', detail = NULL
               WHERE id = ?1
                 AND EXISTS (
                   SELECT 1 FROM blog_post_schedule_executions
                   WHERE execution_id = ?2 AND lease_token = ?3
                     AND updated_at = ?4
                 )`,
            ).bind(
              input.scheduleId,
              existing.execution_id,
              input.leaseToken,
              input.now,
            ),
            database.prepare(
              `UPDATE blog_post_schedule_publication_reservations
               SET state = 'reserved', released_at = NULL,
                   attempt = ?2, lease_token = ?3
               WHERE execution_id = ?1
                 AND publication_idempotency_key = ?4
                 AND EXISTS (
                   SELECT 1 FROM blog_post_schedule_executions
                   WHERE execution_id = ?1
                     AND attempt = ?2
                     AND lease_token = ?3
                     AND updated_at = ?5
                 )`,
            ).bind(
              existing.execution_id,
              existing.attempt + 1,
              input.leaseToken,
              existing.publication_idempotency_key,
              input.now,
            ),
            prepareAcceptedBlogPostAudit(database,
              {
                siteId: schedule.site_id,
                postId: schedule.post_id,
                actorId: "system:scheduler",
                commandType: "blog.post.schedule.reclaim",
                requestId: `${existing.execution_id}:${input.now}`,
                beforeState: executionFromRow(existing),
                afterState: reclaimedExecution,
                occurredAt: input.now,
              },
              `EXISTS (
                 SELECT 1 FROM blog_post_schedule_executions
                 WHERE execution_id = ?10 AND lease_token = ?11
                   AND updated_at = ?12
               )`,
              [existing.execution_id, input.leaseToken, input.now],
            ),
            ]),
            existing.publication_idempotency_key,
          );
          const row = (await findExecutionRow(existing.execution_id))!;
          if ((reclaimedResults[0]?.meta.changes ?? 0) === 1) {
            const lease = leasedExecutionFromRow(row, schedule);
            return { execution: lease.execution, lease };
          }
          return { execution: executionFromRow(row), lease: null };
        }
        return { execution: executionFromRow(existing), lease: null };
      }
      const claimedExecution: BlogPostScheduleExecution = {
        executionId: input.executionId,
        scheduleId: input.scheduleId,
        publicationIdempotencyKey: input.publicationIdempotencyKey,
        scheduledInstant: schedule.execute_at_utc,
        attempt: 1,
        attemptActorId: input.attemptActorId,
        attemptRequestId: input.attemptRequestId,
        leaseExpiresAt: input.leaseExpiresAt,
        state: "claimed",
        detail: null,
        claimedAt: input.now,
        updatedAt: input.now,
      };
      const results = await withScheduleAuthorityErrors(
        () => database.batch([
        database
          .prepare(
            `UPDATE blog_post_schedules
             SET state = 'claimed'
             WHERE id = ?1 AND state = 'active' AND execute_at_utc <= ?2
             `,
          )
          .bind(input.scheduleId, input.now),
        database
          .prepare(
            `INSERT INTO blog_post_schedule_executions (
               execution_id, schedule_id, scheduled_instant,
               publication_idempotency_key, attempt, state, detail,
               attempt_actor_id, attempt_request_id,
               claimed_at, updated_at, lease_token, lease_expires_at
             )
             SELECT ?1, schedule.id, schedule.execute_at_utc,
                    ?3, 1, 'claimed', NULL, ?7, ?8, ?4, ?4, ?5, ?6
             FROM blog_post_schedules AS schedule
             WHERE schedule.id = ?2 AND schedule.state = 'claimed'
             ON CONFLICT (schedule_id, scheduled_instant) DO NOTHING`,
          )
          .bind(
            input.executionId,
            input.scheduleId,
            input.publicationIdempotencyKey,
            input.now,
            input.leaseToken,
            input.leaseExpiresAt,
            input.attemptActorId,
            input.attemptRequestId,
          ),
        database
          .prepare(
            `INSERT INTO blog_post_schedule_publication_reservations (
               execution_id, publication_idempotency_key, state,
               attempt, lease_token, created_at, released_at
             )
             SELECT execution_id, publication_idempotency_key,
                    'reserved', attempt, lease_token, ?2, NULL
             FROM blog_post_schedule_executions
             WHERE execution_id = ?1 AND lease_token = ?3
             ON CONFLICT (execution_id) DO UPDATE SET
               state = 'reserved',
               attempt = excluded.attempt,
               lease_token = excluded.lease_token,
               released_at = NULL
             WHERE blog_post_schedule_publication_reservations
                     .publication_idempotency_key =
                   excluded.publication_idempotency_key`,
          )
          .bind(input.executionId, input.now, input.leaseToken),
        database
          .prepare(
            `UPDATE blog_post_collection_states
             SET workflow_state = 'executing',
                 version = version + 1,
                 updated_at = ?1
             WHERE site_id = (
                 SELECT site_id FROM blog_post_schedules WHERE id = ?2
               )
               AND post_id = (
                 SELECT post_id FROM blog_post_schedules WHERE id = ?2
               )
               AND EXISTS (
                 SELECT 1 FROM blog_post_schedule_executions
                 WHERE execution_id = ?3 AND lease_token = ?4
               )`,
          )
          .bind(
            input.now,
            input.scheduleId,
            input.executionId,
            input.leaseToken,
          ),
        prepareAcceptedBlogPostAudit(database,
          {
            siteId: schedule.site_id,
            postId: schedule.post_id,
            actorId: "system:scheduler",
            commandType: "blog.post.schedule.claim",
            requestId: input.executionId,
            beforeState: scheduleFromRow(schedule),
            afterState: claimedExecution,
            occurredAt: input.now,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_schedule_executions
             WHERE execution_id = ?10 AND lease_token = ?11
           )`,
          [input.executionId, input.leaseToken],
        ),
        ]),
        input.publicationIdempotencyKey,
      );
      const row =
        (results[1]?.meta.changes ?? 0) === 1
          ? await findExecutionRow(input.executionId)
          : await database
              .prepare(
                `SELECT execution_id, schedule_id, scheduled_instant,
                        publication_idempotency_key, attempt, state, detail,
                        attempt_actor_id, attempt_request_id,
                        claimed_at, updated_at, lease_token,
                        lease_expires_at, outcome_request_id,
                        outcome_response_json
                 FROM blog_post_schedule_executions
                 WHERE schedule_id = ?1`,
              )
              .bind(input.scheduleId)
              .first<ExecutionRow>();
      if (row === null) {
        throw new BlogPostOperationError("schedule_inactive");
      }
      if ((results[1]?.meta.changes ?? 0) === 1) {
        const lease = leasedExecutionFromRow(row, schedule);
        return { execution: lease.execution, lease };
      }
      return { execution: executionFromRow(row), lease: null };
    },
    async findExecution(executionId) {
      const row = await findExecutionRow(executionId);
      return row === null ? null : executionFromRow(row);
    },
    async listPendingExecutions(limit) {
      const rows = await database
        .prepare(
          `SELECT execution_id, schedule_id, scheduled_instant,
                  publication_idempotency_key, attempt, state, detail,
                  attempt_actor_id, attempt_request_id,
                  claimed_at, updated_at, lease_token, lease_expires_at,
                  outcome_request_id, outcome_response_json
           FROM blog_post_schedule_executions
           WHERE state IN ('claimed', 'unknown')
             AND julianday(lease_expires_at) <= julianday('now')
           ORDER BY claimed_at, execution_id
           LIMIT ?1`,
        )
        .bind(Math.min(Math.max(limit, 1), 100))
        .all<ExecutionRow>();
      return rows.results.map(executionFromRow);
    },
    async retryExecution(input) {
      const observed = await findExecutionRow(input.executionId);
      if (observed === null) {
        throw new BlogPostOperationError("execution_not_retryable");
      }
      const retried: BlogPostScheduleExecution = {
        ...executionFromRow(observed),
        attempt: observed.attempt + 1,
        attemptActorId: input.actorId,
        attemptRequestId: input.requestId,
        state: "claimed",
        detail: null,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.updatedAt,
      };
      const schedule = await findScheduleRow(observed.schedule_id);
      if (schedule === null) {
        throw new BlogPostOperationError("execution_not_retryable");
      }
      const priorRetry = await database
        .prepare(
          `SELECT execution_id, actor_id, lease_token, response_json
           FROM blog_post_schedule_retry_receipts
           WHERE site_id = ?1 AND request_id = ?2`,
        )
        .bind(schedule.site_id, input.requestId)
        .first<{
          execution_id: string;
          actor_id: string;
          lease_token: string;
          response_json: string;
        }>();
      if (priorRetry !== null) {
        if (
          priorRetry.execution_id !== input.executionId ||
          priorRetry.actor_id !== input.actorId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return {
          siteId: schedule.site_id,
          postId: schedule.post_id,
          execution: JSON.parse(
            priorRetry.response_json,
          ) as BlogPostScheduleExecution,
          leaseToken: priorRetry.lease_token,
          replayed: true,
        };
      }
      if (!input.approvalAuthorityValid) {
        throw new BlogPostOperationError("approval_stale");
      }
      const results = await withScheduleAuthorityErrors(
        () => database.batch([
        database.prepare(
          `UPDATE blog_post_schedule_executions
           SET state = 'claimed', detail = NULL,
               attempt = attempt + 1,
               attempt_actor_id = ?5, attempt_request_id = ?6,
               lease_token = ?1, lease_expires_at = ?2, updated_at = ?3,
               outcome_request_id = NULL, outcome_response_json = NULL
           WHERE execution_id = ?4
             AND (
               (
                 ?8 = 'scheduler'
                 AND state IN ('claimed', 'unknown')
                 AND lease_expires_at <= ?3
               ) OR (
                 ?8 = 'human'
                 AND state IN ('failed', 'blocked')
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM blog_post_schedule_retry_receipts
               WHERE site_id = ?7 AND request_id = ?6
             )
             AND (
               ?8 = 'scheduler'
               OR EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE site_id = ?7 AND id = ?5
                   AND status = 'active'
                   AND role IN ('owner', 'editor')
               )
             )`,
        ).bind(
          input.leaseToken,
          input.leaseExpiresAt,
          input.updatedAt,
          input.executionId,
          input.actorId,
          input.requestId,
          schedule.site_id,
          input.retryKind,
        ),
        database.prepare(
          `UPDATE blog_post_schedules
           SET state = 'claimed', detail = NULL
           WHERE id = ?1 AND state <> 'completed'
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_executions
               WHERE execution_id = ?2 AND lease_token = ?3
                 AND updated_at = ?4
             )`,
        ).bind(
          observed.schedule_id,
          input.executionId,
          input.leaseToken,
          input.updatedAt,
        ),
        database.prepare(
          `UPDATE blog_post_collection_states
           SET workflow_state = ?1,
               version = version + 1,
               updated_at = ?2
           WHERE site_id = (
               SELECT site_id FROM blog_post_schedules WHERE id = ?3
             )
             AND post_id = (
               SELECT post_id FROM blog_post_schedules WHERE id = ?3
             )
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_executions
               WHERE execution_id = ?4 AND lease_token = ?5
                 AND updated_at = ?6
             )`,
        ).bind(
          "executing",
          input.updatedAt,
          observed.schedule_id,
          input.executionId,
          input.leaseToken,
          input.updatedAt,
        ),
        database.prepare(
          `UPDATE blog_post_schedule_publication_reservations
           SET state = 'reserved', released_at = NULL
             , attempt = ?4, lease_token = ?2
           WHERE execution_id = ?1
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_executions
               WHERE execution_id = ?1 AND lease_token = ?2
                 AND updated_at = ?3
             )`,
        ).bind(
          input.executionId,
          input.leaseToken,
          input.updatedAt,
          observed.attempt + 1,
        ),
        database.prepare(
          `INSERT INTO blog_post_schedule_retry_receipts (
             site_id, request_id, execution_id, actor_id, attempt, lease_token,
             lease_expires_at, response_json, occurred_at
           )
           SELECT ?9, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
           WHERE EXISTS (
             SELECT 1 FROM blog_post_schedule_executions
             WHERE execution_id = ?2
               AND attempt = ?4
               AND attempt_actor_id = ?3
               AND attempt_request_id = ?1
               AND lease_token = ?5
             )
           ON CONFLICT (site_id, request_id) DO NOTHING`,
        ).bind(
          input.requestId,
          input.executionId,
          input.actorId,
          observed.attempt + 1,
          input.leaseToken,
          input.leaseExpiresAt,
          JSON.stringify(retried),
          input.updatedAt,
          schedule.site_id,
        ),
        prepareAcceptedBlogPostAudit(database,
          {
            siteId: schedule.site_id,
            postId: schedule.post_id,
            actorId: input.actorId,
            commandType: "blog.post.schedule.retry",
            requestId: input.requestId,
            beforeState: executionFromRow(observed),
            afterState: retried,
            occurredAt: input.updatedAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_schedule_retry_receipts
             WHERE site_id = ?13 AND request_id = ?10
               AND execution_id = ?11
               AND actor_id = ?12
           )`,
          [
            input.requestId,
            input.executionId,
            input.actorId,
            schedule.site_id,
          ],
        ),
        ]),
        observed.publication_idempotency_key,
      );
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const racedRetry = await database
          .prepare(
            `SELECT execution_id, actor_id, lease_token, response_json
             FROM blog_post_schedule_retry_receipts
             WHERE site_id = ?1 AND request_id = ?2`,
          )
          .bind(schedule.site_id, input.requestId)
          .first<{
            execution_id: string;
            actor_id: string;
            lease_token: string;
            response_json: string;
          }>();
        if (
          racedRetry !== null &&
          racedRetry.execution_id === input.executionId &&
          racedRetry.actor_id === input.actorId
        ) {
          return {
            siteId: schedule.site_id,
            postId: schedule.post_id,
            execution: JSON.parse(
              racedRetry.response_json,
            ) as BlogPostScheduleExecution,
            leaseToken: racedRetry.lease_token,
            replayed: true,
          };
        }
        if (
          input.retryKind === "human" &&
          !(await store.hasHumanContentAuthority({
            siteId: schedule.site_id,
            actorId: input.actorId as ContentActorId,
          }))
        ) {
          throw new BlogPostOperationError(
            "human_authority_required",
          );
        }
        throw new BlogPostOperationError("execution_not_retryable");
      }
      return {
        siteId: schedule.site_id,
        postId: schedule.post_id,
        execution: retried,
        leaseToken: input.leaseToken,
      };
    },
    async recordExecutionOutcome(input) {
      const observed = await findExecutionRow(input.executionId);
      if (observed === null) {
        throw new BlogPostOperationError("execution_not_found");
      }
      const schedule = await findScheduleRow(observed.schedule_id);
      if (schedule === null) {
        throw new BlogPostOperationError("execution_not_found");
      }
      const priorOutcome = await database
        .prepare(
          `SELECT execution_id, attempt, outcome, detail, response_json
           FROM blog_post_schedule_execution_outcomes
           WHERE site_id = ?1 AND outcome_id = ?2`,
        )
        .bind(schedule.site_id, input.outcomeId)
        .first<{
          execution_id: string;
          attempt: number;
          outcome: Exclude<BlogPostScheduleExecution["state"], "claimed">;
          detail: string | null;
          response_json: string;
        }>();
      if (priorOutcome !== null) {
        if (
          priorOutcome.execution_id !== input.executionId ||
          priorOutcome.attempt !== input.attempt ||
          priorOutcome.outcome !== input.outcome ||
          priorOutcome.detail !== input.detail
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return JSON.parse(
          priorOutcome.response_json,
        ) as BlogPostScheduleExecution;
      }
      if (observed.attempt !== input.attempt) {
        throw new BlogPostOperationError("execution_lease_lost");
      }
      const outcomeExecution: BlogPostScheduleExecution = {
        ...executionFromRow(observed),
        state: input.outcome,
        detail: input.detail,
        leaseExpiresAt: input.updatedAt,
        updatedAt: input.updatedAt,
      };
      const results = await database.batch([
        database.prepare(
          `INSERT INTO blog_post_schedule_execution_outcomes (
             site_id, outcome_id, execution_id, attempt, outcome, detail,
             response_json, occurred_at
           )
           SELECT ?9, ?1, ?2, ?3, ?4, ?5, ?6, ?7
           WHERE EXISTS (
             SELECT 1 FROM blog_post_schedule_executions
             WHERE execution_id = ?2 AND attempt = ?3
               AND state <> 'completed' AND lease_token = ?8
               AND lease_expires_at > ?7
           )
           ON CONFLICT DO NOTHING`,
        ).bind(
          input.outcomeId,
          input.executionId,
          input.attempt,
          input.outcome,
          input.detail,
          JSON.stringify(outcomeExecution),
          input.updatedAt,
          input.leaseToken,
          schedule.site_id,
        ),
        database.prepare(
          `INSERT INTO blog_post_schedule_execution_events (
             site_id, event_id, execution_id, attempt, actor_id, request_id,
             from_state, to_state, detail, occurred_at
           )
           SELECT ?7, ?1, ?2, ?3, attempt_actor_id, ?1,
                  state, ?4, ?5, ?6
           FROM blog_post_schedule_executions
           WHERE execution_id = ?2 AND attempt = ?3
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_execution_outcomes
               WHERE outcome_id = ?1
                 AND execution_id = ?2
                 AND attempt = ?3
                 AND outcome = ?4
                 AND detail IS ?5
             )
           ON CONFLICT (site_id, event_id) DO NOTHING`,
        ).bind(
          input.outcomeId,
          input.executionId,
          input.attempt,
          input.outcome,
          input.detail,
          input.updatedAt,
          schedule.site_id,
        ),
        database.prepare(
          `UPDATE blog_post_schedule_executions
           SET state = ?1, detail = ?2, updated_at = ?3,
               lease_expires_at = ?3, outcome_request_id = ?6,
               outcome_response_json = ?7
           WHERE execution_id = ?4 AND attempt = ?8
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_execution_outcomes
               WHERE outcome_id = ?6 AND execution_id = ?4
                 AND attempt = ?8
                 AND outcome = ?1
                 AND detail IS ?2
                 AND response_json = ?7
             )`,
        ).bind(
          input.outcome,
          input.detail,
          input.updatedAt,
          input.executionId,
          input.leaseToken,
          input.outcomeId,
          JSON.stringify(outcomeExecution),
          input.attempt,
        ),
        database.prepare(
          `UPDATE blog_post_schedules
           SET state = ?1, detail = ?2
           WHERE id = ?3 AND state <> 'completed'
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_executions
               WHERE execution_id = ?4 AND state = ?1
                 AND attempt = ?7
                 AND EXISTS (
                   SELECT 1 FROM blog_post_schedule_execution_outcomes
                   WHERE outcome_id = ?5 AND execution_id = ?4
                     AND attempt = ?7
                     AND outcome = ?1
                     AND detail IS ?2
                 )
             )`,
        ).bind(input.outcome, input.detail, observed.schedule_id,
          input.executionId, input.outcomeId, input.updatedAt, input.attempt),
        database.prepare(
          `UPDATE blog_post_collection_states
           SET workflow_state = ?1,
               version = version + 1,
               updated_at = ?2
           WHERE site_id = (
               SELECT site_id FROM blog_post_schedules WHERE id = ?3
             )
             AND post_id = (
               SELECT post_id FROM blog_post_schedules WHERE id = ?3
             )
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_executions
               WHERE execution_id = ?4 AND state = ?5
                 AND attempt = ?7
                 AND EXISTS (
                   SELECT 1 FROM blog_post_schedule_execution_outcomes
                   WHERE outcome_id = ?6 AND execution_id = ?4
                     AND attempt = ?7
                     AND outcome = ?5
                     AND detail IS ?8
                 )
             )`,
        ).bind(
          input.outcome === "completed" ? "editing" : "failed",
          input.updatedAt,
          observed.schedule_id,
          input.executionId,
          input.outcome,
          input.outcomeId,
          input.attempt,
          input.detail,
        ),
        database.prepare(
          `UPDATE blog_post_schedule_publication_reservations
           SET state = 'released', released_at = ?1
           WHERE execution_id = ?2
             AND ?3 IN ('completed', 'blocked', 'failed')
             AND EXISTS (
               SELECT 1 FROM blog_post_schedule_execution_outcomes
               WHERE outcome_id = ?4 AND execution_id = ?2
                 AND attempt = ?5
                 AND outcome = ?3
                 AND detail IS ?6
             )`,
        ).bind(
          input.updatedAt,
          input.executionId,
          input.outcome,
          input.outcomeId,
          input.attempt,
          input.detail,
        ),
        prepareAcceptedBlogPostAudit(database,
          {
            siteId: schedule.site_id,
            postId: schedule.post_id,
            actorId: "system:scheduler",
            commandType: "blog.post.schedule.outcome",
            requestId:
              input.outcomeId,
            beforeState: executionFromRow(observed),
            afterState: outcomeExecution,
            occurredAt: input.updatedAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_schedule_execution_outcomes
             WHERE outcome_id = ?10 AND execution_id = ?11
               AND attempt = ?12
               AND outcome = ?13
               AND detail IS ?14
           )`,
          [
            input.outcomeId,
            input.executionId,
            input.attempt,
            input.outcome,
            input.detail,
          ],
        ),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const replay = await database
          .prepare(
            `SELECT execution_id, attempt, outcome, detail, response_json
             FROM blog_post_schedule_execution_outcomes
             WHERE site_id = ?1 AND outcome_id = ?2`,
          )
          .bind(schedule.site_id, input.outcomeId)
          .first<{
            execution_id: string;
            attempt: number;
            outcome: Exclude<
              BlogPostScheduleExecution["state"],
              "claimed"
            >;
            detail: string | null;
            response_json: string;
          }>();
        if (replay !== null) {
          if (
            replay.execution_id === input.executionId &&
            replay.attempt === input.attempt &&
            replay.outcome === input.outcome &&
            replay.detail === input.detail
          ) {
            return JSON.parse(
              replay.response_json,
            ) as BlogPostScheduleExecution;
          }
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        throw new BlogPostOperationError("execution_lease_lost");
      }
      const execution = await findExecutionRow(input.executionId);
      if (execution === null) {
        throw new BlogPostOperationError("execution_not_found");
      }
      return executionFromRow(execution);
    },
    async archive(input) {
      const findReplay = () =>
        database
          .prepare(
            `SELECT post_id, actor_id, selected_post_revision_id, response_json
             FROM blog_post_archive_records
             WHERE site_id = ?1 AND request_id = ?3
               AND response_json IS NOT NULL
             ORDER BY id
             LIMIT 1`,
          )
          .bind(input.siteId, input.postId, input.idempotencyKey)
          .first<{
            post_id: string;
            actor_id: string;
            selected_post_revision_id: string;
            response_json: string;
          }>();
      const replay = await findReplay();
      if (replay !== null) {
        if (
          replay.actor_id !== input.actorId ||
          replay.post_id !== input.postId ||
          replay.selected_post_revision_id !== input.selectedPostRevisionId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return JSON.parse(replay.response_json) as BlogPostArchiveResult;
      }
      const post = await store.findPost(input.siteId, input.postId);
      if (post === null) {
        throw new BlogPostOperationError("post_not_found");
      }
      if (post.collectionState !== "active") {
        throw new BlogPostOperationError("post_already_archived");
      }
      await requireRevision(
        input.siteId,
        input.postId,
        input.selectedPostRevisionId,
      );
      const nextState =
        post.liveRevisionId === null ? "archived" : "archiving";
      const updated: BlogPostOperationalState = {
        ...post,
        collectionState: nextState,
        workflowState: "editing",
        version: post.version + 1,
      };
      const response: BlogPostArchiveResult = {
        ...updated,
        selectedPostRevisionId: input.selectedPostRevisionId,
        withdrawalRequired: post.liveRevisionId !== null,
      };
      const priorSchedule = await database
        .prepare(
          `SELECT id FROM blog_post_schedules
           WHERE site_id = ?1 AND post_id = ?2
             AND state IN ('active', 'claimed', 'unknown')
           ORDER BY activated_at DESC LIMIT 1`,
        )
        .bind(input.siteId, input.postId)
        .first<{ id: string }>();
      let results: Awaited<ReturnType<typeof database.batch>>;
      try {
        results = await database.batch([
        database
          .prepare(
            `INSERT INTO blog_post_collection_states (
               site_id, post_id, collection_state,
               selected_post_revision_id, archive_request_id,
               archived_by, archive_reason, previous_schedule_id,
               previous_live_revision_id, archived_at, workflow_state,
               version, updated_at
             )
             SELECT
               ?1, ?2, ?3, ?4, ?5, ?6, 'editor_requested',
               ?7, ?8, ?9, 'editing', 2, ?9
             WHERE EXISTS (
               SELECT 1 FROM blog_posts AS post
               WHERE post.site_id = ?1 AND post.post_id = ?2
                 AND post.current_revision_id = ?10
                 AND post.version = ?11
                 AND (
                   (?12 IS NULL AND post.live_revision IS NULL)
                   OR EXISTS (
                     SELECT 1 FROM blog_post_revisions AS live
                     WHERE live.revision_id = ?12
                       AND live.site_id = post.site_id
                       AND live.post_id = post.post_id
                       AND live.revision = post.live_revision
                   )
                 )
             )
             AND EXISTS (
               SELECT 1 FROM human_memberships
               WHERE site_id = ?1 AND id = ?6
                 AND status = 'active'
                 AND role IN ('owner', 'editor')
             )
             AND NOT EXISTS (
               SELECT 1 FROM blog_post_operation_audit_events
               WHERE site_id = ?1
                 AND command_type = 'blog.post.archive'
                 AND request_id = ?5 AND outcome = 'accepted'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM content_publications AS publication
               JOIN content_approvals AS approval
                 ON approval.id = publication.approval_id
               JOIN content_workspaces AS workspace
                 ON workspace.workspace_id = approval.workspace_id
               JOIN json_each(
                 COALESCE(approval.blog_post_artifacts_json, '[]')
               ) AS artifact
               WHERE workspace.site_id = ?1
                 AND json_extract(artifact.value, '$.postId') = ?2
                 AND (
                   publication.status IN (
                     'requested', 'committed', 'building', 'deployed', 'unknown'
                   )
                   OR (
                     publication.status = 'verified-live'
                     AND NOT EXISTS (
                       SELECT 1
                       FROM blog_posts AS reconciled_post
                       JOIN blog_publication_reconciliation_order
                         AS reconciliation
                         ON reconciliation.publication_id = publication.id
                       WHERE reconciled_post.site_id = workspace.site_id
                         AND reconciled_post.post_id = ?2
                         AND
                           reconciled_post.last_verified_publication_sequence >=
                           reconciliation.sequence
                     )
                   )
                 )
             )
             ON CONFLICT (site_id, post_id) DO UPDATE SET
               collection_state = excluded.collection_state,
               selected_post_revision_id =
                 excluded.selected_post_revision_id,
               archive_request_id = excluded.archive_request_id,
               restore_request_id = NULL,
               restore_selected_post_revision_id = NULL,
               restore_actor_id = NULL,
               archived_by = excluded.archived_by,
               archive_reason = excluded.archive_reason,
               previous_schedule_id = excluded.previous_schedule_id,
               previous_live_revision_id =
                 excluded.previous_live_revision_id,
               archived_at = excluded.archived_at,
               workflow_state = 'editing',
               version = blog_post_collection_states.version + 1,
               updated_at = excluded.updated_at
             WHERE blog_post_collection_states.collection_state = 'active'
               AND EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE site_id = ?1 AND id = ?6
                   AND status = 'active'
                   AND role IN ('owner', 'editor')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM blog_post_operation_audit_events
                 WHERE site_id = ?1
                   AND command_type = 'blog.post.archive'
                   AND request_id = ?5 AND outcome = 'accepted'
               )
               AND NOT EXISTS (
                 SELECT 1
                 FROM content_publications AS publication
                 JOIN content_approvals AS approval
                   ON approval.id = publication.approval_id
                 JOIN content_workspaces AS workspace
                   ON workspace.workspace_id = approval.workspace_id
                 JOIN json_each(
                   COALESCE(approval.blog_post_artifacts_json, '[]')
                 ) AS artifact
                 WHERE workspace.site_id = ?1
                   AND json_extract(artifact.value, '$.postId') = ?2
                   AND (
                     publication.status IN (
                       'requested', 'committed', 'building', 'deployed',
                       'unknown'
                     )
                     OR (
                       publication.status = 'verified-live'
                       AND NOT EXISTS (
                         SELECT 1
                         FROM blog_posts AS reconciled_post
                         JOIN blog_publication_reconciliation_order
                           AS reconciliation
                           ON reconciliation.publication_id = publication.id
                         WHERE reconciled_post.site_id = workspace.site_id
                           AND reconciled_post.post_id = ?2
                           AND
                             reconciled_post
                               .last_verified_publication_sequence >=
                             reconciliation.sequence
                       )
                     )
                   )
               )
               AND EXISTS (
                 SELECT 1 FROM blog_posts AS post
                 WHERE post.site_id = ?1 AND post.post_id = ?2
                   AND post.current_revision_id = ?10
                   AND post.version = ?11
                   AND (
                     (?12 IS NULL AND post.live_revision IS NULL)
                     OR EXISTS (
                       SELECT 1 FROM blog_post_revisions AS live
                       WHERE live.revision_id = ?12
                         AND live.site_id = post.site_id
                         AND live.post_id = post.post_id
                         AND live.revision = post.live_revision
                     )
                   )
               )`,
          )
          .bind(
            input.siteId,
            input.postId,
            nextState,
            input.selectedPostRevisionId,
            input.idempotencyKey,
            input.actorId,
            priorSchedule?.id ?? null,
            post.liveRevisionId,
            input.occurredAt,
            post.postRevisionId,
            post.version,
            post.liveRevisionId,
          ),
        database
          .prepare(
            `UPDATE blog_post_schedules
             SET state = 'cancelled', detail = 'post_archived'
             WHERE site_id = ?1 AND post_id = ?2
               AND state = 'active'
               AND EXISTS (
                 SELECT 1 FROM blog_post_collection_states
                 WHERE site_id = ?1 AND post_id = ?2
                   AND archive_request_id = ?3
               )`,
          )
          .bind(input.siteId, input.postId, input.idempotencyKey),
        database
          .prepare(
            `INSERT INTO content_approval_invalidations (
               approval_id, invalidated_at, reason
             )
             SELECT approval.id, ?1, 'revision_changed'
             FROM content_approvals AS approval
             JOIN content_workspaces AS workspace
               ON workspace.workspace_id = approval.workspace_id
             JOIN json_each(approval.blog_post_artifacts_json) AS artifact
             WHERE workspace.site_id = ?2
               AND json_extract(artifact.value, '$.postId') = ?3
               AND EXISTS (
                 SELECT 1 FROM blog_post_collection_states
                 WHERE site_id = ?2 AND post_id = ?3
                   AND archive_request_id = ?4
               )
               AND NOT EXISTS (
                 SELECT 1 FROM content_approval_invalidations
                 WHERE approval_id = approval.id
               )`,
          )
          .bind(
            input.occurredAt,
            input.siteId,
            input.postId,
            input.idempotencyKey,
          ),
        database
          .prepare(
            `INSERT INTO blog_post_archive_records (
               site_id, post_id, selected_post_revision_id, actor_id,
               request_id, outcome, publication_id, archive_reason,
               previous_schedule_id, previous_live_revision_id, occurred_at
               , response_json
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL,
                    'editor_requested', ?7, ?8, ?9, ?10
             WHERE EXISTS (
               SELECT 1 FROM blog_post_collection_states
               WHERE site_id = ?1 AND post_id = ?2
                 AND archive_request_id = ?5
                 AND collection_state = ?6
             )
             ON CONFLICT (site_id, post_id, request_id, outcome)
             DO NOTHING`,
          )
          .bind(
            input.siteId,
            input.postId,
            input.selectedPostRevisionId,
            input.actorId,
            input.idempotencyKey,
            nextState,
            priorSchedule?.id ?? null,
            post.liveRevisionId,
            input.occurredAt,
            JSON.stringify(response),
          ),
        prepareAcceptedBlogPostAudit(database,
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.archive",
            requestId: input.idempotencyKey,
            beforeState: post,
            afterState: updated,
            occurredAt: input.occurredAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_collection_states
             WHERE site_id = ?10 AND post_id = ?11
               AND archive_request_id = ?12
               AND collection_state = ?13
           )`,
          [input.siteId, input.postId, input.idempotencyKey, nextState],
        ),
        ]);
      } catch (error) {
        if (
          error instanceof Error &&
          (
            error.message.includes(
              "blog_post_archive_execution_unresolved",
            ) ||
            error.message.includes(
              "blog_post_live_withdrawal_in_progress",
            )
          )
        ) {
          throw new BlogPostOperationError(
            "production_operation_in_progress",
          );
        }
        throw error;
      }
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const concurrentReplay = await findReplay();
        if (
          concurrentReplay !== null &&
          concurrentReplay.actor_id === input.actorId &&
          concurrentReplay.selected_post_revision_id ===
            input.selectedPostRevisionId
        ) {
          return JSON.parse(
            concurrentReplay.response_json,
          ) as BlogPostArchiveResult;
        }
        if (!(await store.hasHumanContentAuthority({
          siteId: input.siteId,
          actorId: input.actorId,
        }))) {
          throw new BlogPostOperationError("human_authority_required");
        }
        if (await hasActivePublicationForPost(input.siteId, input.postId)) {
          throw new BlogPostOperationError(
            "production_operation_in_progress",
          );
        }
        throw new BlogPostOperationError("post_archive_conflict");
      }
      return response;
    },
    async confirmArchiveWithdrawal(input) {
      const beforeState = await store.findPost(input.siteId, input.postId);
      const results = await database.batch([
        database.prepare(
          `UPDATE blog_post_collection_states
           SET collection_state = 'archived',
               updated_at = ?2,
               version = version + 1
           WHERE site_id = ?3 AND post_id = ?4
             AND collection_state = 'archiving'
             AND archive_publication_id = ?1
             AND EXISTS (
               SELECT 1
               FROM content_publications AS publication
               JOIN blog_post_revisions AS withdrawal
                 ON withdrawal.workspace_id = publication.workspace_id
                AND withdrawal.content_revision = publication.revision
                AND withdrawal.site_id = ?3
                AND withdrawal.post_id = ?4
               WHERE publication.id = ?1
                 AND publication.status = 'verified-live'
                 AND publication.workspace_id =
                       blog_post_collection_states.withdrawal_workspace_id
                 AND publication.revision =
                       blog_post_collection_states.withdrawal_content_revision
                 AND json_extract(
                   withdrawal.snapshot_json,
                   '$.targetVisibility'
                 ) = 'unpublished'
             )
             AND EXISTS (
               SELECT 1 FROM blog_posts
               WHERE site_id = ?3 AND post_id = ?4
                 AND live_revision IS NULL
             )`,
        ).bind(
          input.publicationId,
          input.occurredAt,
          input.siteId,
          input.postId,
        ),
        database.prepare(
          `INSERT INTO blog_post_archive_records (
             site_id, post_id, selected_post_revision_id, actor_id,
             request_id, outcome, publication_id, archive_reason,
             previous_schedule_id, previous_live_revision_id, occurred_at
           )
           SELECT site_id, post_id, selected_post_revision_id, archived_by,
                  'verified:' || ?1, 'archived', ?1, archive_reason,
                  previous_schedule_id, previous_live_revision_id, ?2
           FROM blog_post_collection_states
           WHERE site_id = ?3 AND post_id = ?4
             AND collection_state = 'archived'
             AND archive_publication_id = ?1
           ON CONFLICT (site_id, post_id, request_id, outcome)
           DO NOTHING`,
        ).bind(input.publicationId, input.occurredAt, input.siteId, input.postId),
        prepareAcceptedBlogPostAudit(database,
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: "system:publication",
            commandType: "blog.post.archive.withdrawal.verified",
            requestId: input.publicationId,
            beforeState,
            afterState:
              beforeState === null
                ? null
                : {
                    ...beforeState,
                    collectionState: "archived",
                    liveRevisionId: null,
                    version: beforeState.version + 1,
                  },
            occurredAt: input.occurredAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_collection_states
             WHERE site_id = ?10 AND post_id = ?11
               AND collection_state = 'archived'
               AND archive_publication_id = ?12
           )`,
          [input.siteId, input.postId, input.publicationId],
        ),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const replay = await database.prepare(
          `SELECT 1 AS ok FROM blog_post_archive_records
           WHERE site_id = ?1 AND post_id = ?2
             AND request_id = 'verified:' || ?3 AND outcome = 'archived'`,
        ).bind(input.siteId, input.postId, input.publicationId).first();
        if (replay !== null) {
          return (await store.findPost(input.siteId, input.postId))!;
        }
        throw new BlogPostOperationError(
          "archive_withdrawal_not_verified",
        );
      }
      return (await store.findPost(input.siteId, input.postId))!;
    },
    async bindArchiveWithdrawal(input) {
      const continuationAfterStateJson =
        input.acceptedContinuation === undefined
          ? null
          : JSON.stringify(input.acceptedContinuation.afterState);
      if (input.acceptedContinuation !== undefined) {
        const existingReceipt = await database.prepare(
          `SELECT post_id, actor_id, after_state_json
           FROM blog_post_operation_audit_events
           WHERE site_id = ?1
             AND command_type =
               'blog.post.archive.withdrawal.continue'
             AND request_id = ?2 AND outcome = 'accepted'`,
        ).bind(
          input.siteId,
          input.acceptedContinuation.requestId,
        ).first<{
          post_id: string | null;
          actor_id: string;
          after_state_json: string | null;
        }>();
        if (
          existingReceipt !== null &&
          (
            existingReceipt.post_id !== input.postId ||
            existingReceipt.actor_id !==
              input.acceptedContinuation.actorId ||
            existingReceipt.after_state_json !==
              continuationAfterStateJson
          )
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
      }
      const beforeState = await store.findPost(input.siteId, input.postId);
      const statements = [
        database.prepare(
          `UPDATE blog_post_collection_states
           SET archive_publication_id = ?1, updated_at = ?2
           WHERE site_id = ?3 AND post_id = ?4
             AND collection_state = 'archiving'
             AND archive_publication_id IS NULL
             AND EXISTS (
               SELECT 1
               FROM content_publications AS publication
               JOIN blog_post_revisions AS withdrawal
                 ON withdrawal.workspace_id = publication.workspace_id
                AND withdrawal.content_revision = publication.revision
                AND withdrawal.site_id = ?3
                AND withdrawal.post_id = ?4
               WHERE publication.id = ?1
                 AND publication.workspace_id =
                       blog_post_collection_states.withdrawal_workspace_id
                 AND publication.revision =
                       blog_post_collection_states.withdrawal_content_revision
                 AND json_extract(
                   withdrawal.snapshot_json,
                   '$.targetVisibility'
                 ) = 'unpublished'
                 AND (
                   ?5 IS NULL OR publication.approval_id = ?5
                 )
                 AND (
                   ?6 IS NULL OR NOT EXISTS (
                     SELECT 1
                     FROM blog_post_operation_audit_events AS receipt
                     WHERE receipt.site_id = ?3
                       AND receipt.command_type =
                         'blog.post.archive.withdrawal.continue'
                       AND receipt.request_id = ?6
                       AND receipt.outcome = 'accepted'
                   ) OR EXISTS (
                     SELECT 1
                     FROM blog_post_operation_audit_events AS receipt
                     WHERE receipt.site_id = ?3
                       AND receipt.command_type =
                         'blog.post.archive.withdrawal.continue'
                       AND receipt.request_id = ?6
                       AND receipt.outcome = 'accepted'
                       AND receipt.post_id = ?4
                       AND receipt.actor_id = ?7
                       AND receipt.after_state_json = ?8
                   )
                 )
             )`,
        ).bind(
          input.publicationId,
          input.occurredAt,
          input.siteId,
          input.postId,
          input.acceptedContinuation?.approvalId ?? null,
          input.acceptedContinuation?.requestId ?? null,
          input.acceptedContinuation?.actorId ?? null,
          continuationAfterStateJson,
        ),
        prepareAcceptedBlogPostAudit(database,
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: "system:publication",
            commandType: "blog.post.archive.withdrawal.bind",
            requestId: input.publicationId,
            beforeState,
            afterState: {
              ...beforeState,
              archivePublicationId: input.publicationId,
            },
            occurredAt: input.occurredAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_collection_states
             WHERE site_id = ?10 AND post_id = ?11
               AND collection_state = 'archiving'
               AND archive_publication_id = ?12
           )`,
          [input.siteId, input.postId, input.publicationId],
        ),
      ];
      if (input.acceptedContinuation !== undefined) {
        statements.push(
          prepareAcceptedBlogPostAudit(
            database,
            {
              siteId: input.siteId,
              postId: input.postId,
              actorId: input.acceptedContinuation.actorId,
              commandType: "blog.post.archive.withdrawal.continue",
              requestId: input.acceptedContinuation.requestId,
              beforeState: input.acceptedContinuation.beforeState,
              afterState: input.acceptedContinuation.afterState,
              occurredAt: input.occurredAt,
            },
            `EXISTS (
               SELECT 1
               FROM blog_post_collection_states AS state
               JOIN content_publications AS publication
                 ON publication.id = ?12
               WHERE state.site_id = ?10 AND state.post_id = ?11
                 AND state.collection_state = 'archiving'
                 AND state.archive_publication_id = ?12
                 AND publication.approval_id = ?13
             )`,
            [
              input.siteId,
              input.postId,
              input.publicationId,
              input.acceptedContinuation.approvalId,
            ],
          ),
        );
      }
      const results = await database.batch(statements);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const replay = await database.prepare(
          `SELECT 1 AS ok FROM blog_post_collection_states
           WHERE site_id = ?1 AND post_id = ?2
             AND collection_state = 'archiving'
             AND archive_publication_id = ?3`,
        ).bind(input.siteId, input.postId, input.publicationId).first();
        if (replay === null) {
          const archiving = await database.prepare(
            `SELECT 1 AS ok FROM blog_post_collection_states
             WHERE site_id = ?1 AND post_id = ?2
               AND collection_state = 'archiving'`,
          ).bind(input.siteId, input.postId).first();
          if (archiving !== null) {
            throw new BlogPostOperationError(
              "archive_publication_mismatch",
            );
          }
          throw new BlogPostOperationError("post_not_archiving");
        }
      }
      if (input.acceptedContinuation !== undefined) {
        const receipt = await database.prepare(
          `SELECT actor_id, after_state_json
           FROM blog_post_operation_audit_events
           WHERE site_id = ?1 AND post_id = ?2
             AND command_type =
               'blog.post.archive.withdrawal.continue'
             AND request_id = ?3 AND outcome = 'accepted'`,
        ).bind(
          input.siteId,
          input.postId,
          input.acceptedContinuation.requestId,
        ).first<{
          actor_id: string;
          after_state_json: string | null;
        }>();
        if (receipt === null) {
          throw new BlogPostOperationError(
            "archive_publication_mismatch",
          );
        }
        if (
          receipt.actor_id !== input.acceptedContinuation.actorId ||
          receipt.after_state_json !==
            continuationAfterStateJson
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
      }
    },
    async bindArchiveWithdrawalDraft(input) {
      const beforeState = await store.findPost(input.siteId, input.postId);
      const results = await database.batch([
        database.prepare(
          `UPDATE blog_post_collection_states
           SET withdrawal_workspace_id = ?1,
               withdrawal_content_revision = ?2,
               withdrawal_created_by = ?3,
               updated_at = ?4
           WHERE site_id = ?5 AND post_id = ?6
             AND collection_state = 'archiving'
             AND archive_request_id = ?7
             AND (
               withdrawal_workspace_id IS NULL OR (
                 withdrawal_workspace_id = ?1
                 AND withdrawal_content_revision = ?2
                 AND withdrawal_created_by = ?3
               )
             )`,
        ).bind(
          input.workspaceId,
          input.contentRevision,
          input.createdBy,
          input.occurredAt,
          input.siteId,
          input.postId,
          input.requestId,
        ),
        prepareAcceptedBlogPostAudit(
          database,
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.createdBy,
            commandType: "blog.post.archive.withdrawal.draft",
            requestId: input.requestId,
            beforeState,
            afterState: {
              workspaceId: input.workspaceId,
              contentRevision: input.contentRevision,
              createdBy: input.createdBy,
            },
            occurredAt: input.occurredAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_collection_states
             WHERE site_id = ?10 AND post_id = ?11
               AND archive_request_id = ?12
               AND withdrawal_workspace_id = ?13
               AND withdrawal_content_revision = ?14
           )`,
          [
            input.siteId,
            input.postId,
            input.requestId,
            input.workspaceId,
            input.contentRevision,
          ],
        ),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        throw new BlogPostOperationError(
          "archive_withdrawal_draft_conflict",
        );
      }
    },
    async grantArchiveWithdrawalRecoveryAccess(input) {
      const findReplay = () =>
        database
          .prepare(
            `SELECT post_id, actor_id, after_state_json
             FROM blog_post_operation_audit_events
             WHERE site_id = ?1
               AND command_type =
                 'blog.post.archive.withdrawal.recover_access'
               AND request_id = ?2 AND outcome = 'accepted'`,
          )
          .bind(input.siteId, input.requestId)
          .first<{
            post_id: string | null;
            actor_id: string;
            after_state_json: string;
          }>();
      const assertReplay = (replay: {
        post_id: string | null;
        actor_id: string;
        after_state_json: string;
      }) => {
        const afterState = JSON.parse(replay.after_state_json) as {
          workspaceId: string;
          actorId: string;
          archiveRequestId: string;
        };
        if (
          replay.post_id !== input.postId ||
          replay.actor_id !== input.actorId ||
          afterState.workspaceId !== input.workspaceId ||
          afterState.actorId !== input.actorId ||
          afterState.archiveRequestId !== input.archiveRequestId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
      };
      const replay = await findReplay();
      if (replay !== null) {
        assertReplay(replay);
        return;
      }
      const beforeState = await store.findPost(input.siteId, input.postId);
      await database.batch([
        database.prepare(
          `INSERT INTO content_workspace_collaborators (
             workspace_id, actor_id, added_at
           )
           SELECT state.withdrawal_workspace_id, ?1, ?2
           FROM blog_post_collection_states AS state
           JOIN human_memberships AS membership
             ON membership.site_id = state.site_id
            AND membership.id = ?1
            AND membership.status = 'active'
            AND membership.role IN ('owner', 'editor')
           WHERE state.site_id = ?3 AND state.post_id = ?4
             AND state.collection_state = 'archiving'
             AND state.withdrawal_workspace_id = ?5
             AND state.archive_request_id = ?7
             AND NOT EXISTS (
               SELECT 1 FROM blog_post_operation_audit_events
               WHERE site_id = ?3
                 AND command_type =
                   'blog.post.archive.withdrawal.recover_access'
                 AND request_id = ?6 AND outcome = 'accepted'
             )
           ON CONFLICT (workspace_id, actor_id) DO NOTHING`,
        )
        .bind(
          input.actorId,
          input.occurredAt,
          input.siteId,
          input.postId,
          input.workspaceId,
          input.requestId,
          input.archiveRequestId,
        ),
        prepareAcceptedBlogPostAudit(
          database,
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType:
              "blog.post.archive.withdrawal.recover_access",
            requestId: input.requestId,
            beforeState,
            afterState: {
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              archiveRequestId: input.archiveRequestId,
            },
            occurredAt: input.occurredAt,
          },
          `EXISTS (
             SELECT 1
             FROM content_workspace_collaborators AS collaborator
             JOIN human_memberships AS membership
               ON membership.id = collaborator.actor_id
              AND membership.site_id = ?10
              AND membership.status = 'active'
              AND membership.role IN ('owner', 'editor')
             WHERE collaborator.workspace_id = ?11
               AND collaborator.actor_id = ?12
               AND EXISTS (
                 SELECT 1 FROM blog_post_collection_states
                 WHERE site_id = ?10 AND post_id = ?13
                   AND collection_state = 'archiving'
                   AND withdrawal_workspace_id = ?11
                   AND archive_request_id = ?14
               )
           )`,
          [
            input.siteId,
            input.workspaceId,
            input.actorId,
            input.postId,
            input.archiveRequestId,
          ],
        ),
      ]);
      const accepted = await findReplay();
      if (accepted === null) {
        const existing = await database.prepare(
            `SELECT 1 AS ok
             FROM content_workspace_collaborators AS collaborator
             JOIN human_memberships AS membership
               ON membership.id = collaborator.actor_id
              AND membership.site_id = ?1
              AND membership.status = 'active'
              AND membership.role IN ('owner', 'editor')
             WHERE collaborator.workspace_id = ?2
               AND collaborator.actor_id = ?3
               AND EXISTS (
                 SELECT 1 FROM blog_post_collection_states
                 WHERE site_id = ?1 AND post_id = ?4
                   AND collection_state = 'archiving'
                   AND withdrawal_workspace_id = ?2
                   AND archive_request_id = ?5
               )`,
          )
          .bind(
            input.siteId,
            input.workspaceId,
            input.actorId,
            input.postId,
            input.archiveRequestId,
          )
          .first();
        if (existing === null) {
          throw new BlogPostOperationError("human_authority_required");
        }
        throw new BlogPostOperationError(
          "archive_withdrawal_recovery_access_failed",
        );
      }
      assertReplay(accepted);
    },
    async claimRestore(input) {
      const completed = await database
        .prepare(
          `SELECT post_id, actor_id, source_post_revision_id
           FROM blog_post_restore_records
           WHERE site_id = ?1 AND request_id = ?3
           ORDER BY id
           LIMIT 1`,
        )
        .bind(input.siteId, input.postId, input.idempotencyKey)
        .first<{
          post_id: string;
          actor_id: string;
          source_post_revision_id: string;
        }>();
      if (completed !== null) {
        if (
          completed.post_id !== input.postId ||
          completed.actor_id !== input.actorId ||
          completed.source_post_revision_id !== input.selectedPostRevisionId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return;
      }
      await requireRevision(
        input.siteId,
        input.postId,
        input.selectedPostRevisionId,
      );
      const claimed = await database
        .prepare(
          `UPDATE blog_post_collection_states
           SET restore_request_id = ?1,
               restore_selected_post_revision_id = ?2,
               restore_actor_id = ?3,
               updated_at = ?4
           WHERE site_id = ?5 AND post_id = ?6
             AND collection_state = 'archived'
             AND EXISTS (
               SELECT 1 FROM human_memberships AS current_actor
               WHERE current_actor.site_id = ?5
                 AND current_actor.id = ?3
                 AND current_actor.status = 'active'
                 AND current_actor.role IN ('owner', 'editor')
             )
             AND NOT EXISTS (
               SELECT 1 FROM blog_post_operation_audit_events
               WHERE site_id = ?5
                 AND command_type = 'blog.post.restore'
                 AND request_id = ?1 AND outcome = 'accepted'
             )
             AND (
               restore_request_id IS NULL OR (
                 restore_request_id = ?1
                 AND restore_selected_post_revision_id = ?2
                 AND restore_actor_id = ?3
               ) OR (
                 restore_actor_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM human_memberships AS previous_actor
                   WHERE previous_actor.site_id = ?5
                     AND previous_actor.id =
                       blog_post_collection_states.restore_actor_id
                     AND previous_actor.status = 'active'
                     AND previous_actor.role IN ('owner', 'editor')
                 )
               )
             )`,
        )
        .bind(
          input.idempotencyKey,
          input.selectedPostRevisionId,
          input.actorId,
          input.occurredAt,
          input.siteId,
          input.postId,
        )
        .run();
      if ((claimed.meta.changes ?? 0) !== 1) {
        const existing = await database
          .prepare(
            `SELECT collection_state, restore_request_id,
                    restore_selected_post_revision_id, restore_actor_id
             FROM blog_post_collection_states
             WHERE site_id = ?1 AND post_id = ?2`,
          )
          .bind(input.siteId, input.postId)
          .first<{
            collection_state: BlogPostOperationalState["collectionState"];
            restore_request_id: string | null;
            restore_selected_post_revision_id: string | null;
            restore_actor_id: string | null;
          }>();
        if (
          existing?.restore_request_id === input.idempotencyKey &&
          (existing.restore_selected_post_revision_id !==
            input.selectedPostRevisionId ||
            existing.restore_actor_id !== input.actorId)
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        throw new BlogPostOperationError("post_restore_conflict");
      }
    },
    async restore(input) {
      const findReplay = () =>
        database
          .prepare(
            `SELECT post_id, actor_id, source_post_revision_id, response_json
             FROM blog_post_restore_records
             WHERE site_id = ?1 AND request_id = ?3
             ORDER BY id
             LIMIT 1`,
          )
          .bind(input.siteId, input.postId, input.idempotencyKey)
          .first<{
            post_id: string;
            actor_id: string;
            source_post_revision_id: string;
            response_json: string;
          }>();
      const replay = await findReplay();
      if (replay !== null) {
        if (
          replay.post_id !== input.postId ||
          replay.actor_id !== input.actorId ||
          replay.source_post_revision_id !== input.selectedPostRevisionId
        ) {
          throw new BlogPostOperationError("idempotency_key_conflict");
        }
        return JSON.parse(replay.response_json) as RestoredBlogPostDraft;
      }
      if (input.provenance === undefined) {
        throw new BlogPostOperationError("restore_provenance_required");
      }
      await requireRevision(
        input.siteId,
        input.postId,
        input.selectedPostRevisionId,
      );
      const post = await store.findPost(input.siteId, input.postId);
      if (post?.collectionState !== "archived") {
        throw new BlogPostOperationError("post_not_archived");
      }
      const restored: RestoredBlogPostDraft = {
        ...post,
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: null,
        version: post.version + 1,
        targetVisibility: "unpublished",
        sourcePostRevisionId: input.selectedPostRevisionId,
      };
      const statements = [
        database
          .prepare(
            `UPDATE blog_post_collection_states
             SET collection_state = 'active',
                 workflow_state = 'editing',
                 restore_request_id = ?4,
                 version = version + 1,
                 updated_at = ?1
             WHERE site_id = ?2 AND post_id = ?3
               AND collection_state = 'archived'
               AND restore_request_id = ?4
               AND restore_selected_post_revision_id = ?5
               AND restore_actor_id = ?6
               AND NOT EXISTS (
                 SELECT 1 FROM blog_post_operation_audit_events
                 WHERE site_id = ?2
                   AND command_type = 'blog.post.restore'
                   AND request_id = ?4 AND outcome = 'accepted'
               )
               AND EXISTS (
                 SELECT 1 FROM human_memberships
                 WHERE site_id = ?2 AND id = ?6
                   AND status = 'active'
                   AND role IN ('owner', 'editor')
               )`,
          )
          .bind(
            input.occurredAt,
            input.siteId,
            input.postId,
            input.idempotencyKey,
            input.selectedPostRevisionId,
            input.actorId,
          ),
        database
          .prepare(
            `INSERT INTO blog_post_archive_records (
               site_id, post_id, selected_post_revision_id, actor_id,
               request_id, outcome, publication_id, archive_reason,
               previous_schedule_id, previous_live_revision_id, occurred_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, 'restored', NULL,
                    archive_reason, previous_schedule_id,
                    previous_live_revision_id, ?6
             FROM blog_post_collection_states
             WHERE site_id = ?1 AND post_id = ?2
               AND collection_state = 'active'
               AND restore_request_id = ?5
             ON CONFLICT (site_id, post_id, request_id, outcome)
             DO NOTHING`,
          )
          .bind(
            input.siteId,
            input.postId,
            input.selectedPostRevisionId,
            input.actorId,
            input.idempotencyKey,
            input.occurredAt,
          ),
      ];
      statements.push(
        database.prepare(
            `INSERT INTO blog_post_restore_records (
               site_id, post_id, source_post_revision_id,
               restored_workspace_id, restored_content_revision,
               restored_post_revision_id, actor_id, request_id, occurred_at,
               response_json
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
             WHERE EXISTS (
               SELECT 1 FROM blog_post_collection_states
               WHERE site_id = ?1 AND post_id = ?2
                 AND collection_state = 'active'
                 AND restore_request_id = ?8
             )
             ON CONFLICT (site_id, post_id, request_id) DO NOTHING`,
          ).bind(
            input.siteId,
            input.postId,
            input.selectedPostRevisionId,
            input.provenance.workspaceId,
            input.provenance.contentRevision,
            input.provenance.restoredPostRevisionId,
            input.actorId,
            input.idempotencyKey,
            input.occurredAt,
            JSON.stringify(restored),
          ),
        prepareAcceptedBlogPostAudit(database,
          {
            siteId: input.siteId,
            postId: input.postId,
            actorId: input.actorId,
            commandType: "blog.post.restore",
            requestId: input.idempotencyKey,
            beforeState: post,
            afterState: restored,
            occurredAt: input.occurredAt,
          },
          `EXISTS (
             SELECT 1 FROM blog_post_collection_states
             WHERE site_id = ?10 AND post_id = ?11
               AND collection_state = 'active'
               AND restore_request_id = ?12
           )`,
          [input.siteId, input.postId, input.idempotencyKey],
        ),
      );
      const results = await database.batch(statements);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        const concurrentReplay = await findReplay();
        if (
          concurrentReplay !== null &&
          concurrentReplay.post_id === input.postId &&
          concurrentReplay.actor_id === input.actorId &&
          concurrentReplay.source_post_revision_id ===
            input.selectedPostRevisionId
        ) {
          return JSON.parse(
            concurrentReplay.response_json,
          ) as RestoredBlogPostDraft;
        }
        if (!(await store.hasHumanContentAuthority({
          siteId: input.siteId,
          actorId: input.actorId,
        }))) {
          throw new BlogPostOperationError(
            "human_authority_required",
          );
        }
        throw new BlogPostOperationError("post_restore_conflict");
      }
      return restored;
    },
    async recordRestoreProvenance(input) {
      await database
        .prepare(
          `INSERT INTO blog_post_restore_records (
             site_id, post_id, source_post_revision_id,
             restored_workspace_id, restored_content_revision,
             restored_post_revision_id, actor_id, request_id, occurred_at,
             response_json
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '{}')
           ON CONFLICT (site_id, post_id, request_id) DO NOTHING`,
        )
        .bind(
          input.siteId,
          input.postId,
          input.sourcePostRevisionId,
          input.workspaceId,
          input.contentRevision,
          input.restoredPostRevisionId,
          input.actorId,
          input.requestId,
          input.occurredAt,
        )
        .run();
    },
    async recordAudit(event) {
      await recordD1BlogPostAudit(database, event);
    },
  };
  return store;
}

export async function confirmVerifiedArchiveWithdrawals(
  database: D1DatabaseBinding,
  siteId: string,
  publicationId: string,
  definition: SiteDefinition,
  verifiedAt: string,
) {
  const candidates = await database
    .prepare(
      `SELECT site_id, post_id
       FROM blog_post_collection_states
       WHERE site_id = ?1
         AND collection_state = 'archiving'
         AND archive_publication_id = ?2`,
    )
    .bind(siteId, publicationId)
    .all<{ site_id: string; post_id: string }>();
  const visiblePosts = new Set<string>(
    definition.blog.posts
      .filter(({ targetVisibility }) => targetVisibility === "public")
      .map(({ id }) => id),
  );
  const store = createD1BlogPostOperationsStore(database);
  const operations = createBlogPostOperationsApplication({
    store,
    now: () => verifiedAt,
  });
  for (const candidate of candidates.results) {
    if (!visiblePosts.has(candidate.post_id)) {
      await operations.commands.confirmArchiveWithdrawal({
        siteId: candidate.site_id,
        postId: candidate.post_id,
        publicationId,
      });
    }
  }
}

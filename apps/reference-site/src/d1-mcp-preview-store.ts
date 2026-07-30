import {
  McpReadError,
  type ContentWorkspaceId,
  type McpConnectionPrincipal,
  type McpDraftRuntime,
  type McpReadAuditEvent,
} from "@foundry/application";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type PreparedPreview = Awaited<
  ReturnType<McpDraftRuntime["preparePreview"]>
>;

export function createD1McpPreviewStore(
  database: D1DatabaseBinding,
  {
    createPreviewId = () => crypto.randomUUID(),
    now = () => new Date().toISOString(),
    beforePersist = () => {},
  }: {
    createPreviewId?: () => string;
    now?: () => string;
    beforePersist?: () => void | Promise<void>;
  } = {},
) {
  type PreviewInput = {
    principal: McpConnectionPrincipal;
    workspaceId: ContentWorkspaceId;
    revision: number;
    idempotencyKey: string;
    requestHash: string;
    artifactHash: string;
    contentHash: string;
    audit: McpReadAuditEvent & { idempotencyKey: string };
  };

  async function findRecorded(input: PreviewInput) {
    const recorded = await database
      .prepare(
        `SELECT
           preview_id, actor_id, site_id, workspace_id, revision,
           request_hash, artifact_hash
         FROM mcp_preview_artifacts
         WHERE connection_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(input.principal.connectionId, input.idempotencyKey)
      .first<{
        preview_id: string;
        actor_id: string;
        site_id: string;
        workspace_id: string;
        revision: number;
        request_hash: string;
        artifact_hash: string;
      }>();
    if (recorded === null) return null;
    if (
      recorded.actor_id !== input.principal.actorId ||
      recorded.site_id !== input.principal.siteId ||
      recorded.workspace_id !== input.workspaceId ||
      recorded.revision !== input.revision ||
      recorded.request_hash !== input.requestHash ||
      recorded.artifact_hash !== input.artifactHash
    ) {
      throw new McpReadError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used for different input.",
      );
    }
    return recorded;
  }

  function prepareAudit(
    audit: McpReadAuditEvent & { idempotencyKey: string },
  ) {
    return database
      .prepare(
        `INSERT INTO mcp_audit_events (
           invocation_id, connection_id, actor_id, site_id, operation,
           input_hash, protocol_version, scopes_json, outcome, reason,
           human_actor_id, revocation_reason, occurred_at, contract_version,
           idempotency_key, result_hash, replayed, workspace_id, revision,
           content_hash, preview_id
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                CASE
                  WHEN receipt.result_state = 'succeeded'
                    THEN 'allowed'
                  ELSE 'denied'
                END,
                receipt.error_code,
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
      );
  }

  function preparePreviewReceipt(
    input: PreviewInput,
    createdAt: string,
  ) {
    return database
      .prepare(
        `INSERT INTO mcp_mutation_receipts (
         site_id, actor_id, operation, idempotency_key, input_hash,
           invocation_id, result_hash, result_state, workspace_id, revision,
           content_hash, preview_id, replay_count, created_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'succeeded', ?8, ?9, ?10,
                artifact.preview_id, 0, ?11
         FROM mcp_preview_artifacts AS artifact
         WHERE artifact.connection_id = ?12
           AND artifact.idempotency_key = ?4
           AND artifact.actor_id = ?2
           AND artifact.site_id = ?1
           AND artifact.workspace_id = ?8
           AND artifact.revision = ?9
           AND artifact.request_hash = ?13
           AND artifact.artifact_hash = ?7
         ON CONFLICT (site_id, actor_id, operation, idempotency_key)
         DO UPDATE SET replay_count = replay_count + 1
         WHERE input_hash = excluded.input_hash`,
      )
      .bind(
        input.audit.siteId,
        input.audit.actorId,
        input.audit.operation,
        input.audit.idempotencyKey,
        input.audit.inputHash,
        input.audit.invocationId,
        input.artifactHash,
        input.workspaceId,
        input.revision,
        input.contentHash,
        createdAt,
        input.principal.connectionId,
        input.requestHash,
      );
  }

  function prepareFailureReceipt(input: {
    audit: McpReadAuditEvent & { idempotencyKey: string };
    resultHash: string;
    error: Readonly<{
      code: McpReadError["code"];
      message: string;
      latestRevision: number | null;
      conflictResource: string | null;
    }>;
  }) {
    return database
      .prepare(
        `INSERT INTO mcp_mutation_receipts (
           site_id, actor_id, operation, idempotency_key, input_hash,
           invocation_id, result_hash, result_state, workspace_id, revision,
           content_hash, preview_id, error_code, error_message,
           latest_revision, conflict_resource, replay_count, created_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'failed', NULL, NULL,
           NULL, NULL, ?8, ?9, ?10, ?11, 0, ?12
         )
         ON CONFLICT (site_id, actor_id, operation, idempotency_key)
         DO NOTHING`,
      )
      .bind(
        input.audit.siteId,
        input.audit.actorId,
        input.audit.operation,
        input.audit.idempotencyKey,
        input.audit.inputHash,
        input.audit.invocationId,
        input.resultHash,
        input.error.code,
        input.error.message,
        input.error.latestRevision,
        input.error.conflictResource,
        input.audit.occurredAt,
      );
  }

  function prepareIdempotencyConflictAudit(
    audit: McpReadAuditEvent & { idempotencyKey: string },
  ) {
    return database
      .prepare(
        `INSERT INTO mcp_audit_events (
           invocation_id, connection_id, actor_id, site_id, operation,
           input_hash, protocol_version, scopes_json, outcome, reason,
           human_actor_id, revocation_reason, occurred_at, contract_version,
           idempotency_key, replayed
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'denied',
           'IDEMPOTENCY_KEY_REUSED', NULL, NULL, ?9, ?10, ?11, 1
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
      );
  }

  return Object.freeze({
    async replayMutation(input: {
      principal: McpConnectionPrincipal;
      audit: McpReadAuditEvent & { idempotencyKey: string };
    }) {
      const receipt = await database
        .prepare(
          `SELECT input_hash, result_hash, result_state, workspace_id,
                  revision, content_hash, preview_id, error_code,
                  error_message, latest_revision, conflict_resource,
                  created_at
           FROM mcp_mutation_receipts
           WHERE site_id = ?1
             AND actor_id = ?2
             AND operation = ?3
             AND idempotency_key = ?4`,
        )
        .bind(
          input.principal.siteId,
          input.principal.actorId,
          input.audit.operation,
          input.audit.idempotencyKey,
        )
        .first<{
          input_hash: string;
          result_hash: string;
          result_state: "succeeded" | "failed";
          workspace_id: string | null;
          revision: number | null;
          content_hash: string | null;
          preview_id: string | null;
          error_code: McpReadError["code"] | null;
          error_message: string | null;
          latest_revision: number | null;
          conflict_resource: string | null;
          created_at: string;
        }>();
      if (receipt === null) return null;
      if (receipt.input_hash !== input.audit.inputHash) {
        throw new McpReadError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key was already used for different input.",
        );
      }
      await database.batch([
        database
          .prepare(
            `UPDATE mcp_mutation_receipts
             SET replay_count = replay_count + 1
             WHERE site_id = ?1
               AND actor_id = ?2
               AND operation = ?3
               AND idempotency_key = ?4
               AND input_hash = ?5`,
          )
          .bind(
            input.principal.siteId,
            input.principal.actorId,
            input.audit.operation,
            input.audit.idempotencyKey,
            input.audit.inputHash,
          ),
        prepareAudit(input.audit),
      ]);
      if (
        receipt.result_state === "failed" &&
        receipt.error_code !== null &&
        receipt.error_message !== null
      ) {
        throw new McpReadError(
          receipt.error_code,
          receipt.error_message,
          {
            observedAt: receipt.created_at,
            latestRevision: receipt.latest_revision ?? undefined,
            conflictResource: receipt.conflict_resource ?? undefined,
            replayed: true,
            auditRecorded: true,
          },
        );
      }
      if (
        receipt.workspace_id === null ||
        receipt.revision === null ||
        receipt.content_hash === null
      ) {
        throw new McpReadError(
          "TEMPORARILY_UNAVAILABLE",
          "The replayed mutation result is unavailable.",
          { auditRecorded: true },
        );
      }
      return {
        state: "succeeded" as const,
        workspaceId: receipt.workspace_id as ContentWorkspaceId,
        revision: receipt.revision,
        contentHash: receipt.content_hash,
        resultHash: receipt.result_hash,
        previewId: receipt.preview_id,
      };
    },
    async recordMutationFailure(input: {
      principal: McpConnectionPrincipal;
      audit: McpReadAuditEvent & { idempotencyKey: string };
      resultHash: string;
      error: Readonly<{
        code: McpReadError["code"];
        message: string;
        latestRevision: number | null;
        conflictResource: string | null;
      }>;
    }) {
      await prepareFailureReceipt(input).run();
      const receipt = await database
        .prepare(
          `SELECT input_hash, invocation_id, error_code, error_message,
                  latest_revision, conflict_resource, created_at
           FROM mcp_mutation_receipts
           WHERE site_id = ?1
             AND actor_id = ?2
             AND operation = ?3
             AND idempotency_key = ?4`,
        )
        .bind(
          input.audit.siteId,
          input.audit.actorId,
          input.audit.operation,
          input.audit.idempotencyKey,
        )
        .first<{
          input_hash: string;
          invocation_id: string;
          error_code: McpReadError["code"] | null;
          error_message: string | null;
          latest_revision: number | null;
          conflict_resource: string | null;
          created_at: string;
        }>();
      if (receipt === null) {
        throw new Error("mcp_failure_receipt_unavailable");
      }
      if (receipt.input_hash !== input.audit.inputHash) {
        await prepareIdempotencyConflictAudit(input.audit).run();
        const recorded = await database
          .prepare(
            `SELECT reason
             FROM mcp_audit_events
             WHERE invocation_id = ?1`,
          )
          .bind(input.audit.invocationId)
          .first<{ reason: string | null }>();
        if (recorded?.reason !== "IDEMPOTENCY_KEY_REUSED") {
          throw new Error("mcp_failure_audit_unavailable");
        }
        return {
          error: {
            code: "IDEMPOTENCY_KEY_REUSED" as const,
            message:
              "The idempotency key was already used for different input.",
            latestRevision: null,
            conflictResource: null,
          },
          observedAt: input.audit.occurredAt,
          replayed: true,
        };
      }
      if (
        receipt.error_code === null ||
        receipt.error_message === null
      ) {
        throw new Error("mcp_failure_receipt_invalid");
      }
      if (receipt.invocation_id !== input.audit.invocationId) {
        await database
          .prepare(
            `UPDATE mcp_mutation_receipts
             SET replay_count = replay_count + 1
             WHERE site_id = ?1
               AND actor_id = ?2
               AND operation = ?3
               AND idempotency_key = ?4
               AND input_hash = ?5`,
          )
          .bind(
            input.audit.siteId,
            input.audit.actorId,
            input.audit.operation,
            input.audit.idempotencyKey,
            input.audit.inputHash,
          )
          .run();
      }
      await prepareAudit(input.audit).run();
      const audit = await database
        .prepare(
          `SELECT outcome, reason
           FROM mcp_audit_events
           WHERE invocation_id = ?1`,
        )
        .bind(input.audit.invocationId)
        .first<{ outcome: string; reason: string | null }>();
      if (
        audit?.outcome !== "denied" ||
        audit.reason !== receipt.error_code
      ) {
        throw new Error("mcp_failure_audit_unavailable");
      }
      return {
        error: {
          code: receipt.error_code,
          message: receipt.error_message,
          latestRevision: receipt.latest_revision,
          conflictResource: receipt.conflict_resource,
        },
        observedAt: receipt.created_at,
        replayed: receipt.invocation_id !== input.audit.invocationId,
      };
    },
    async replayPreview(input: PreviewInput) {
      const recorded = await findRecorded(input);
      if (recorded !== null) {
        await prepareAudit(input.audit).run();
      }
      return recorded === null
        ? null
        : { previewId: recorded.preview_id, replayed: true as const };
    },
    async preparePreview(input: PreviewInput): Promise<PreparedPreview> {
      const previewId = createPreviewId();
      const createdAt = now();
      await beforePersist();
      await database.batch([
        database
          .prepare(
            `INSERT INTO mcp_preview_artifacts (
               preview_id, connection_id, actor_id, site_id, workspace_id,
               revision, idempotency_key, request_hash, artifact_hash,
               created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
             WHERE EXISTS (
               SELECT 1
               FROM mcp_connections AS connection
               JOIN mcp_connection_scopes AS scope
                 ON scope.connection_id = connection.id
               WHERE connection.id = ?2
                 AND connection.actor_id = ?3
                 AND connection.site_id = ?4
                 AND connection.status = 'active'
                 AND scope.scope IN ('content.draft', 'design.draft')
             )
             AND EXISTS (
               SELECT 1
               FROM content_workspaces AS workspace
               WHERE workspace.workspace_id = ?5
                 AND workspace.site_id = ?4
                 AND workspace.lifecycle = 'open'
                 AND workspace.current_revision = ?6
                 AND workspace.current_content_hash = ?12
                 AND (
                   workspace.owner_actor_id = 'mcp-' || ?3
                   OR EXISTS (
                     SELECT 1
                     FROM content_workspace_collaborators AS collaborator
                     WHERE collaborator.workspace_id = workspace.workspace_id
                       AND collaborator.actor_id = 'mcp-' || ?3
                   )
                 )
             )
             AND (
               NOT EXISTS (
                 SELECT 1 FROM mcp_mutation_receipts AS receipt
                 WHERE receipt.site_id = ?4
                   AND receipt.actor_id = ?3
                   AND receipt.operation = 'foundry.preview.prepare'
                   AND receipt.idempotency_key = ?7
               )
               OR EXISTS (
                 SELECT 1 FROM mcp_mutation_receipts AS receipt
                 WHERE receipt.site_id = ?4
                   AND receipt.actor_id = ?3
                   AND receipt.operation = 'foundry.preview.prepare'
                   AND receipt.idempotency_key = ?7
                   AND receipt.input_hash = ?11
                   AND receipt.result_state = 'succeeded'
                   AND receipt.result_hash = ?9
                   AND receipt.workspace_id = ?5
                   AND receipt.revision = ?6
                   AND receipt.content_hash = ?12
                   AND receipt.preview_id IS NOT NULL
               )
             )
             ON CONFLICT (connection_id, idempotency_key) DO NOTHING`,
          )
          .bind(
            previewId,
            input.principal.connectionId,
            input.principal.actorId,
            input.principal.siteId,
            input.workspaceId,
            input.revision,
            input.idempotencyKey,
            input.requestHash,
            input.artifactHash,
            createdAt,
            input.audit.inputHash,
            input.contentHash,
          ),
        preparePreviewReceipt(input, createdAt),
        prepareAudit(input.audit),
      ]);
      const recorded = await findRecorded(input);
      if (recorded === null) {
        const workspace = await database
          .prepare(
            `SELECT current_revision
             FROM content_workspaces AS workspace
             WHERE workspace.workspace_id = ?1
               AND workspace.site_id = ?2
               AND workspace.lifecycle = 'open'
               AND (
                 workspace.owner_actor_id = 'mcp-' || ?3
                 OR EXISTS (
                   SELECT 1
                   FROM content_workspace_collaborators AS collaborator
                   WHERE collaborator.workspace_id = workspace.workspace_id
                     AND collaborator.actor_id = 'mcp-' || ?3
                 )
               )`,
          )
          .bind(
            input.workspaceId,
            input.principal.siteId,
            input.principal.actorId,
          )
          .first<{ current_revision: number }>();
        if (
          workspace !== null &&
          workspace.current_revision !== input.revision
        ) {
          throw new McpReadError(
            "STALE_REVISION",
            "The workspace revision changed.",
            {
              latestRevision: workspace.current_revision,
              conflictResource:
                `foundry://workspaces/${input.workspaceId}` +
                `/revisions/${workspace.current_revision}`,
            },
          );
        }
        throw new McpReadError(
          "OBJECT_NOT_FOUND",
          "The requested object was not found.",
        );
      }
      return {
        previewId: recorded.preview_id,
        replayed: recorded.preview_id !== previewId,
      };
    },
  });
}

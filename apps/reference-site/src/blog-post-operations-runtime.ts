import {
  BlogPostOperationError,
  ContentApprovalInvalidError,
  ContentPublicationIdempotencyError,
  ContentPublicationValidationError,
  createBlogPostOperationsApplication,
  createContentApprovalId,
  createContentActorId,
  createContentPublicationId,
  createContentWorkspaceId,
  createHumanMembershipId,
  createInMemoryBlogPostOperationsStore,
  type BlogPostOperationsStore,
  type BlogPostScheduleExecution,
  type BlogPostScheduleExecutionLease,
  type ContentPublicationStatus,
} from "@foundry/application";

import { createD1BlogPostOperationsStore } from "./d1-blog-post-operations-store";
import {
  createD1BlogPostRestoreInitializationExtension,
} from "./d1-blog-post-restore-store";
import { createD1ContentPublicationStore } from "./d1-content-publication-store";
import {
  createContentPublicationApplicationForEnvironment,
  validateContentApprovalProductionAuthority,
} from "./content-publication-environment-runtime";
import {
  createContentRevisionApplicationForEnvironment,
  createRestoredContentRevisionApplicationForEnvironment,
} from "./content-revision-environment-runtime";
import {
  findContentRevision,
  hydrateManagedBlogPosts,
} from "./d1-content-revision-store";
import {
  createBlogPostId,
  isSiteDefinition,
  referenceSiteDefinition,
  type BlogPost,
  type BlogPostId,
} from "@foundry/site-definition";
import type { HumanAccessEnvironment } from "./human-access-configuration";

const localRuntime = globalThis as typeof globalThis & {
  __foundryBlogPostOperationsStore?: ReturnType<
    typeof createInMemoryBlogPostOperationsStore
  >;
};
localRuntime.__foundryBlogPostOperationsStore ??=
  createInMemoryBlogPostOperationsStore({
    humanActorIds: ["membership-local-owner"],
  });

type DurableBlogPostOperationsEnvironment =
  HumanAccessEnvironment & {
    FOUNDRY_DB: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>;
  };

export const bundledTimeZoneDatabaseVersion = "2026a";

export function readBlogPostTimeZoneDatabaseVersion(
  environment: HumanAccessEnvironment,
) {
  return environment.FOUNDRY_TIME_ZONE_DATABASE_VERSION ??
    bundledTimeZoneDatabaseVersion;
}

function createDurableBlogPostOperationsRuntime(
  environment: DurableBlogPostOperationsEnvironment,
) {
  const store = createD1BlogPostOperationsStore(environment.FOUNDRY_DB);
  return {
    store,
    application: createBlogPostOperationsApplication({
      store,
      validateApprovalAuthority: (
        approvalId,
        ownedPublicationIdempotencyKey,
      ) =>
        validateContentApprovalProductionAuthority(
          environment,
          approvalId,
          ownedPublicationIdempotencyKey,
        ),
      timeZoneDatabaseVersion: () =>
        readBlogPostTimeZoneDatabaseVersion(environment),
    }),
  };
}

export async function loadBlogPostOperationsApplication(
  environment: HumanAccessEnvironment,
) {
  if (
    process.env.NODE_ENV === "development" &&
    environment.FOUNDRY_DB === undefined
  ) {
    return createBlogPostOperationsApplication({
      store: localRuntime.__foundryBlogPostOperationsStore!,
    });
  }
  if (environment.FOUNDRY_DB === undefined) {
    throw new BlogPostOperationError("blog_post_operations_not_configured");
  }
  return createDurableBlogPostOperationsRuntime({
    ...environment,
    FOUNDRY_DB: environment.FOUNDRY_DB,
  }).application;
}

function executionOutcome(status: ContentPublicationStatus) {
  switch (status) {
    case "verified-live":
      return "completed" as const;
    case "blocked":
      return "blocked" as const;
    case "failed":
      return "failed" as const;
    case "unknown":
      return "unknown" as const;
    default:
      return null;
  }
}

export async function advanceScheduledBlogPostExecution(
  environment: HumanAccessEnvironment & {
    FOUNDRY_DB: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>;
  },
  store: BlogPostOperationsStore,
  lease: BlogPostScheduleExecutionLease,
) {
  const execution = lease.execution;
  const blogOperations = createBlogPostOperationsApplication({ store });
  const schedule = await store.findSchedule(execution.scheduleId);
  if (schedule === null) {
    await blogOperations.commands.recordExecutionOutcome({
      lease,
      outcomeId:
        `${execution.executionId}:${execution.attempt}:schedule_missing`,
      outcome: "blocked",
      detail: "schedule_missing",
    });
    return;
  }
  let outcome: Exclude<
    BlogPostScheduleExecution["state"],
    "claimed"
  > | null = null;
  let detail: string | null = null;
  let outcomeId: string | null = null;
  try {
    const mcpAuthority = await store.findMcpScheduleAuthority(
      schedule.id,
    );
    if (
      schedule.activatedBy.startsWith("mcp-") &&
      (
        mcpAuthority === null ||
        !(await store.hasMcpScheduleAuthority({
          siteId: schedule.siteId,
          connectionId: mcpAuthority.connectionId,
          actorId: mcpAuthority.actorId,
          requiredScopes: mcpAuthority.requiredScopes,
        }))
      )
    ) {
      throw new BlogPostOperationError(
        "mcp_schedule_authority_required",
      );
    }
    const publicationActorId =
      execution.attemptActorId === "system:scheduler"
        ? schedule.activatedBy
        : execution.attemptActorId;
    const application =
      await createContentPublicationApplicationForEnvironment(
      environment,
      schedule.workspaceId,
      createContentActorId(publicationActorId),
    );
    const publicationStore = createD1ContentPublicationStore(
      environment.FOUNDRY_DB,
    );
    const existing = await publicationStore.findPublicationByIdempotency({
      workspaceId: schedule.workspaceId,
      idempotencyKey: execution.publicationIdempotencyKey,
    });
    const requestedBy = createContentActorId(publicationActorId);
    const reservationProof = {
      executionId: execution.executionId,
      attempt: execution.attempt,
      leaseToken: lease.leaseToken,
    };
    const assertCurrentAuthority =
      mcpAuthority === null
        ? undefined
        : () =>
            store.hasMcpScheduleAuthority({
              siteId: schedule.siteId,
              connectionId: mcpAuthority.connectionId,
              actorId: mcpAuthority.actorId,
              requiredScopes: mcpAuthority.requiredScopes,
            });
    if (
      existing !== null &&
      !(await publicationStore.hasScheduledPublicationOwnership({
        publicationId: existing.id,
        executionId: execution.executionId,
      }))
    ) {
      throw new BlogPostOperationError(
        "publication_ownership_conflict",
      );
    }
    const publication =
      existing === null
        ? await application.commands.publish({
            workspaceId: schedule.workspaceId,
            approvalId: schedule.approvalId,
            requestedBy,
            idempotencyKey: execution.publicationIdempotencyKey,
            ...(mcpAuthority === null
              ? {}
              : {
                  authority: mcpAuthority,
                  assertCurrentAuthority,
                }),
            reservationProof,
          })
        : existing.status === "failed"
          ? await application.commands.retryDeployment(
              existing.id,
              requestedBy,
              reservationProof,
              assertCurrentAuthority,
            )
          : await application.commands.refresh(
              existing.id,
              reservationProof,
              assertCurrentAuthority,
            );
    if (publication === null) {
      throw new BlogPostOperationError("publication_missing");
    }
    if (
      !(await publicationStore.hasScheduledPublicationOwnership({
        publicationId: publication.id,
        executionId: execution.executionId,
      }))
    ) {
      throw new BlogPostOperationError(
        "publication_ownership_conflict",
      );
    }
    outcome = executionOutcome(publication.status);
    detail = publication.detail;
    outcomeId =
      outcome === null
        ? null
        : `${execution.executionId}:${execution.attempt}:publication:${publication.id}:${publication.status}`;
  } catch (error) {
    const definiteFailure =
      error instanceof ContentApprovalInvalidError ||
      error instanceof ContentPublicationValidationError ||
      error instanceof ContentPublicationIdempotencyError ||
      error instanceof BlogPostOperationError;
    outcome = definiteFailure ? "blocked" : "unknown";
    detail =
      error instanceof ContentApprovalInvalidError ||
      error instanceof ContentPublicationValidationError ||
      error instanceof BlogPostOperationError
        ? error.code
        : error instanceof ContentPublicationIdempotencyError
          ? error.message
          : "scheduled_publication_result_unknown";
    outcomeId =
      `${execution.executionId}:${execution.attempt}:publication:${detail}`;
  }
  if (outcome !== null && outcomeId !== null) {
    await blogOperations.commands.recordExecutionOutcome({
      lease,
      outcomeId,
      outcome,
      detail,
    });
  }
}

export async function runScheduledBlogPostPublications(
  environment: HumanAccessEnvironment,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new BlogPostOperationError("blog_post_operations_not_configured");
  }
  const durableEnvironment = {
    ...environment,
    FOUNDRY_DB: environment.FOUNDRY_DB,
  };
  const { store, application } =
    createDurableBlogPostOperationsRuntime(durableEnvironment);
  for (const schedule of await store.listDueSchedules(
    new Date().toISOString(),
    25,
  )) {
    try {
      const execution =
        await application.commands.claimDueSchedule(schedule.siteId, schedule.id);
      if (execution.lease !== null) {
        await advanceScheduledBlogPostExecution(
          durableEnvironment,
          store,
          execution.lease,
        );
      }
    } catch {
      console.error("scheduled_blog_claim_failed");
    }
  }
  for (const execution of await store.listPendingExecutions(25)) {
    try {
      const schedule = await store.findSchedule(execution.scheduleId);
      if (schedule === null) {
        throw new BlogPostOperationError("schedule_inactive");
      }
      const leased =
        await application.commands.retryExecutionAsScheduler(
          schedule.siteId,
          schedule.postId,
          execution.executionId,
        );
      await advanceScheduledBlogPostExecution(
        durableEnvironment,
        store,
        leased,
      );
    } catch {
      console.error("scheduled_blog_lease_failed");
    }
  }
}

export async function retryScheduledBlogPostExecution(
  environment: HumanAccessEnvironment,
  siteId: string,
  postId: BlogPostId,
  executionId: string,
  actorId: ReturnType<typeof createContentActorId>,
  requestId: string,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new BlogPostOperationError("blog_post_operations_not_configured");
  }
  const durableEnvironment = {
    ...environment,
    FOUNDRY_DB: environment.FOUNDRY_DB,
  };
  const { store, application } =
    createDurableBlogPostOperationsRuntime(durableEnvironment);
  const lease = await application.commands.retryExecution(
    siteId,
    postId,
    executionId,
    actorId,
    requestId,
  );
  if (lease.replayed !== true) {
    await advanceScheduledBlogPostExecution(
      durableEnvironment,
      store,
      lease,
    );
  }
  const execution = await application.queries.getExecution(
    siteId,
    executionId,
  );
  if (execution === null) {
    throw new BlogPostOperationError("execution_not_found");
  }
  return execution;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function restoreWorkspaceId(
  actorId: string,
  idempotencyKey: string,
) {
  const suffix = (await sha256Hex(
    `${referenceSiteDefinition.site.id}:blog-restore:${actorId}:${idempotencyKey}`,
  )).slice(0, 24);
  return createContentWorkspaceId(`workspace_${suffix}`);
}

async function restoreArchivedBlogPostAsDraftCommand(input: {
  environment: HumanAccessEnvironment;
  actorId: ReturnType<typeof createContentActorId>;
  postId: BlogPostId;
  selectedPostRevisionId: string;
  idempotencyKey: string;
}) {
  if (input.environment.FOUNDRY_DB === undefined) {
    throw new BlogPostOperationError("blog_post_operations_not_configured");
  }
  const database = input.environment.FOUNDRY_DB;
  const operationsStore = createD1BlogPostOperationsStore(database);
  if (!(await operationsStore.hasHumanContentAuthority({
    siteId: referenceSiteDefinition.site.id,
    actorId: input.actorId,
  }))) {
    throw new BlogPostOperationError("human_authority_required");
  }
  const priorRestore = await database.prepare(
    `SELECT record.restored_workspace_id,
            record.restored_content_revision,
            record.source_post_revision_id,
            record.actor_id,
            record.post_id,
            revision.snapshot_json
     FROM blog_post_restore_records AS record
     JOIN blog_post_revisions AS revision
       ON revision.revision_id = record.restored_post_revision_id
     WHERE record.site_id = ?1 AND record.request_id = ?3
     ORDER BY record.id
     LIMIT 1`,
  ).bind(
    referenceSiteDefinition.site.id,
    input.postId,
    input.idempotencyKey,
  ).first<{
    restored_workspace_id: string;
    restored_content_revision: number;
    source_post_revision_id: string;
    actor_id: string;
    post_id: string;
    snapshot_json: string;
  }>();
  if (priorRestore !== null) {
    if (
      priorRestore.post_id !== input.postId ||
      priorRestore.source_post_revision_id !==
        input.selectedPostRevisionId ||
      priorRestore.actor_id !== input.actorId
    ) {
      throw new BlogPostOperationError("idempotency_key_conflict");
    }
    const restoredSnapshot = JSON.parse(
      priorRestore.snapshot_json,
    ) as BlogPost;
    return {
      workspaceId: createContentWorkspaceId(priorRestore.restored_workspace_id),
      revision: priorRestore.restored_content_revision,
      postId: input.postId,
      postRevision: restoredSnapshot.revision,
      sourcePostRevisionId: priorRestore.source_post_revision_id,
      targetVisibility: "unpublished" as const,
    };
  }
  const operational = await createD1BlogPostOperationsStore(database)
    .findPost(referenceSiteDefinition.site.id, input.postId);
  if (operational?.collectionState !== "archived") {
    throw new BlogPostOperationError("post_not_archived");
  }
  await operationsStore.claimRestore({
    actorId: input.actorId,
    siteId: referenceSiteDefinition.site.id,
    postId: input.postId,
    selectedPostRevisionId: input.selectedPostRevisionId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: new Date().toISOString(),
  });
  const source = await database
    .prepare(
      `SELECT snapshot_json
       FROM blog_post_revisions
       WHERE site_id = ?1 AND post_id = ?2 AND revision_id = ?3`,
    )
    .bind(
      referenceSiteDefinition.site.id,
      input.postId,
      input.selectedPostRevisionId,
    )
    .first<{ snapshot_json: string }>();
  if (source === null) {
    throw new BlogPostOperationError("revision_not_found");
  }
  const selected = JSON.parse(source.snapshot_json) as BlogPost;
  const base = await hydrateManagedBlogPosts(
    database,
    referenceSiteDefinition,
  );
  const restoredPost: BlogPost = {
    ...selected,
    revision: operational.postRevision + 1,
    collectionState: "active",
    targetVisibility: "unpublished",
  };
  const definition = {
    ...base,
    blog: {
      ...base.blog,
      posts: [
        ...base.blog.posts.filter(({ id }) => id !== input.postId),
        restoredPost,
      ],
    },
  };
  if (!isSiteDefinition(definition)) {
    throw new BlogPostOperationError("restore_definition_invalid");
  }
  const workspaceId = await restoreWorkspaceId(
    input.actorId,
    input.idempotencyKey,
  );
  const revisionApplication =
    createRestoredContentRevisionApplicationForEnvironment(
      input.environment,
      workspaceId,
      input.actorId,
      definition,
      createD1BlogPostRestoreInitializationExtension({
        database,
        archivedPost: operational,
        actorId: input.actorId,
        sourcePostRevisionId: input.selectedPostRevisionId,
        requestId: input.idempotencyKey,
      }),
    );
  let revision;
  try {
    revision = await revisionApplication.commands.create({
      actorId: input.actorId,
      workspaceId,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("blog_post_restore_aggregate_not_advanced")
    ) {
      if (!(await operationsStore.hasHumanContentAuthority({
        siteId: referenceSiteDefinition.site.id,
        actorId: input.actorId,
      }))) {
        throw new BlogPostOperationError("human_authority_required");
      }
      throw new BlogPostOperationError("post_restore_conflict");
    }
    throw error;
  }
  const restoredArtifact = await database
    .prepare(
      `SELECT revision_id FROM blog_post_revisions
       WHERE workspace_id = ?1 AND content_revision = ?2 AND post_id = ?3`,
    )
    .bind(workspaceId, revision.revision, input.postId)
    .first<{ revision_id: string }>();
  if (restoredArtifact === null) {
    throw new BlogPostOperationError("restore_revision_missing");
  }
  const durableCompletion = await database
    .prepare(
      `SELECT record.response_json
       FROM blog_post_restore_records AS record
       JOIN blog_post_operation_audit_events AS audit
         ON audit.site_id = record.site_id
        AND audit.post_id = record.post_id
        AND audit.command_type = 'blog.post.restore'
        AND audit.request_id = record.request_id
        AND audit.outcome = 'accepted'
       WHERE record.site_id = ?1
         AND record.post_id = ?2
         AND record.request_id = ?3
         AND record.source_post_revision_id = ?4
         AND record.restored_workspace_id = ?5
         AND record.restored_content_revision = ?6
         AND record.restored_post_revision_id = ?7
         AND record.actor_id = ?8`,
    )
    .bind(
      referenceSiteDefinition.site.id,
      input.postId,
      input.idempotencyKey,
      input.selectedPostRevisionId,
      workspaceId,
      revision.revision,
      restoredArtifact.revision_id,
      input.actorId,
    )
    .first<{ response_json: string }>();
  if (durableCompletion === null) {
    throw new BlogPostOperationError("restore_completion_missing");
  }
  return {
    workspaceId,
    revision: revision.revision,
    postId: input.postId,
    postRevision: restoredPost.revision,
    sourcePostRevisionId: input.selectedPostRevisionId,
    targetVisibility: "unpublished" as const,
  };
}

export async function restoreArchivedBlogPostAsDraft(input: {
  environment: HumanAccessEnvironment;
  actorId: ReturnType<typeof createContentActorId>;
  postId: BlogPostId;
  selectedPostRevisionId: string;
  idempotencyKey: string;
}) {
  try {
    return await restoreArchivedBlogPostAsDraftCommand(input);
  } catch (error) {
    if (
      input.environment.FOUNDRY_DB !== undefined &&
      error instanceof BlogPostOperationError
    ) {
      const operations = createBlogPostOperationsApplication({
        store: createD1BlogPostOperationsStore(
          input.environment.FOUNDRY_DB,
        ),
      });
      await operations.commands.recordRejectedCommand({
        actorId: input.actorId,
        siteId: referenceSiteDefinition.site.id,
        postId: input.postId,
        commandType: "blog.post.restore",
        requestId: input.idempotencyKey,
        reasonCode: error.code,
      });
    }
    throw error;
  }
}

async function derivedKey(prefix: string, value: string) {
  return `${prefix}:${await sha256Hex(value)}`;
}

export async function archiveBlogPostWithWithdrawal(input: {
  environment: HumanAccessEnvironment;
  actorId: ReturnType<typeof createContentActorId>;
  postId: BlogPostId;
  selectedPostRevisionId: string;
  idempotencyKey: string;
}) {
  if (input.environment.FOUNDRY_DB === undefined) {
    throw new BlogPostOperationError("blog_post_operations_not_configured");
  }
  const store = createD1BlogPostOperationsStore(
    input.environment.FOUNDRY_DB,
  );
  const operations = createBlogPostOperationsApplication({ store });
  const archived = await operations.commands.archive({
    actorId: input.actorId,
    siteId: referenceSiteDefinition.site.id,
    postId: input.postId,
    selectedPostRevisionId: input.selectedPostRevisionId,
    idempotencyKey: input.idempotencyKey,
  });
  return prepareArchiveWithdrawal({
    environment: {
      ...input.environment,
      FOUNDRY_DB: input.environment.FOUNDRY_DB,
    },
    actorId: input.actorId,
    archived,
    archiveRequestId: input.idempotencyKey,
  });
}

async function prepareArchiveWithdrawal(input: {
  environment: HumanAccessEnvironment & {
    FOUNDRY_DB: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>;
  };
  actorId: ReturnType<typeof createContentActorId>;
  publicationActorId?: ReturnType<typeof createContentActorId>;
  archived: Awaited<
    ReturnType<
      ReturnType<typeof createBlogPostOperationsApplication>[
        "commands"
      ]["archive"]
    >
  >;
  archiveRequestId: string;
  withdrawalApprovalId?: string;
  withdrawalDraft?: {
    workspaceId: ReturnType<typeof createContentWorkspaceId>;
    revision: number;
  };
  acceptedContinuation?: {
    actorId: ReturnType<typeof createContentActorId>;
    requestId: string;
    approvalId: ReturnType<typeof createContentApprovalId>;
  };
}) {
  const { archived } = input;
  const store = createD1BlogPostOperationsStore(input.environment.FOUNDRY_DB);
  const operations = createBlogPostOperationsApplication({ store });
  if (!archived.withdrawalRequired) {
    return {
      archiveRequestId: input.archiveRequestId,
      archived,
      publication: null,
    };
  }
  const withdrawalWorkspaceId =
    input.withdrawalDraft?.workspaceId ??
    await restoreWorkspaceId(
      input.actorId,
      `archive:${input.archiveRequestId}`,
    );
  let withdrawalRevision = input.withdrawalDraft?.revision;
  const recordedWithdrawal =
    withdrawalRevision === undefined
      ? null
      : await findContentRevision(
          input.environment.FOUNDRY_DB,
          withdrawalWorkspaceId,
          withdrawalRevision,
        );
  const recordedPost = recordedWithdrawal?.definition.blog.posts.find(
    ({ id }) => id === archived.postId,
  );
  const withdrawalExists =
    recordedPost?.targetVisibility === "unpublished";
  if (!withdrawalExists) {
    if (recordedWithdrawal !== null) {
      throw new BlogPostOperationError(
        "archive_withdrawal_draft_conflict",
      );
    }
    const definition = await hydrateManagedBlogPosts(
      input.environment.FOUNDRY_DB,
      referenceSiteDefinition,
    );
    const revisions = createRestoredContentRevisionApplicationForEnvironment(
      input.environment,
      withdrawalWorkspaceId,
      input.actorId,
      definition,
    );
    const current = await revisions.commands.create({
      actorId: input.actorId,
      workspaceId: withdrawalWorkspaceId,
      idempotencyKey: `archive-workspace:${input.archiveRequestId}`,
    });
    const expectedWithdrawalRevision = current.revision + 1;
    if (
      withdrawalRevision !== undefined &&
      withdrawalRevision !== expectedWithdrawalRevision
    ) {
      throw new BlogPostOperationError(
        "archive_withdrawal_draft_conflict",
      );
    }
    if (input.withdrawalDraft === undefined) {
      await operations.commands.bindArchiveWithdrawalDraft({
        siteId: referenceSiteDefinition.site.id,
        postId: archived.postId,
        workspaceId: withdrawalWorkspaceId,
        contentRevision: expectedWithdrawalRevision,
        createdBy: input.actorId,
        requestId: input.archiveRequestId,
        occurredAt: new Date().toISOString(),
      });
    }
    const withdrawal = await revisions.commands.unpublishBlogPost({
      actorId: input.actorId,
      workspaceId: withdrawalWorkspaceId,
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: current.definition.schemaVersion,
      baseRevision: current.revision,
      postId: createBlogPostId(archived.postId),
      idempotencyKey: await derivedKey(
        "archive-unpublish",
        input.archiveRequestId,
      ),
    });
    if (withdrawal.revision !== expectedWithdrawalRevision) {
      throw new BlogPostOperationError(
        "archive_withdrawal_draft_conflict",
      );
    }
    withdrawalRevision = withdrawal.revision;
  }
  if (
    input.withdrawalDraft !== undefined &&
    input.acceptedContinuation !== undefined
  ) {
    await store.grantArchiveWithdrawalRecoveryAccess({
      siteId: referenceSiteDefinition.site.id,
      postId: archived.postId,
      archiveRequestId: input.archiveRequestId,
      workspaceId: withdrawalWorkspaceId,
      actorId: input.actorId,
      requestId: input.acceptedContinuation.requestId,
      occurredAt: new Date().toISOString(),
    });
  }
  const publications =
    await createContentPublicationApplicationForEnvironment(
      input.environment,
      withdrawalWorkspaceId,
      input.publicationActorId ?? input.actorId,
    );
  if (input.withdrawalApprovalId === undefined) {
    return {
      archived,
      archiveRequestId: input.archiveRequestId,
      publication: null,
      withdrawal: {
        workspaceId: withdrawalWorkspaceId,
        revision: withdrawalRevision,
        approvalRequired: true as const,
      },
    };
  }
  if (withdrawalRevision === undefined) {
    throw new BlogPostOperationError(
      "archive_withdrawal_draft_conflict",
    );
  }
  const withdrawalApprovalId = createContentApprovalId(
    input.withdrawalApprovalId,
  );
  const requestedBy = createHumanMembershipId(
    input.publicationActorId ?? input.actorId,
  );
  const publicationIdempotencyKey = await derivedKey(
    "archive-publication",
    input.archiveRequestId,
  );
  const publicationStore = createD1ContentPublicationStore(
    input.environment.FOUNDRY_DB,
  );
  const adoptArchivePublication = async (
    existing: NonNullable<
      Awaited<
        ReturnType<
          typeof publicationStore.findPublicationByIdempotency
        >
      >
    >,
  ) => {
    const approval = await publicationStore.findApproval(
      withdrawalApprovalId,
    );
    if (
      approval === null ||
      approval.workspaceId !== withdrawalWorkspaceId ||
      approval.revision !== withdrawalRevision ||
      existing.workspaceId !== withdrawalWorkspaceId ||
      existing.revision !== withdrawalRevision ||
      existing.approvalId !== approval.id ||
      existing.fingerprint !== approval.fingerprint.value ||
      !approval.fingerprint.postArtifacts.some(
        ({ postId }) => postId === archived.postId,
      )
    ) {
      throw new BlogPostOperationError(
        "archive_publication_mismatch",
      );
    }
    if (existing.status === "failed") {
      return publications.commands.retryDeployment(
        existing.id,
        requestedBy,
      );
    }
    return await publications.commands.refresh(existing.id) ??
      existing;
  };
  const findExistingArchivePublication = () =>
    publicationStore.findPublicationByIdempotency({
      workspaceId: withdrawalWorkspaceId,
      idempotencyKey: publicationIdempotencyKey,
    });
  const existingArchivePublication =
    await findExistingArchivePublication();
  let publication;
  if (existingArchivePublication !== null) {
    publication = await adoptArchivePublication(
      existingArchivePublication,
    );
  } else {
    try {
      publication = await publications.commands.publish({
        workspaceId: withdrawalWorkspaceId,
        approvalId: withdrawalApprovalId,
        requestedBy,
        idempotencyKey: publicationIdempotencyKey,
      });
    } catch (error) {
      if (!(error instanceof ContentPublicationIdempotencyError)) {
        throw error;
      }
      const racedPublication = await findExistingArchivePublication();
      if (racedPublication === null) {
        throw error;
      }
      publication = await adoptArchivePublication(racedPublication);
    }
  }
  if (publication.status === "verified-live") {
    publication =
      await publications.commands.refresh(publication.id) ??
      publication;
  }
  const result = {
    archiveRequestId: input.archiveRequestId,
    archived,
    publication,
  };
  await operations.commands.bindArchiveWithdrawal({
    siteId: referenceSiteDefinition.site.id,
    postId: archived.postId,
    publicationId: publication.id,
    occurredAt: publication.requestedAt,
    acceptedContinuation:
      input.acceptedContinuation === undefined
        ? undefined
        : {
            ...input.acceptedContinuation,
            beforeState: archived,
            afterState: result,
          },
  });
  if (publication.status === "verified-live") {
    await operations.commands.confirmArchiveWithdrawal({
      siteId: referenceSiteDefinition.site.id,
      postId: archived.postId,
      publicationId: publication.id,
    });
  }
  return result;
}

export async function recoverArchiveBlogPostWithdrawalAccess(input: {
  environment: HumanAccessEnvironment;
  actorId: ReturnType<typeof createContentActorId>;
  postId: BlogPostId;
  archiveRequestId: string;
  requestId: string;
}) {
  if (input.environment.FOUNDRY_DB === undefined) {
    throw new BlogPostOperationError("blog_post_operations_not_configured");
  }
  const database = input.environment.FOUNDRY_DB;
  const store = createD1BlogPostOperationsStore(database);
  const occurredAt = new Date().toISOString();
  const reject = async (
    reasonCode: string,
    beforeState: unknown = null,
  ) => {
    await store.recordAudit({
      siteId: referenceSiteDefinition.site.id,
      postId: input.postId,
      actorId: input.actorId,
      commandType: "blog.post.archive.withdrawal.recover_access",
      requestId: input.requestId,
      outcome: "rejected",
      reasonCode,
      beforeState,
      afterState: null,
      occurredAt,
    });
    throw new BlogPostOperationError(reasonCode);
  };
  if (!(await store.hasHumanContentAuthority({
    siteId: referenceSiteDefinition.site.id,
    actorId: input.actorId,
  }))) {
    return reject("human_authority_required");
  }
  const row = await database
    .prepare(
      `SELECT withdrawal_workspace_id, withdrawal_content_revision,
              collection_state
       FROM blog_post_collection_states
       WHERE site_id = ?1 AND post_id = ?2
         AND archive_request_id = ?3
         AND collection_state IN ('archiving', 'archived')`,
    )
    .bind(
      referenceSiteDefinition.site.id,
      input.postId,
      input.archiveRequestId,
    )
    .first<{
      withdrawal_workspace_id: string | null;
      withdrawal_content_revision: number | null;
      collection_state: "archiving" | "archived";
    }>();
  if (
    row === null ||
    row.withdrawal_workspace_id === null ||
    row.withdrawal_content_revision === null
  ) {
    return reject("archive_request_not_found");
  }
  const workspaceId = createContentWorkspaceId(
    row.withdrawal_workspace_id,
  );
  try {
    await store.grantArchiveWithdrawalRecoveryAccess({
      siteId: referenceSiteDefinition.site.id,
      postId: input.postId,
      archiveRequestId: input.archiveRequestId,
      workspaceId,
      actorId: input.actorId,
      requestId: input.requestId,
      occurredAt,
    });
  } catch (error) {
    if (error instanceof BlogPostOperationError) {
      await store.recordAudit({
        siteId: referenceSiteDefinition.site.id,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.archive.withdrawal.recover_access",
        requestId: input.requestId,
        outcome: "rejected",
        reasonCode: error.code,
        beforeState: await store.findPost(
          referenceSiteDefinition.site.id,
          input.postId,
        ),
        afterState: null,
        occurredAt,
      });
    }
    throw error;
  }
  return {
    archiveRequestId: input.archiveRequestId,
    withdrawal: {
      workspaceId,
      revision: row.withdrawal_content_revision,
      approvalRequired: true as const,
    },
  };
}

export async function continueArchiveBlogPostWithdrawal(input: {
  environment: HumanAccessEnvironment;
  actorId: ReturnType<typeof createContentActorId>;
  postId: BlogPostId;
  archiveRequestId: string;
  withdrawalApprovalId: string;
  requestId: string;
}) {
  if (input.environment.FOUNDRY_DB === undefined) {
    throw new BlogPostOperationError("blog_post_operations_not_configured");
  }
  const database = input.environment.FOUNDRY_DB;
  const store = createD1BlogPostOperationsStore(database);
  const occurredAt = new Date().toISOString();
  const findAcceptedReplay = () =>
    database
      .prepare(
        `SELECT post_id, actor_id, after_state_json
         FROM blog_post_operation_audit_events
         WHERE site_id = ?1
           AND command_type = 'blog.post.archive.withdrawal.continue'
           AND request_id = ?2 AND outcome = 'accepted'`,
      )
      .bind(
        referenceSiteDefinition.site.id,
        input.requestId,
      )
      .first<{
        post_id: string | null;
        actor_id: string;
        after_state_json: string;
      }>();
  const parseReplay = (
    replay: {
      post_id: string | null;
      actor_id: string;
      after_state_json: string;
    },
  ) => {
    const result = JSON.parse(replay.after_state_json) as {
      archiveRequestId: string;
      publication: { approvalId: string } | null;
    };
    if (
      replay.post_id !== input.postId ||
      replay.actor_id !== input.actorId ||
      result.archiveRequestId !== input.archiveRequestId ||
      result.publication?.approvalId !== input.withdrawalApprovalId
    ) {
      throw new BlogPostOperationError("idempotency_key_conflict");
    }
    return result;
  };
  if (!(await store.hasHumanContentAuthority({
    siteId: referenceSiteDefinition.site.id,
    actorId: input.actorId,
  }))) {
    await store.recordAudit({
      siteId: referenceSiteDefinition.site.id,
      postId: input.postId,
      actorId: input.actorId,
      commandType: "blog.post.archive.withdrawal.continue",
      requestId: input.requestId,
      outcome: "rejected",
      reasonCode: "human_authority_required",
      beforeState: null,
      afterState: null,
      occurredAt,
    });
    throw new BlogPostOperationError("human_authority_required");
  }
  const replay = await findAcceptedReplay();
  if (replay !== null) {
    return parseReplay(replay);
  }
  const row = await database
    .prepare(
      `SELECT selected_post_revision_id, previous_live_revision_id,
              withdrawal_workspace_id, withdrawal_content_revision,
              collection_state, archive_publication_id
       FROM blog_post_collection_states
       WHERE site_id = ?1 AND post_id = ?2
         AND archive_request_id = ?3`,
    )
    .bind(
      referenceSiteDefinition.site.id,
      input.postId,
      input.archiveRequestId,
    )
    .first<{
      selected_post_revision_id: string;
      previous_live_revision_id: string | null;
      withdrawal_workspace_id: string | null;
      withdrawal_content_revision: number | null;
      collection_state: "archiving" | "archived";
      archive_publication_id: string | null;
    }>();
  if (row === null) {
    await store.recordAudit({
      siteId: referenceSiteDefinition.site.id,
      postId: input.postId,
      actorId: input.actorId,
      commandType: "blog.post.archive.withdrawal.continue",
      requestId: input.requestId,
      outcome: "rejected",
      reasonCode: "archive_request_not_found",
      beforeState: null,
      afterState: null,
      occurredAt: new Date().toISOString(),
    });
    throw new BlogPostOperationError("archive_request_not_found");
  }
  const operational = await store.findPost(
    referenceSiteDefinition.site.id,
    input.postId,
  );
  if (
    operational === null ||
    (
      operational.collectionState !== "archiving" &&
      operational.collectionState !== "archived"
    )
  ) {
    await store.recordAudit({
      siteId: referenceSiteDefinition.site.id,
      postId: input.postId,
      actorId: input.actorId,
      commandType: "blog.post.archive.withdrawal.continue",
      requestId: input.requestId,
      outcome: "rejected",
      reasonCode: "archive_request_not_found",
      beforeState: operational,
      afterState: null,
      occurredAt,
    });
    throw new BlogPostOperationError("archive_request_not_found");
  }
  const archived = {
    ...operational,
    selectedPostRevisionId: row.selected_post_revision_id,
    withdrawalRequired: row.previous_live_revision_id !== null,
  };
  try {
    const result =
      row.collection_state === "archived"
        ? {
            archiveRequestId: input.archiveRequestId,
            archived,
            publication:
              row.archive_publication_id === null
                ? null
                : await createD1ContentPublicationStore(database)
                    .findPublication(
                      createContentPublicationId(
                        row.archive_publication_id,
                      ),
                    ),
          }
        : await prepareArchiveWithdrawal({
            environment: {
              ...input.environment,
              FOUNDRY_DB: database,
            },
            actorId: input.actorId,
            archived,
            archiveRequestId: input.archiveRequestId,
            withdrawalApprovalId: input.withdrawalApprovalId,
            acceptedContinuation: {
              actorId: input.actorId,
              requestId: input.requestId,
              approvalId: createContentApprovalId(
                input.withdrawalApprovalId,
              ),
            },
            withdrawalDraft:
              row.withdrawal_workspace_id === null ||
              row.withdrawal_content_revision === null
                ? undefined
                : {
                    workspaceId: createContentWorkspaceId(
                      row.withdrawal_workspace_id,
                    ),
                    revision: row.withdrawal_content_revision,
                  },
          });
    if (
      result.publication === null ||
      result.publication.approvalId !== input.withdrawalApprovalId
    ) {
      throw new BlogPostOperationError("archive_publication_mismatch");
    }
    if (row.collection_state === "archived") {
      await store.recordAudit({
        siteId: referenceSiteDefinition.site.id,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.archive.withdrawal.continue",
        requestId: input.requestId,
        outcome: "accepted",
        reasonCode: "accepted",
        beforeState: archived,
        afterState: result,
        occurredAt,
      });
    }
    return result;
  } catch (error) {
    if (
      error instanceof ContentApprovalInvalidError ||
      error instanceof ContentPublicationValidationError ||
      error instanceof BlogPostOperationError
    ) {
      const acceptedReplay = await findAcceptedReplay();
      if (acceptedReplay !== null) {
        return parseReplay(acceptedReplay);
      }
      const reasonCode =
        error instanceof ContentApprovalInvalidError
          ? error.code
          : error instanceof ContentPublicationValidationError
            ? error.code
          : error.code;
      await store.recordAudit({
        siteId: referenceSiteDefinition.site.id,
        postId: input.postId,
        actorId: input.actorId,
        commandType: "blog.post.archive.withdrawal.continue",
        requestId: input.requestId,
        outcome: "rejected",
        reasonCode,
        beforeState: archived,
        afterState: null,
        occurredAt,
      });
      throw error instanceof BlogPostOperationError
        ? error
        : new BlogPostOperationError(error.code);
    }
    throw error;
  }
}

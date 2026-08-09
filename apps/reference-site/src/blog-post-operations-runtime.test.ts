import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBlogPostOperationsApplication,
  createContentActorId,
  createContentApprovalId,
  createContentWorkspaceId,
  createInMemoryBlogPostOperationsStore,
  ContentPublicationValidationError,
} from "@humber-foundry/application";
import {
  createBlogPostId,
  createSiteId,
} from "@humber-foundry/site-definition";

const mocks = vi.hoisted(() => ({
  findApproval: vi.fn(),
  findPublicationByIdempotency: vi.fn(),
  hasScheduledPublicationOwnership: vi.fn(),
  publish: vi.fn(),
  refresh: vi.fn(),
  retryDeployment: vi.fn(),
  validateApprovalAuthority: vi.fn(),
  operationsStore: undefined as unknown,
}));

vi.mock("./d1-blog-post-operations-store", () => ({
  createD1BlogPostOperationsStore: () => mocks.operationsStore,
}));

vi.mock("./d1-content-publication-store", () => ({
  createD1ContentPublicationStore: () => ({
    findApproval: mocks.findApproval,
    findPublicationByIdempotency:
      mocks.findPublicationByIdempotency,
    hasScheduledPublicationOwnership:
      mocks.hasScheduledPublicationOwnership,
  }),
}));

vi.mock("./content-publication-environment-runtime", () => ({
  createContentPublicationApplicationForEnvironment: async () => ({
    commands: {
      publish: mocks.publish,
      refresh: mocks.refresh,
      retryDeployment: mocks.retryDeployment,
    },
  }),
  validateContentApprovalProductionAuthority:
    mocks.validateApprovalAuthority,
}));

vi.mock("server-only", () => ({}));

import {
  advanceScheduledBlogPostExecution,
  continueArchiveBlogPostWithdrawal,
  readBlogPostTimeZoneDatabaseVersion,
} from "./blog-post-operations-runtime";

describe("scheduled blog post execution runtime", () => {
  const now = "2026-11-01T08:00:00.000Z";
  const beforeNow = "2026-11-01T07:59:59.999Z";
  let operationTime = beforeNow;
  const siteId = createSiteId("site_runtime_retry");
  const postId = createBlogPostId("00000000-0000-4000-8000-000000000245");
  const actorId = createContentActorId("membership-editor");
  const workspaceId = createContentWorkspaceId("workspace_runtime_retry");
  const approvalId = createContentApprovalId(`approval_${"9".repeat(32)}`);

  beforeEach(() => {
    vi.clearAllMocks();
    operationTime = beforeNow;
    mocks.validateApprovalAuthority.mockResolvedValue(true);
    mocks.findApproval.mockResolvedValue(null);
    mocks.findPublicationByIdempotency.mockResolvedValue(null);
    mocks.hasScheduledPublicationOwnership.mockResolvedValue(true);
    mocks.operationsStore = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
    });
  });

  it("uses the explicit Worker time-zone database release", () => {
    expect(readBlogPostTimeZoneDatabaseVersion({
      FOUNDRY_TIME_ZONE_DATABASE_VERSION: "2026a",
    })).toBe("2026a");
    expect(readBlogPostTimeZoneDatabaseVersion({})).toBe("2026a");
  });

  it("blocks a due MCP schedule when its originating grant is revoked", async () => {
    const mcpActorId = createContentActorId("mcp-runtime-agent");
    const store = createInMemoryBlogPostOperationsStore({
      mcpScheduleAccess: [{
        connectionId: "connection-runtime-agent",
        actorId: "runtime-agent",
        siteId,
      }],
      posts: [{
        siteId,
        postId,
        workspaceId,
        contentRevision: 1,
        postRevision: 1,
        postRevisionId: "post-revision-runtime-mcp",
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: null,
        version: 1,
      }],
      approvals: [{
        id: approvalId,
        siteId,
        workspaceId,
        contentRevision: 1,
        fingerprint: "approved-runtime-mcp",
        postArtifacts: [{
          postId,
          postRevisionId: "post-revision-runtime-mcp",
        }],
        invalidatedAt: null,
      }],
    });
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_runtime_mcp`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId: mcpActorId,
      siteId,
      postId,
      approvalId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-runtime-mcp",
      authority: {
        kind: "mcp",
        connectionId: "connection-runtime-agent",
        actorId: "runtime-agent",
        operation: "foundry.publication.schedule",
        requiredScopes: [
          "publication.schedule",
          "content.draft",
        ],
      },
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(
      schedule.siteId,
      schedule.id,
    );
    const revokedStore = {
      ...store,
      async hasMcpScheduleAuthority() {
        return false;
      },
    };

    await advanceScheduledBlogPostExecution(
      { FOUNDRY_DB: {} as never },
      revokedStore,
      claim.lease!,
    );

    expect(mocks.publish).not.toHaveBeenCalled();
    await expect(
      revokedStore.findExecution(claim.execution.executionId),
    ).resolves.toMatchObject({
      state: "blocked",
      detail: "mcp_schedule_authority_required",
    });
  });

  it("re-dispatches a failed owned publication instead of only refreshing it", async () => {
    const store = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
      posts: [{
        siteId,
        postId,
        workspaceId,
        contentRevision: 1,
        postRevision: 1,
        postRevisionId: "post-revision-runtime",
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: null,
        version: 1,
      }],
      approvals: [{
        id: approvalId,
        siteId,
        workspaceId,
        contentRevision: 1,
        fingerprint: "approved-runtime-fingerprint",
        postArtifacts: [{
          postId,
          postRevisionId: "post-revision-runtime",
        }],
        invalidatedAt: null,
      }],
    });
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_runtime_retry`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId,
      postId,
      approvalId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-runtime-retry",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-runtime-retry",
      status: "failed",
      detail: "deployment_failed",
    });
    mocks.retryDeployment.mockResolvedValue({
      id: "publication-runtime-retry",
      status: "requested",
      detail: "deployment_retry_dispatching",
    });

    await advanceScheduledBlogPostExecution(
      { FOUNDRY_DB: {} as never },
      store,
      claim.lease!,
    );

    expect(mocks.retryDeployment).toHaveBeenCalledWith(
      "publication-runtime-retry",
      actorId,
      {
        executionId: claim.execution.executionId,
        attempt: claim.execution.attempt,
        leaseToken: claim.lease!.leaseToken,
      },
      undefined,
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refreshes an owned verified publication before completing recovery", async () => {
    const store = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
      posts: [{
        siteId,
        postId,
        workspaceId,
        contentRevision: 1,
        postRevision: 1,
        postRevisionId: "post-revision-runtime",
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: null,
        version: 1,
      }],
      approvals: [{
        id: approvalId,
        siteId,
        workspaceId,
        contentRevision: 1,
        fingerprint: "approved-runtime-fingerprint",
        postArtifacts: [{
          postId,
          postRevisionId: "post-revision-runtime",
        }],
        invalidatedAt: null,
      }],
    });
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_runtime_verified`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId,
      postId,
      approvalId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-runtime-verified",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-runtime-verified",
      status: "verified-live",
      detail: null,
    });
    mocks.refresh.mockResolvedValue({
      id: "publication-runtime-verified",
      status: "verified-live",
      detail: null,
    });

    await advanceScheduledBlogPostExecution(
      { FOUNDRY_DB: {} as never },
      store,
      claim.lease!,
    );

    expect(mocks.refresh).toHaveBeenCalledWith(
      "publication-runtime-verified",
      {
        executionId: claim.execution.executionId,
        attempt: claim.execution.attempt,
        leaseToken: claim.lease!.leaseToken,
      },
      undefined,
    );
    await expect(
      app.queries.getExecution(siteId, claim.execution.executionId),
    ).resolves.toMatchObject({ state: "completed", detail: null });
  });

  it("blocks adoption of a publication without the claimed execution attribution", async () => {
    const store = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
      posts: [{
        siteId,
        postId,
        workspaceId,
        contentRevision: 1,
        postRevision: 1,
        postRevisionId: "post-revision-runtime",
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: null,
        version: 1,
      }],
      approvals: [{
        id: approvalId,
        siteId,
        workspaceId,
        contentRevision: 1,
        fingerprint: "approved-runtime-fingerprint",
        postArtifacts: [{
          postId,
          postRevisionId: "post-revision-runtime",
        }],
        invalidatedAt: null,
      }],
    });
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_runtime_unowned`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId,
      postId,
      approvalId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-runtime-unowned",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(
      schedule.siteId,
      schedule.id,
    );
    mocks.findPublicationByIdempotency.mockResolvedValue({
      id: "publication-runtime-unowned",
      status: "committed",
      detail: null,
    });
    mocks.hasScheduledPublicationOwnership.mockResolvedValue(false);

    await advanceScheduledBlogPostExecution(
      { FOUNDRY_DB: {} as never },
      store,
      claim.lease!,
    );

    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.retryDeployment).not.toHaveBeenCalled();
    await expect(
      app.queries.getExecution(siteId, claim.execution.executionId),
    ).resolves.toMatchObject({
      state: "blocked",
      detail: "publication_ownership_conflict",
    });
  });

  it("records definite pre-dispatch publication rejection as blocked rather than unknown", async () => {
    const store = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId],
      posts: [{
        siteId,
        postId,
        workspaceId,
        contentRevision: 1,
        postRevision: 1,
        postRevisionId: "post-revision-runtime",
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: null,
        version: 1,
      }],
      approvals: [{
        id: approvalId,
        siteId,
        workspaceId,
        contentRevision: 1,
        fingerprint: "approved-runtime-fingerprint",
        postArtifacts: [{
          postId,
          postRevisionId: "post-revision-runtime",
        }],
        invalidatedAt: null,
      }],
    });
    const app = createBlogPostOperationsApplication({
      store,
      now: () => operationTime,
      createId: (kind) => `${kind}_runtime_blocked`,
      timeZoneDatabaseVersion: () => "2026a",
    });
    const schedule = await app.commands.activateSchedule({
      actorId,
      siteId,
      postId,
      approvalId,
      resolvedTime: {
        localDateTime: "2026-11-01T01:00:00",
        ianaTimeZone: "America/Vancouver",
        utcOffsetChoice: "-07:00",
        executeAtUtc: now,
      },
      idempotencyKey: "activate-runtime-blocked",
    });
    operationTime = now;
    const claim = await app.commands.claimDueSchedule(schedule.siteId, schedule.id);
    mocks.findPublicationByIdempotency.mockResolvedValue(null);
    mocks.publish.mockRejectedValue(
      new ContentPublicationValidationError("publication_no_changes"),
    );

    await advanceScheduledBlogPostExecution(
      { FOUNDRY_DB: {} as never },
      store,
      claim.lease!,
    );

    await expect(
      app.queries.getExecution(siteId, claim.execution.executionId),
    ).resolves.toMatchObject({
      state: "blocked",
      detail: "publication_no_changes",
    });
  });

  it("replays an accepted archive continuation after the archive reaches its terminal state", async () => {
    const approval = `approval_${"7".repeat(32)}`;
    const accepted = {
      archiveRequestId: "archive-terminal-request",
      archived: {
        postId,
        collectionState: "archiving",
        withdrawalRequired: true,
      },
      publication: {
        id: `publish_${"8".repeat(32)}`,
        approvalId: approval,
        status: "verified-live",
      },
    };
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            post_id: postId,
            actor_id: actorId,
            after_state_json: JSON.stringify(accepted),
          }),
        })),
      })),
    };

    await expect(continueArchiveBlogPostWithdrawal({
      environment: { FOUNDRY_DB: database as never },
      actorId,
      postId,
      archiveRequestId: accepted.archiveRequestId,
      withdrawalApprovalId: approval,
      requestId: "archive-terminal-continuation-receipt",
    })).resolves.toEqual(accepted);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects an archive continuation replay when the caller no longer has human authority", async () => {
    const approval = `approval_${"7".repeat(32)}`;
    const database = {
      prepare: vi.fn(),
    };
    mocks.operationsStore = createInMemoryBlogPostOperationsStore();

    await expect(continueArchiveBlogPostWithdrawal({
      environment: { FOUNDRY_DB: database as never },
      actorId,
      postId,
      archiveRequestId: "archive-suspended-caller",
      withdrawalApprovalId: approval,
      requestId: "archive-suspended-caller-replay",
    })).rejects.toMatchObject({ code: "human_authority_required" });
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("lets a current Editor continue a verified withdrawal draft created by another Editor", async () => {
    const archiveRequestId = "archive-verified-before-binding";
    const withdrawalApprovalId = `approval_${"7".repeat(32)}`;
    const selectedPostRevisionId = "post-revision-verified-withdrawal";
    const originalActorId = createContentActorId(
      "membership-original-editor",
    );
    const archiveStore = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId, originalActorId],
      posts: [{
        siteId: createSiteId("site_foundry_reference"),
        postId,
        workspaceId,
        contentRevision: 1,
        postRevision: 1,
        postRevisionId: selectedPostRevisionId,
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: selectedPostRevisionId,
        version: 1,
      }],
    });
    mocks.operationsStore = archiveStore;
    const archiveApplication = createBlogPostOperationsApplication({
      store: archiveStore,
      now: () => now,
    });
    await archiveApplication.commands.archive({
      actorId: originalActorId,
      siteId: "site_foundry_reference",
      postId,
      selectedPostRevisionId,
      idempotencyKey: archiveRequestId,
    });
    await archiveApplication.commands.bindArchiveWithdrawalDraft({
      siteId: "site_foundry_reference",
      postId,
      workspaceId,
      contentRevision: 1,
      createdBy: originalActorId,
      requestId: archiveRequestId,
      occurredAt: now,
    });
    const publication = {
      id: `publish_${"8".repeat(32)}`,
      workspaceId,
      revision: 1,
      approvalId: withdrawalApprovalId,
      fingerprint: "verified-withdrawal-fingerprint",
      idempotencyKey: expect.any(String),
      requestedBy: originalActorId,
      requestedAt: now,
      status: "verified-live",
    };
    mocks.publish.mockResolvedValue(publication);
    mocks.refresh.mockResolvedValue(publication);
    const archiveRow = {
      selected_post_revision_id: selectedPostRevisionId,
      previous_live_revision_id: selectedPostRevisionId,
      withdrawal_workspace_id: workspaceId,
      withdrawal_content_revision: 1,
      collection_state: "archiving",
      archive_publication_id: null,
    };
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(
            query.includes("blog_post_operation_audit_events")
              ? null
              : query.includes("FROM content_revisions")
                ? {
                    workspace_id: workspaceId,
                    revision: 1,
                    definition_json: JSON.stringify({
                      blog: {
                        posts: [{
                          id: postId,
                          targetVisibility: "unpublished",
                        }],
                      },
                    }),
                    content_hash: "withdrawal-content",
                    schema_version: "foundry.site-definition.v1",
                    renderer_version: "renderer-v1",
                    production_base:
                      `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
                    created_at: now,
                    created_by: originalActorId,
                  }
              : archiveRow,
          ),
        })),
      })),
    };

    await expect(continueArchiveBlogPostWithdrawal({
      environment: { FOUNDRY_DB: database as never },
      actorId,
      postId,
      archiveRequestId,
      withdrawalApprovalId,
      requestId: "continue-verified-before-binding",
    })).resolves.toMatchObject({
      archiveRequestId,
      publication: { id: publication.id, status: "verified-live" },
    });

    expect(mocks.refresh).toHaveBeenCalledWith(publication.id);
    await expect(
      archiveStore.findPost(
        "site_foundry_reference",
        postId,
      ),
    ).resolves.toMatchObject({
      collectionState: "archived",
      liveRevisionId: null,
    });
  });

  it("lets a replacement Owner adopt and retry the exact failed withdrawal publication", async () => {
    const archiveRequestId = "archive-publication-created-before-binding";
    const withdrawalApprovalId = `approval_${"6".repeat(32)}`;
    const selectedPostRevisionId = "post-revision-failed-withdrawal";
    const originalActorId = createContentActorId(
      "membership-original-owner",
    );
    const archiveStore = createInMemoryBlogPostOperationsStore({
      humanActorIds: [actorId, originalActorId],
      posts: [{
        siteId: createSiteId("site_foundry_reference"),
        postId,
        workspaceId,
        contentRevision: 1,
        postRevision: 1,
        postRevisionId: selectedPostRevisionId,
        collectionState: "active",
        workflowState: "editing",
        liveRevisionId: selectedPostRevisionId,
        version: 1,
      }],
    });
    mocks.operationsStore = archiveStore;
    const archiveApplication = createBlogPostOperationsApplication({
      store: archiveStore,
      now: () => now,
    });
    await archiveApplication.commands.archive({
      actorId: originalActorId,
      siteId: "site_foundry_reference",
      postId,
      selectedPostRevisionId,
      idempotencyKey: archiveRequestId,
    });
    await archiveApplication.commands.bindArchiveWithdrawalDraft({
      siteId: "site_foundry_reference",
      postId,
      workspaceId,
      contentRevision: 1,
      createdBy: originalActorId,
      requestId: archiveRequestId,
      occurredAt: now,
    });
    const failedPublication = {
      id: `publish_${"5".repeat(32)}`,
      workspaceId,
      revision: 1,
      approvalId: withdrawalApprovalId,
      fingerprint: "failed-withdrawal-fingerprint",
      idempotencyKey: "archive-publication-key",
      requestedBy: originalActorId,
      requestedAt: now,
      status: "failed",
    };
    const retriedPublication = {
      ...failedPublication,
      requestedBy: actorId,
      status: "requested",
    };
    mocks.findPublicationByIdempotency.mockResolvedValue(
      failedPublication,
    );
    mocks.findApproval.mockResolvedValue({
      id: withdrawalApprovalId,
      workspaceId,
      revision: 1,
      fingerprint: {
        value: failedPublication.fingerprint,
        postArtifacts: [{
          postId,
          postRevisionId: selectedPostRevisionId,
        }],
      },
    });
    mocks.retryDeployment.mockResolvedValue(retriedPublication);
    const archiveRow = {
      selected_post_revision_id: selectedPostRevisionId,
      previous_live_revision_id: selectedPostRevisionId,
      withdrawal_workspace_id: workspaceId,
      withdrawal_content_revision: 1,
      collection_state: "archiving",
      archive_publication_id: null,
    };
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(
            query.includes("blog_post_operation_audit_events")
              ? null
              : query.includes("FROM content_revisions")
                ? {
                    workspace_id: workspaceId,
                    revision: 1,
                    definition_json: JSON.stringify({
                      blog: {
                        posts: [{
                          id: postId,
                          targetVisibility: "unpublished",
                        }],
                      },
                    }),
                    content_hash: "withdrawal-content",
                    schema_version: "foundry.site-definition.v1",
                    renderer_version: "renderer-v1",
                    production_base:
                      `git:${"a".repeat(40)}@content:${"b".repeat(64)}`,
                    created_at: now,
                    created_by: originalActorId,
                  }
                : archiveRow,
          ),
        })),
      })),
    };

    await expect(continueArchiveBlogPostWithdrawal({
      environment: { FOUNDRY_DB: database as never },
      actorId,
      postId,
      archiveRequestId,
      withdrawalApprovalId,
      requestId: "replacement-owner-continues-withdrawal",
    })).resolves.toMatchObject({
      archiveRequestId,
      publication: {
        id: failedPublication.id,
        status: "requested",
        requestedBy: actorId,
      },
    });

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.retryDeployment).toHaveBeenCalledWith(
      failedPublication.id,
      actorId,
    );
    await expect(
      archiveStore.findPost("site_foundry_reference", postId),
    ).resolves.toMatchObject({
      collectionState: "archiving",
      liveRevisionId: selectedPostRevisionId,
    });
  });
});

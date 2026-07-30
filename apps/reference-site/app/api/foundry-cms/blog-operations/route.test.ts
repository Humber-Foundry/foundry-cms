import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  verifyMutation: vi.fn(),
  executeMutation: vi.fn(),
  loadEnvironment: vi.fn(),
  loadApplication: vi.fn(),
  archive: vi.fn(),
  continueArchive: vi.fn(),
  recoverArchiveAccess: vi.fn(),
  restore: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/human-access-environment", () => ({
  loadHumanAccessEnvironment: mocks.loadEnvironment,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  executeIdempotentHumanMutation: mocks.executeMutation,
  verifyHumanMutation: mocks.verifyMutation,
  HumanMutationExecutionNotStartedError: class extends Error {},
  HumanMutationExecutionResumableError: class extends Error {
    override readonly cause: unknown;

    constructor(cause: unknown) {
      super("human_mutation_execution_resumable");
      this.cause = cause;
    }
  },
}));
vi.mock("../../../../src/blog-post-operations-runtime", () => ({
  archiveBlogPostWithWithdrawal: mocks.archive,
  continueArchiveBlogPostWithdrawal: mocks.continueArchive,
  loadBlogPostOperationsApplication: mocks.loadApplication,
  recoverArchiveBlogPostWithdrawalAccess: mocks.recoverArchiveAccess,
  restoreArchivedBlogPostAsDraft: mocks.restore,
  retryScheduledBlogPostExecution: mocks.retry,
}));

import { POST } from "./route";

describe("blog post operations endpoint", () => {
  const postId = "00000000-0000-4000-8000-000000000045";
  const identity = {
    identity: {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
      nonce: "nonce",
    },
  };
  const environment = { FOUNDRY_DB: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIdentity.mockResolvedValue(identity);
    mocks.authorize.mockResolvedValue({
      state: "authorized",
      membership: { id: "membership-editor" },
    });
    mocks.verifyMutation.mockResolvedValue(undefined);
    mocks.executeMutation.mockImplementation(
      async ({ execute }: { execute(): Promise<Response> }) => execute(),
    );
    mocks.loadEnvironment.mockResolvedValue(environment);
    mocks.loadApplication.mockResolvedValue({
      queries: {
        getExecution: vi.fn(),
        getSchedule: vi.fn(),
      },
      commands: {
        activateSchedule: vi.fn(),
        proposeSchedule: vi.fn(),
        cancelSchedule: vi.fn(),
        recordRejectedCommand: vi.fn(),
      },
    });
  });

  function request(body: unknown, key: string) {
    return new Request(
      "https://foundry.example/api/foundry-cms/blog-operations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      },
    );
  }

  it("continues an archive approval under a new mutation receipt", async () => {
    const approvalId = `approval_${"a".repeat(32)}`;
    mocks.continueArchive.mockResolvedValue({
      archiveRequestId: "archive-original-request",
      publication: { id: `publish_${"b".repeat(32)}` },
    });

    const response = await POST(
      request(
        {
          operation: "continue_archive_withdrawal",
          postId,
          archiveRequestId: "archive-original-request",
          withdrawalApprovalId: approvalId,
        },
        "archive-continuation-receipt",
      ),
    );

    expect(response.status).toBe(202);
    expect(mocks.continueArchive).toHaveBeenCalledWith({
      environment,
      actorId: "membership-editor",
      postId,
      archiveRequestId: "archive-original-request",
      withdrawalApprovalId: approvalId,
      requestId: "archive-continuation-receipt",
    });
    expect(mocks.executeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          operation: "continue_archive_withdrawal",
        }),
      }),
    );
  });

  it("recovers withdrawal workspace access before an approval exists", async () => {
    mocks.recoverArchiveAccess.mockResolvedValue({
      archiveRequestId: "archive-original-request",
      withdrawal: {
        workspaceId: "workspace_withdrawal",
        revision: 1,
        approvalRequired: true,
      },
    });

    const response = await POST(
      request(
        {
          operation: "recover_archive_withdrawal_access",
          postId,
          archiveRequestId: "archive-original-request",
        },
        "archive-recovery-access-receipt",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.recoverArchiveAccess).toHaveBeenCalledWith({
      environment,
      actorId: "membership-editor",
      postId,
      archiveRequestId: "archive-original-request",
      requestId: "archive-recovery-access-receipt",
    });
  });

  it("audits an unknown rejected blog command without trusting its name", async () => {
    const application = await mocks.loadApplication();
    mocks.loadApplication.mockResolvedValue(application);

    const response = await POST(
      request(
        {
          operation: "delete",
          postId,
        },
        "unknown-blog-command",
      ),
    );

    expect(response.status).toBe(400);
    expect(
      application.commands.recordRejectedCommand,
    ).toHaveBeenCalledWith({
      actorId: "membership-editor",
      siteId: "site_foundry_reference",
      postId,
      commandType: "blog.post.command.unknown",
      requestId: "unknown-blog-command",
      reasonCode: "blog_command_invalid",
    });
  });

  it("audits non-object and known malformed commands with canonical names", async () => {
    const application = await mocks.loadApplication();
    mocks.loadApplication.mockResolvedValue(application);

    await expect(POST(
      request("not-a-command", "malformed-blog-body"),
    )).resolves.toMatchObject({ status: 400 });
    await expect(POST(
      request(
        { operation: "activate_schedule", postId },
        "malformed-blog-activation",
      ),
    )).resolves.toMatchObject({ status: 400 });

    expect(
      application.commands.recordRejectedCommand,
    ).toHaveBeenNthCalledWith(1, {
      actorId: "membership-editor",
      siteId: "site_foundry_reference",
      postId: null,
      commandType: "blog.post.command.unknown",
      requestId: "malformed-blog-body",
      reasonCode: "blog_command_invalid",
    });
    expect(
      application.commands.recordRejectedCommand,
    ).toHaveBeenNthCalledWith(2, {
      actorId: "membership-editor",
      siteId: "site_foundry_reference",
      postId,
      commandType: "blog.post.schedule.activate",
      requestId: "malformed-blog-activation",
      reasonCode: "blog_command_invalid",
    });
  });

  it("routes explicit retry through execution advancement and exposes no lease", async () => {
    const application = await mocks.loadApplication();
    application.queries.getExecution.mockResolvedValue({
      executionId: "execution_retry",
      scheduleId: "schedule_retry",
    });
    application.queries.getSchedule.mockResolvedValue({
      id: "schedule_retry",
      postId,
    });
    mocks.loadApplication.mockResolvedValue(application);
    mocks.retry.mockResolvedValue({
      executionId: "execution_retry",
      scheduleId: "schedule_retry",
      state: "completed",
    });

    const response = await POST(
      request(
        {
          operation: "retry_execution",
          postId,
          executionId: "execution_retry",
        },
        "retry-execution-receipt",
      ),
    );

    expect(response.status).toBe(202);
    expect(mocks.retry).toHaveBeenCalledWith(
      environment,
      "site_foundry_reference",
      postId,
      "execution_retry",
      "membership-editor",
      "retry-execution-receipt",
    );
    expect(application.queries.getExecution).not.toHaveBeenCalled();
    expect(application.queries.getSchedule).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.execution).toMatchObject({ state: "completed" });
    expect(body.execution).not.toHaveProperty("leaseToken");
  });

  it("routes non-executable proposals and explicit human cancellation", async () => {
    const application = await mocks.loadApplication();
    const resolvedTime = {
      localDateTime: "2026-11-01T01:00:00",
      ianaTimeZone: "America/Vancouver",
      utcOffsetChoice: "-07:00",
      executeAtUtc: "2026-11-01T08:00:00.000Z",
    };
    application.commands.proposeSchedule.mockResolvedValue({
      id: "schedule_proposal_route",
    });
    application.commands.cancelSchedule.mockResolvedValue({
      id: "schedule_route",
      state: "cancelled",
      detail: "human_cancelled",
    });
    mocks.loadApplication.mockResolvedValue(application);

    const proposed = await POST(
      request(
        { operation: "propose_schedule", postId, resolvedTime },
        "route-propose-schedule",
      ),
    );
    const cancelled = await POST(
      request(
        {
          operation: "cancel_schedule",
          postId,
          scheduleId: "schedule_route",
        },
        "route-cancel-schedule",
      ),
    );

    expect(proposed.status).toBe(201);
    expect(cancelled.status).toBe(200);
    expect(application.commands.proposeSchedule).toHaveBeenCalledWith({
      actorId: "membership-editor",
      siteId: "site_foundry_reference",
      postId,
      resolvedTime,
      idempotencyKey: "route-propose-schedule",
    });
    expect(application.commands.cancelSchedule).toHaveBeenCalledWith({
      actorId: "membership-editor",
      siteId: "site_foundry_reference",
      postId,
      scheduleId: "schedule_route",
      idempotencyKey: "route-cancel-schedule",
    });
  });
});

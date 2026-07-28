import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContentApprovalInvalidError,
} from "@foundry/application";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  verifyMutation: vi.fn(),
  executeMutation: vi.fn(),
  loadApplication: vi.fn(),
  loadRestoreApplication: vi.fn(),
  loadQueries: vi.fn(),
  approve: vi.fn(),
  publish: vi.fn(),
  refresh: vi.fn(),
  retryDeployment: vi.fn(),
  restore: vi.fn(),
  getLatest: vi.fn(),
  get: vi.fn(),
  listHistory: vi.fn(),
  workspaceIdForMutation: vi.fn(),
  requireExistingAccess: vi.fn(),
}));

vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorize,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/human-mutation-runtime")
  >("../../../../src/human-mutation-runtime");
  return {
    ...actual,
    verifyHumanMutation: mocks.verifyMutation,
    executeIdempotentHumanMutation: mocks.executeMutation,
  };
});
vi.mock("../../../../src/content-publication-runtime", () => ({
  loadContentPublicationApplication: mocks.loadApplication,
  loadContentPublicationRestoreApplication: mocks.loadRestoreApplication,
  loadContentPublicationQueries: mocks.loadQueries,
}));
vi.mock("../../../../src/content-revision-runtime", () => ({
  requireExistingContentWorkspaceAccess: mocks.requireExistingAccess,
  contentWorkspaceIdForMutation: mocks.workspaceIdForMutation,
}));

import { GET, POST } from "./route";

describe("content publication endpoint", () => {
  const identityContext = {
    identity: {
      binding: { issuer: "issuer", subject: "subject" },
      email: "editor@example.com",
      nonce: "nonce",
    },
  };
  const access = {
    state: "authorized",
    identity: identityContext.identity,
    membership: {
      id: "membership-editor",
      role: "editor",
      status: "active",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIdentity.mockResolvedValue(identityContext);
    mocks.authorize.mockResolvedValue(access);
    mocks.verifyMutation.mockResolvedValue(undefined);
    mocks.executeMutation.mockImplementation(
      async ({ execute }: { execute(): Promise<Response> }) => execute(),
    );
    mocks.requireExistingAccess.mockResolvedValue(undefined);
    mocks.loadApplication.mockResolvedValue({
      commands: {
        approve: mocks.approve,
        publish: mocks.publish,
        refresh: mocks.refresh,
        retryDeployment: mocks.retryDeployment,
        restore: mocks.restore,
      },
      queries: {
        getLatest: mocks.getLatest,
        get: mocks.get,
        listHistory: mocks.listHistory,
      },
    });
    mocks.loadRestoreApplication.mockResolvedValue({
      commands: {
        approve: mocks.approve,
        publish: mocks.publish,
        refresh: mocks.refresh,
        retryDeployment: mocks.retryDeployment,
        restore: mocks.restore,
      },
      queries: {
        getLatest: mocks.getLatest,
        get: mocks.get,
        listHistory: mocks.listHistory,
      },
    });
    mocks.loadQueries.mockResolvedValue({
      getLatest: mocks.getLatest,
      get: mocks.get,
      listHistory: mocks.listHistory,
    });
    mocks.workspaceIdForMutation.mockResolvedValue("workspace_restored");
  });

  function request(body: unknown, key = "publication-route-0001") {
    return new Request(
      "https://foundry.example/api/foundry-cms/publications",
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

  it("creates exact approval only through the authenticated human mutation route", async () => {
    mocks.approve.mockResolvedValue({
      id: `approval_${"1".repeat(32)}`,
      fingerprint: { value: "a".repeat(64) },
    });
    const response = await POST(
      request({
        operation: "approve",
        workspaceId: "workspace_publish",
        revision: 3,
        previewConfirmed: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.verifyMutation).toHaveBeenCalled();
    expect(mocks.approve).toHaveBeenCalledWith({
      workspaceId: "workspace_publish",
      revision: 3,
      approvedBy: "membership-editor",
      previewConfirmed: true,
    });
    expect(response.headers.get("x-foundry-mutation-result")).toBe("recorded");
  });

  it("requires an explicit canonical-preview confirmation", async () => {
    const response = await POST(
      request({
        operation: "approve",
        workspaceId: "workspace_publish",
        revision: 3,
        previewConfirmed: false,
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("publishes only a validated approval with the same stable key", async () => {
    mocks.publish.mockResolvedValue({
      id: `publish_${"2".repeat(32)}`,
      status: "committed",
      commitSha: "c".repeat(40),
    });
    const response = await POST(
      request(
        {
          operation: "publish",
          workspaceId: "workspace_publish",
          approvalId: `approval_${"1".repeat(32)}`,
        },
        "publication-route-publish-1",
      ),
    );

    expect(response.status).toBe(202);
    expect(mocks.publish).toHaveBeenCalledWith({
      workspaceId: "workspace_publish",
      approvalId: `approval_${"1".repeat(32)}`,
      requestedBy: "membership-editor",
      idempotencyKey: "publication-route-publish-1",
    });
  });

  it("returns a stable conflict before side effects for stale approval", async () => {
    mocks.publish.mockRejectedValue(
      new ContentApprovalInvalidError("production_head_moved"),
    );
    const response = await POST(
      request({
        operation: "publish",
        workspaceId: "workspace_publish",
        approvalId: `approval_${"1".repeat(32)}`,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "production_head_moved",
    });
  });

  it("marks transient command failures resumable for the outer receipt", async () => {
    mocks.publish.mockRejectedValue(new Error("github_temporarily_unavailable"));
    mocks.executeMutation.mockImplementation(
      async ({ execute }: { execute(): Promise<Response> }) => {
        try {
          return await execute();
        } catch (error) {
          expect(error).toEqual(
            expect.objectContaining({
              name: "HumanMutationExecutionResumableError",
            }),
          );
          return Response.json({ error: "retryable" }, { status: 503 });
        }
      },
    );

    const response = await POST(
      request({
        operation: "publish",
        workspaceId: "workspace_publish",
        approvalId: `approval_${"1".repeat(32)}`,
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("reads explicit publication states without mutating from GET", async () => {
    mocks.get.mockResolvedValue({
      id: `publish_${"2".repeat(32)}`,
      workspaceId: "workspace_publish",
      status: "verified-live",
    });
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/publications" +
          `?workspaceId=workspace_publish&publicationId=publish_${"2".repeat(32)}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.get).toHaveBeenCalledWith(
      `publish_${"2".repeat(32)}`,
    );
    expect(mocks.loadApplication).not.toHaveBeenCalled();
    expect(mocks.loadQueries).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      publication: {
        id: `publish_${"2".repeat(32)}`,
        workspaceId: "workspace_publish",
        status: "verified-live",
      },
    });
  });

  it("lists published history and its release evidence for an active editor", async () => {
    const history = [
      {
        publication: {
          id: `publish_${"2".repeat(32)}`,
          status: "verified-live",
          commitSha: "c".repeat(40),
        },
        approval: {
          fingerprint: {
            contentHash: "d".repeat(64),
            artifactHash: "e".repeat(64),
          },
        },
        events: [{ status: "verified-live", occurredAt: "2026-07-27" }],
      },
    ];
    mocks.listHistory.mockResolvedValue(history);

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/publications?view=history",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listHistory).toHaveBeenCalledTimes(1);
    expect(mocks.requireExistingAccess).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ history });
  });

  it("restores a verified publication as a new draft through a stable mutation identity", async () => {
    const source = {
      id: `publish_${"2".repeat(32)}`,
      workspaceId: "workspace_publish",
      status: "verified-live",
      commitSha: "c".repeat(40),
    };
    mocks.restore.mockResolvedValue({
      workspaceId: "workspace_restored",
      revision: 0,
      sourcePublicationId: source.id,
    });

    const response = await POST(
      request(
        {
          operation: "restore",
          sourcePublicationId: source.id,
        },
        "publication-route-restore-1",
      ),
    );

    expect(response.status).toBe(201);
    expect(mocks.restore).toHaveBeenCalledWith({
      sourcePublicationId: source.id,
      restoredBy: "membership-editor",
      actorId: "membership-editor",
      workspaceId: "workspace_restored",
      idempotencyKey: "publication-route-restore-1",
    });
    expect(mocks.requireExistingAccess).not.toHaveBeenCalled();
    expect(mocks.loadRestoreApplication).toHaveBeenCalledWith(
      source.id,
      "membership-editor",
    );
    expect(mocks.loadApplication).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      draft: {
        workspaceId: "workspace_restored",
        revision: 0,
        sourcePublicationId: source.id,
      },
    });
  });

  it("refreshes durable status only through a protected POST mutation", async () => {
    const existing = {
      id: `publish_${"2".repeat(32)}`,
      workspaceId: "workspace_publish",
      status: "building",
    };
    mocks.get.mockResolvedValue(existing);
    mocks.refresh.mockResolvedValue({
      ...existing,
      status: "verified-live",
    });
    const response = await POST(
      request({
        operation: "refresh",
        workspaceId: "workspace_publish",
        publicationId: existing.id,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyMutation).toHaveBeenCalled();
    expect(mocks.requireExistingAccess).toHaveBeenCalledWith(
      "workspace_publish",
      "membership-editor",
    );
    expect(mocks.refresh).toHaveBeenCalledWith(existing.id);
  });

  it("retries deployment only through the protected human mutation route", async () => {
    const existing = {
      id: `publish_${"2".repeat(32)}`,
      workspaceId: "workspace_publish",
      status: "failed",
      commitSha: "c".repeat(40),
    };
    mocks.get.mockResolvedValue(existing);
    mocks.retryDeployment.mockResolvedValue({
      ...existing,
      status: "committed",
    });

    const response = await POST(
      request({
        operation: "retry_deployment",
        workspaceId: "workspace_publish",
        publicationId: existing.id,
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.verifyMutation).toHaveBeenCalled();
    expect(mocks.retryDeployment).toHaveBeenCalledWith(
      existing.id,
      "membership-editor",
    );
  });

  it("does not expose a workspace publication to an unauthorized actor", async () => {
    mocks.requireExistingAccess.mockRejectedValue(
      new (await import("@foundry/application")).ContentWorkspaceAccessError(),
    );
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/publications" +
          "?workspaceId=workspace_publish",
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "workspace_access_denied",
    });
  });
});

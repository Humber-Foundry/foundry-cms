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
  approve: vi.fn(),
  publish: vi.fn(),
  refresh: vi.fn(),
  getLatest: vi.fn(),
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
    mocks.loadApplication.mockResolvedValue({
      commands: {
        approve: mocks.approve,
        publish: mocks.publish,
        refresh: mocks.refresh,
      },
      queries: { getLatest: mocks.getLatest },
    });
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

  it("refreshes explicit publication states without caching", async () => {
    mocks.refresh.mockResolvedValue({
      id: `publish_${"2".repeat(32)}`,
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
    expect(mocks.refresh).toHaveBeenCalledWith(
      `publish_${"2".repeat(32)}`,
    );
    await expect(response.json()).resolves.toEqual({
      publication: {
        id: `publish_${"2".repeat(32)}`,
        status: "verified-live",
      },
    });
  });

  it("does not expose a workspace publication to an unauthorized actor", async () => {
    mocks.loadApplication.mockRejectedValue(
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

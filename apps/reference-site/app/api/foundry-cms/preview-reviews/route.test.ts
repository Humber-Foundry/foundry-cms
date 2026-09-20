import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccessDeniedError } from "@humber-foundry/application";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadIdentity: vi.fn(),
  verifyMutation: vi.fn(),
  executeMutation: vi.fn(),
  loadApplication: vi.fn(),
  approve: vi.fn(),
  requireCapability: vi.fn(),
  loadPreview: vi.fn(),
  record: vi.fn(),
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
vi.mock("../../../../src/mcp-preview-review-runtime", async () => {
  const limits = await vi.importActual<
    typeof import("../../../../src/mcp-preview-review-limits")
  >("../../../../src/mcp-preview-review-limits");
  return {
    ...limits,
    loadMcpPreviewForHuman: mocks.loadPreview,
    recordPreviewReviewDecision: mocks.record,
  };
});

import { GET, POST } from "./route";

const previewId = "preview_11111111-2222-3333-4444-555555555555";

function request(body: unknown) {
  return new Request("https://cms.example/api/foundry-cms/preview-reviews", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "11111111-2222-3333-4444-555555555555",
      "x-foundry-csrf": "token",
    },
    body: JSON.stringify(body),
  });
}

describe("preview review endpoint", () => {
  const identityContext = {
    identity: {
      binding: { issuer: "issuer", subject: "subject" },
      nonce: "nonce",
    },
  };
  const access = {
    state: "authorized",
    identity: identityContext.identity,
    membership: {
      id: "membership-editor",
      siteId: "site_foundry",
      role: "editor",
      status: "active",
    },
    application: { queries: { requireCapability: mocks.requireCapability } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIdentity.mockResolvedValue(identityContext);
    mocks.authorize.mockResolvedValue(access);
    mocks.verifyMutation.mockResolvedValue(undefined);
    mocks.requireCapability.mockResolvedValue(access.membership);
    // The real helper releases its receipt and rethrows the original cause
    // when the route reports that the command never started.
    mocks.executeMutation.mockImplementation(
      async ({ execute }: { execute(): Promise<Response> }) => {
        try {
          return await execute();
        } catch (error) {
          throw (error as { cause?: unknown }).cause ?? error;
        }
      },
    );
    mocks.loadApplication.mockResolvedValue({
      commands: { approve: mocks.approve },
    });
    mocks.approve.mockResolvedValue({ id: `approval_${"a".repeat(32)}` });
    mocks.record.mockResolvedValue(true);
    mocks.loadPreview.mockResolvedValue({
      revision: { workspaceId: "workspace_mcp_70", revision: 4 },
      review: { previewId, actorId: "agent-70", decided: null },
    });
  });

  it("records an approval bound to the exact revision the person previewed", async () => {
    const response = await POST(
      request({ operation: "approve", previewId, previewConfirmed: true }),
    );

    expect(response.status).toBe(201);
    expect(mocks.approve).toHaveBeenCalledWith({
      workspaceId: "workspace_mcp_70",
      revision: 4,
      approvedBy: "membership-editor",
      previewConfirmed: true,
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        previewId,
        decision: "approved",
        approvalId: `approval_${"a".repeat(32)}`,
        decidedBy: "membership-editor",
      }),
    );
    await expect(response.json()).resolves.toEqual({
      review: expect.objectContaining({
        decision: "approved",
        approvalId: `approval_${"a".repeat(32)}`,
      }),
    });
  });

  it("never approves from a GET", async () => {
    const response = await GET();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a request that carries no signed-in person", async () => {
    // An agent presents an MCP bearer token and no Cloudflare Access
    // assertion. The human identity check is what fails, so the approval
    // command is never reached.
    mocks.loadIdentity.mockRejectedValue(
      new AccessDeniedError("membership_not_found"),
    );

    const agentRequest = new Request(
      "https://cms.example/api/foundry-cms/preview-reviews",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer agent-access-token",
          "idempotency-key": "11111111-2222-3333-4444-555555555555",
        },
        body: JSON.stringify({
          operation: "approve",
          previewId,
          previewConfirmed: true,
        }),
      },
    );
    const response = await POST(agentRequest);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "request_check_failed",
    });
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses an approval without the person's mutation token", async () => {
    mocks.verifyMutation.mockRejectedValue(
      new AccessDeniedError("membership_not_found"),
    );

    const response = await POST(
      request({ operation: "approve", previewId, previewConfirmed: true }),
    );

    expect(response.status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("refuses an approval that does not confirm the preview", async () => {
    const response = await POST(
      request({ operation: "approve", previewId }),
    );

    expect(response.status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("refuses a decision when the draft changed after the preview", async () => {
    mocks.loadPreview.mockResolvedValue(null);

    const response = await POST(
      request({ operation: "approve", previewId, previewConfirmed: true }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "preview_not_current",
    });
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("records a change request with the reason, stripped of control characters", async () => {
    const response = await POST(
      request({
        operation: "request_changes",
        previewId,
        reason: "Use the shorter headline",
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "changes_requested",
        approvalId: null,
        reason: "Use the  shorter headline",
      }),
    );
  });

  it("refuses an empty reason", async () => {
    const response = await POST(
      request({ operation: "request_changes", previewId, reason: "   " }),
    );

    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers a preview that already carries a decision", async () => {
    mocks.loadPreview.mockResolvedValue({
      revision: { workspaceId: "workspace_mcp_70", revision: 4 },
      review: {
        previewId,
        actorId: "agent-70",
        decided: {
          decision: "approved",
          approvalId: `approval_${"a".repeat(32)}`,
          reason: null,
          decidedAt: "2026-09-18T10:00:00.000Z",
        },
      },
    });

    const response = await POST(
      request({ operation: "approve", previewId, previewConfirmed: true }),
    );

    expect(response.status).toBe(409);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("refuses a member whose role cannot approve content", async () => {
    mocks.requireCapability.mockRejectedValue(
      new AccessDeniedError("capability_not_authorized"),
    );

    const response = await POST(
      request({ operation: "approve", previewId, previewConfirmed: true }),
    );

    expect(response.status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});

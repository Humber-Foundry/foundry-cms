import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccessDeniedError,
  PublicFormPrivacyError,
} from "@humber-foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  authorizeIdentity: vi.fn(),
  createOperations: vi.fn(),
  createPrivacy: vi.fn(),
  eraseSubmission: vi.fn(),
  exportSubmission: vi.fn(),
  loadIdentity: vi.fn(),
  replayFailed: vi.fn(),
  verifyMutation: vi.fn(),
}));

const identity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "editor-nonce",
};

vi.mock("../../../../src/human-access-runtime", () => ({
  authorizeAuthenticatedHumanIdentity: mocks.authorizeIdentity,
  loadHumanIdentityRequestContext: mocks.loadIdentity,
}));
vi.mock("../../../../src/public-form-messages-runtime", () => ({
  createPublicFormOperationsContext: mocks.createOperations,
}));
vi.mock("../../../../src/public-form-privacy-dashboard-runtime", () => ({
  createPublicFormPrivacyContext: mocks.createPrivacy,
}));
vi.mock("../../../../src/human-mutation-runtime", () => {
  class ReleasableExecutionError extends Error {
    override readonly cause: unknown;
    constructor(cause: unknown) {
      super("releasable");
      this.cause = cause;
    }
  }
  return {
    executeIdempotentHumanMutation: async ({
      execute,
    }: {
      execute: () => Promise<Response>;
    }) => {
      try {
        return await execute();
      } catch (error) {
        if (error instanceof ReleasableExecutionError) throw error.cause;
        throw error;
      }
    },
    HumanMutationExecutionNotStartedError: ReleasableExecutionError,
    HumanMutationExecutionResumableError: ReleasableExecutionError,
    HumanMutationIdempotencyError: class extends Error {},
    verifyHumanMutation: mocks.verifyMutation,
  };
});

import { POST } from "./route";

describe("form operations endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.authorizeIdentity.mockResolvedValue({
      state: "authorized",
      identity,
    });
    mocks.createOperations.mockResolvedValue({
      commands: {
        replayFailed: mocks.replayFailed,
        releaseSuspectedSpam: vi.fn(),
      },
    });
    mocks.createPrivacy.mockResolvedValue({
      queries: { exportSubmission: mocks.exportSubmission },
      commands: {
        classifySubmission: vi.fn(),
        eraseSubmission: mocks.eraseSubmission,
      },
    });
    mocks.exportSubmission.mockResolvedValue({
      receiptId: "receipt-48",
      formId: "contact",
      classification: "accepted",
      acceptedAt: "2026-07-27T00:00:00.000Z",
      fields: { message: "private" },
    });
    mocks.verifyMutation.mockResolvedValue(undefined);
  });

  it("records authorization failures inside the idempotent execution", async () => {
    mocks.replayFailed.mockRejectedValue(
      new AccessDeniedError("capability_not_authorized"),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "replay_delivery",
          deliveryId: "delivery-47",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-foundry-mutation-result")).toBe("recorded");
    await expect(response.json()).resolves.toEqual({
      error: "not_authorized",
    });
  });

  it("routes owner erasure through the idempotent privacy application", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "erase_submission",
          receiptId: "receipt-48",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.eraseSubmission).toHaveBeenCalledWith({
      actor: identity,
      receiptId: "receipt-48",
    });
  });

  it("returns an audited private export as a non-cacheable attachment", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "export_submission",
          receiptId: "receipt-48",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain(
      "form-receipt-48.json",
    );
    expect(mocks.exportSubmission).toHaveBeenCalledWith({
      actor: identity,
      receiptId: "receipt-48",
    });
    expect(mocks.verifyMutation).toHaveBeenCalled();
  });

});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccessDeniedError } from "@foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  authorizeIdentity: vi.fn(),
  createOperations: vi.fn(),
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
vi.mock("../../../../src/public-form-delivery-health-runtime", () => ({
  createPublicFormOperationsContext: mocks.createOperations,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  executeIdempotentHumanMutation: async ({
    execute,
  }: {
    execute: () => Promise<Response>;
  }) => execute(),
  HumanMutationExecutionNotStartedError: class extends Error {
    override readonly cause: unknown;
    constructor(cause: unknown) {
      super("not_started");
      this.cause = cause;
    }
  },
  HumanMutationIdempotencyError: class extends Error {},
  verifyHumanMutation: mocks.verifyMutation,
}));

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
});

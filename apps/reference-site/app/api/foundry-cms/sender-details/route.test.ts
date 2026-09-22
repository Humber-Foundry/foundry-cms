import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccessDeniedError } from "@humber-foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadIdentity: vi.fn(),
  authorizeIdentity: vi.fn(),
  verifyMutation: vi.fn(),
  requireCapability: vi.fn(),
  saveSenderDetails: vi.fn(),
}));

const identity = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.com",
  nonce: "owner-nonce",
};

vi.mock("../../../../src/human-access-runtime", () => ({
  loadHumanIdentityRequestContext: mocks.loadIdentity,
  authorizeAuthenticatedHumanIdentity: mocks.authorizeIdentity,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  verifyHumanMutation: mocks.verifyMutation,
}));
vi.mock("../../../../src/sender-details-runtime", () => ({
  saveSenderDetails: mocks.saveSenderDetails,
}));

import { POST } from "./route";

const fullDetails = {
  legalName: "Example Society",
  postalAddress: "10 Main Street",
  contactUrl: "https://example.org/contact",
  unsubscribeUrl: "https://example.org/newsletter/unsubscribe",
  senderIdentityId: "sender_primary",
};

function request(body: unknown) {
  return new Request("https://example.org/api/foundry-cms/sender-details", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sender details endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadIdentity.mockResolvedValue({ identity });
    mocks.verifyMutation.mockResolvedValue(undefined);
    mocks.authorizeIdentity.mockResolvedValue({
      identity,
      application: { queries: { requireCapability: mocks.requireCapability } },
    });
    mocks.requireCapability.mockResolvedValue({ id: "membership-owner" });
    mocks.saveSenderDetails.mockResolvedValue([]);
  });

  it("saves all five values for an Owner", async () => {
    const response = await POST(request(fullDetails));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
    expect(mocks.requireCapability).toHaveBeenCalledWith({
      actor: identity,
      capability: "access.manage",
    });
    expect(mocks.saveSenderDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        details: fullDetails,
        savedBy: "membership-owner",
      }),
    );
  });

  it("refuses anyone who does not hold the owner-only capability", async () => {
    mocks.requireCapability.mockRejectedValue(
      new AccessDeniedError("capability_not_authorized"),
    );

    const response = await POST(request(fullDetails));

    expect(response.status).toBe(403);
    expect(mocks.saveSenderDetails).not.toHaveBeenCalled();
  });

  it("returns the values the owner must fix, and saves nothing", async () => {
    mocks.saveSenderDetails.mockResolvedValue([
      { field: "legalName", message: "Add the name that appears at the bottom of every email." },
    ]);

    const response = await POST(request({ ...fullDetails, legalName: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "sender_details_invalid",
      problems: [
        {
          field: "legalName",
          message: "Add the name that appears at the bottom of every email.",
        },
      ],
    });
  });

  it("refuses a body that is not an object", async () => {
    const response = await POST(request("nonsense"));

    expect(response.status).toBe(400);
    expect(mocks.saveSenderDetails).not.toHaveBeenCalled();
  });
});

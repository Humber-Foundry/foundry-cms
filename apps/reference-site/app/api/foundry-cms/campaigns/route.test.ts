import { beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignValidationError } from "@foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadContext: vi.fn(),
  listCampaigns: vi.fn(),
  render: vi.fn(),
  createStandalone: vi.fn(),
  createFromPost: vi.fn(),
  edit: vi.fn(),
  recordRejectedCommand: vi.fn(),
  verifyMutation: vi.fn(),
}));
const identity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "nonce",
};
const application = {
  queries: {
    listCampaigns: mocks.listCampaigns,
    render: mocks.render,
  },
  commands: {
    createStandalone: mocks.createStandalone,
    createFromPost: mocks.createFromPost,
    edit: mocks.edit,
    recordRejectedCommand: mocks.recordRejectedCommand,
  },
};

vi.mock("../../../../src/campaign-runtime", () => ({
  loadCampaignRequestContext: mocks.loadContext,
}));
vi.mock("../../../../src/human-mutation-runtime", () => ({
  verifyHumanMutation: mocks.verifyMutation,
  executeIdempotentHumanMutation: async ({
    execute,
  }: {
    execute: () => Promise<Response>;
  }) => execute(),
}));

import { GET, POST } from "./route";

describe("campaign endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadContext.mockResolvedValue({ identity, application });
    mocks.createStandalone.mockResolvedValue({
      campaign: { id: "20000000-0000-4000-8000-000000000001" },
    });
  });

  it("lists durable campaigns for the dashboard", async () => {
    mocks.listCampaigns.mockResolvedValue([]);
    const response = await GET(
      new Request("https://foundry.example/api/foundry-cms/campaigns"),
    );
    expect(response.status).toBe(200);
    expect(mocks.listCampaigns).toHaveBeenCalledWith({ actor: identity });
  });

  it("reports renderer drift explicitly instead of serving mislabeled artifacts", async () => {
    mocks.render.mockRejectedValueOnce(
      new CampaignValidationError("campaign_renderer_mismatch"),
    );
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/campaigns" +
          "?campaignId=20000000-0000-4000-8000-000000000001",
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "campaign_renderer_mismatch",
    });
  });

  it("does not accept sender or compliance configuration from the caller", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-create-1",
        },
        body: JSON.stringify({
          action: "create_standalone",
          input: {
            subject: "Campaign",
            previewText: "Preview",
            callToAction: { label: "Read", href: "https://example.com" },
            emailContent: { version: "1.0.0", type: "document", children: [] },
            senderIdentityId: "attacker-controlled-sender",
            complianceFooter: {
              version: "attacker",
              content: "No unsubscribe",
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.createStandalone).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-create-1",
      input: {
        subject: "Campaign",
        previewText: "Preview",
        callToAction: { label: "Read", href: "https://example.com" },
        emailContent: { version: "1.0.0", type: "document", children: [] },
      },
    });
  });

  it("returns the shared application replay instead of running a transport receipt", async () => {
    mocks.createStandalone.mockResolvedValueOnce({
      campaign: { id: "20000000-0000-4000-8000-000000000001" },
      replayed: true,
    });
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-create-replay-1",
        },
        body: JSON.stringify({
          action: "create_standalone",
          input: {
            subject: "Campaign",
            previewText: "Preview",
            callToAction: { label: "Read", href: "https://example.com" },
            emailContent: {
              version: "1.0.0",
              type: "document",
              children: [],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ replayed: true });
  });

  it("audits malformed authenticated commands", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-invalid-command-1",
        },
        body: JSON.stringify({ action: "unknown" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-invalid-command-1",
      reason: "campaign_command_invalid",
    });
  });

  it("audits malformed campaign identifiers before returning a rejection", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-invalid-id-1",
        },
        body: JSON.stringify({
          action: "edit",
          campaignId: "not-a-campaign-id",
          expectedVersion: 1,
          input: {},
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-invalid-id-1",
      action: "campaign.edit",
      targetId: "not-a-campaign-id",
      reason: "campaign_id_invalid",
    });
    expect(mocks.edit).not.toHaveBeenCalled();
  });
});

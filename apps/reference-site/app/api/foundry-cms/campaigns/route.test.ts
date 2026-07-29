import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CampaignValidationError,
} from "@foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadContext: vi.fn(),
  listCampaigns: vi.fn(),
  render: vi.fn(),
  currentEvidence: vi.fn(),
  requestTest: vi.fn(),
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
const testDelivery = {
  queries: { currentEvidence: mocks.currentEvidence },
  commands: { requestTest: mocks.requestTest },
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
    mocks.loadContext.mockResolvedValue({
      identity,
      application,
      testDelivery,
    });
    mocks.createStandalone.mockResolvedValue({
      campaign: { id: "20000000-0000-4000-8000-000000000001" },
    });
    mocks.currentEvidence.mockResolvedValue(null);
    mocks.requestTest.mockResolvedValue({
      executionId: "40000000-0000-4000-8000-000000000001",
      state: "pending",
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

  it("requests a provider test only for configured recipient identities", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-1",
        },
        body: JSON.stringify({
          action: "request_test",
          campaignId: "20000000-0000-4000-8000-000000000001",
          testRecipientIds: ["owner-primary"],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.requestTest).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-test-1",
      campaignId: "20000000-0000-4000-8000-000000000001",
      testRecipientIds: ["owner-primary"],
    });
  });

  it("returns the stable shared rate-limit reason", async () => {
    mocks.requestTest.mockRejectedValueOnce(
      new CampaignValidationError("test_delivery_rate_limited"),
    );
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-rate-limited-1",
        },
        body: JSON.stringify({
          action: "request_test",
          campaignId: "20000000-0000-4000-8000-000000000001",
          testRecipientIds: ["owner-primary"],
        }),
      }),
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "test_delivery_rate_limited",
    });
  });

  it("rejects forbidden recipient fields instead of silently ignoring them", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-forbidden-recipient-1",
        },
        body: JSON.stringify({
          action: "request_test",
          campaignId: "20000000-0000-4000-8000-000000000001",
          testRecipientIds: ["owner-primary"],
          emailTo: ["attacker@example.test"],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.requestTest).not.toHaveBeenCalled();
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-test-forbidden-recipient-1",
      reason: "campaign_command_invalid",
      command: {
        action: "request_test",
        campaignId: "20000000-0000-4000-8000-000000000001",
        testRecipientIds: ["owner-primary"],
        emailTo: ["attacker@example.test"],
      },
      action: "campaign.test",
      commandName: "campaign.request_test",
      targetId: "20000000-0000-4000-8000-000000000001",
      beforeState: JSON.stringify({
        current: { commandEnvelope: "invalid" },
        required: { commandEnvelope: "valid_request_test" },
      }),
    });
  });

  it("audits malformed test envelopes as test commands with required state", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-malformed-envelope-1",
        },
        body: JSON.stringify({
          action: "request_test",
          campaignId: "20000000-0000-4000-8000-000000000001",
          testRecipientIds: "owner-primary",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-test-malformed-envelope-1",
      reason: "campaign_command_invalid",
      command: {
        action: "request_test",
        campaignId: "20000000-0000-4000-8000-000000000001",
        testRecipientIds: "owner-primary",
      },
      action: "campaign.test",
      commandName: "campaign.request_test",
      targetId: "20000000-0000-4000-8000-000000000001",
      beforeState: JSON.stringify({
        current: { commandEnvelope: "invalid" },
        required: { commandEnvelope: "valid_request_test" },
      }),
    });
  });

  it("reports a missing shared request key as an invalid command", async () => {
    const request = new Request(
      "https://foundry.example/api/foundry-cms/campaigns",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      requestId: "",
      reason: "campaign_idempotency_key_invalid",
      command: { kind: "campaign_request_envelope" },
    });
    await expect(response.json()).resolves.toEqual({
      error: "campaign_idempotency_key_invalid",
    });
  });

  it("rejects a declared oversized command before consuming its body", async () => {
    const request = new Request(
      "https://foundry.example/api/foundry-cms/campaigns",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(256 * 1024 + 1),
          "idempotency-key": "campaign-too-large-1",
        },
        body: "{}",
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-too-large-1",
      reason: "campaign_command_too_large",
      command: { kind: "campaign_command_too_large" },
    });
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
      command: { action: "unknown" },
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
      beforeState: JSON.stringify({
        current: { campaignId: "invalid" },
        required: { campaignId: "valid_uuid" },
      }),
      command: {
        action: "edit",
        campaignId: "not-a-campaign-id",
        expectedVersion: 1,
        input: {},
      },
      commandName: "campaign.edit",
    });
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("classifies a malformed test campaign identifier as a test rejection", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-invalid-id-1",
        },
        body: JSON.stringify({
          action: "request_test",
          campaignId: "not-a-campaign-id",
          testRecipientIds: ["owner-primary"],
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "campaign_id_invalid",
    });
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-test-invalid-id-1",
      action: "campaign.test",
      targetId: "not-a-campaign-id",
      reason: "campaign_id_invalid",
      beforeState: JSON.stringify({
        current: { campaignId: "invalid" },
        required: { campaignId: "valid_uuid" },
      }),
      command: {
        action: "request_test",
        campaignId: "not-a-campaign-id",
        testRecipientIds: ["owner-primary"],
      },
      commandName: "campaign.request_test",
    });
    expect(mocks.requestTest).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccessDeniedError,
  CampaignBulkDeliveryError,
  CampaignValidationError,
} from "@humber-foundry/application";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  loadContext: vi.fn(),
  listCampaigns: vi.fn(),
  render: vi.fn(),
  currentEvidence: vi.fn(),
  readiness: vi.fn(),
  requestTest: vi.fn(),
  confirmReceipt: vi.fn(),
  authorizeBulk: vi.fn(),
  activateBulkSchedule: vi.fn(),
  cancelBulkSchedule: vi.fn(),
  sendBulkNow: vi.fn(),
  retryBulkSend: vi.fn(),
  executeBulk: vi.fn(),
  createStandalone: vi.fn(),
  createFromPost: vi.fn(),
  edit: vi.fn(),
  recordRejectedCommand: vi.fn(),
  verifyMutation: vi.fn(),
  readDeliveryReadiness: vi.fn(),
  readDeliveryHealth: vi.fn(),
  campaignBulkState: vi.fn(),
  listTestRecipients: vi.fn(),
}));
const connectedDelivery = {
  state: "connected",
  missingSettings: [],
  providerHealth: null,
  setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
};
const notConfiguredDelivery = {
  state: "not_configured",
  missingSettings: [
    "FOUNDRY_BREVO_API_KEY",
    "FOUNDRY_BREVO_SENDERS_JSON",
  ],
  providerHealth: null,
  setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
};
const connectedSenderDetails = {
  state: "connected",
  missingSettings: [],
  setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
};
const notConfiguredSenderDetails = {
  state: "not_configured",
  missingSettings: [
    "FOUNDRY_CAMPAIGN_LEGAL_NAME",
    "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
  ],
  setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
};
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
  queries: {
    currentEvidence: mocks.currentEvidence,
    readiness: mocks.readiness,
  },
  commands: {
    requestTest: mocks.requestTest,
    confirmReceipt: mocks.confirmReceipt,
  },
};
const bulkDelivery = {
  commands: {
    authorize: mocks.authorizeBulk,
    activateSchedule: mocks.activateBulkSchedule,
    cancelSchedule: mocks.cancelBulkSchedule,
    sendNow: mocks.sendBulkNow,
    retrySend: mocks.retryBulkSend,
  },
  queries: {
    campaignState: mocks.campaignBulkState,
  },
  scheduler: {
    execute: mocks.executeBulk,
  },
};

vi.mock("../../../../src/campaign-runtime", () => ({
  loadCampaignRequestContext: mocks.loadContext,
  readCampaignDeliveryReadiness: mocks.readDeliveryReadiness,
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
      bulkDelivery,
      delivery: connectedDelivery,
      senderDetails: connectedSenderDetails,
      readDeliveryHealth: mocks.readDeliveryHealth,
      listTestRecipients: mocks.listTestRecipients,
    });
    mocks.readDeliveryReadiness.mockResolvedValue({
      ...connectedDelivery,
      providerHealth: {
        state: "healthy",
        credential: "verified",
        senderIdentity: "verified",
      },
    });
    mocks.createStandalone.mockResolvedValue({
      campaign: { id: "20000000-0000-4000-8000-000000000001" },
    });
    mocks.currentEvidence.mockResolvedValue(null);
    mocks.campaignBulkState.mockResolvedValue({
      authorization: null,
      schedule: null,
      sendOperation: null,
    });
    mocks.listTestRecipients.mockResolvedValue({
      ids: ["membership-owner"],
      yours: null,
    });
    mocks.readiness.mockResolvedValue({
      state: "evaluation_only",
      testDeliveryReady: false,
    });
    mocks.requestTest.mockResolvedValue({
      executionId: "40000000-0000-4000-8000-000000000001",
      state: "pending",
    });
    mocks.confirmReceipt.mockResolvedValue({
      executionId: "40000000-0000-4000-8000-000000000001",
      ownerActorId: "membership-owner",
    });
    mocks.authorizeBulk.mockResolvedValue({
      authorization: {
        id: "50000000-0000-4000-8000-000000000001",
      },
      replayed: false,
    });
    mocks.sendBulkNow.mockResolvedValue({
      operation: {
        id: "60000000-0000-4000-8000-000000000001",
        state: "preparing",
      },
      replayed: false,
    });
    mocks.executeBulk.mockResolvedValue({
      id: "60000000-0000-4000-8000-000000000001",
      state: "provider_queued",
    });
    mocks.retryBulkSend.mockResolvedValue({
      id: "60000000-0000-4000-8000-000000000001",
      state: "provider_queued",
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

  it("reports one campaign's send state and its verified test recipients", async () => {
    mocks.render.mockResolvedValue({
      campaignId: "20000000-0000-4000-8000-000000000001",
      campaignFingerprint: "fingerprint-one",
    });
    mocks.currentEvidence.mockResolvedValue({
      executionId: "40000000-0000-4000-8000-000000000001",
      campaignFingerprint: "fingerprint-one",
    });
    mocks.readiness.mockResolvedValue({
      state: "ready",
      testDeliveryReady: true,
    });
    mocks.campaignBulkState.mockResolvedValue({
      authorization: {
        id: "50000000-0000-4000-8000-000000000001",
        campaignFingerprint: "fingerprint-one",
        testExecutionId: "40000000-0000-4000-8000-000000000001",
        state: "active",
        authorizedAt: "2026-09-01T02:00:00.000Z",
      },
      schedule: null,
      sendOperation: null,
    });
    mocks.listTestRecipients.mockResolvedValue({
      ids: ["membership-owner"],
      yours: "membership-owner",
    });

    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/campaigns" +
          "?campaignId=20000000-0000-4000-8000-000000000001",
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.bulkState.authorization).toMatchObject({ state: "active" });
    // Membership ids only. A test address is a person's own mailbox and never
    // leaves the server.
    expect(body.testRecipients).toEqual({
      ids: ["membership-owner"],
      yours: "membership-owner",
    });
    expect(JSON.stringify(body)).not.toContain("@");
    expect(mocks.campaignBulkState).toHaveBeenCalledWith({
      actor: identity,
      campaignId: "20000000-0000-4000-8000-000000000001",
    });
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
        // A caller that sends no header or share image gets none, not an
        // absent field.
        headerImage: null,
        shareImage: null,
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

  it("persists Owner receipt confirmation for an accepted execution", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-confirm-1",
        },
        body: JSON.stringify({
          action: "confirm_test_receipt",
          executionId: "40000000-0000-4000-8000-000000000001",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.confirmReceipt).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-test-confirm-1",
      executionId: "40000000-0000-4000-8000-000000000001",
    });
  });

  it("routes exact test evidence into Owner bulk authorization", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-bulk-authorize-1",
        },
        body: JSON.stringify({
          action: "authorize_bulk",
          campaignId: "20000000-0000-4000-8000-000000000001",
          testExecutionId: "40000000-0000-4000-8000-000000000001",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.authorizeBulk).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-bulk-authorize-1",
      campaignId: "20000000-0000-4000-8000-000000000001",
      testExecutionId: "40000000-0000-4000-8000-000000000001",
    });
  });

  it("routes an Owner retry to the same send operation", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-bulk-retry-1",
        },
        body: JSON.stringify({
          action: "retry_bulk_send",
          campaignId: "20000000-0000-4000-8000-000000000001",
          operationId: "60000000-0000-4000-8000-000000000001",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.retryBulkSend).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-bulk-retry-1",
      campaignId: "20000000-0000-4000-8000-000000000001",
      operationId: "60000000-0000-4000-8000-000000000001",
    });
    // A retry never opens a second send: it goes through the same command.
    expect(mocks.sendBulkNow).not.toHaveBeenCalled();
  });

  it("tells a non-Owner that bulk authority is what it lacks", async () => {
    mocks.authorizeBulk.mockRejectedValue(
      new AccessDeniedError("capability_not_authorized"),
    );

    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-bulk-editor-attempt-1",
        },
        body: JSON.stringify({
          action: "authorize_bulk",
          campaignId: "20000000-0000-4000-8000-000000000001",
          testExecutionId: "40000000-0000-4000-8000-000000000001",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "bulk_owner_required",
    });
  });

  it("separates a moved-state bulk conflict from an unmet prerequisite", async () => {
    for (const [code, status] of [
      ["bulk_authorization_stale", 409],
      ["bulk_suppression_changed", 409],
      ["bulk_send_already_exists", 409],
      ["bulk_test_stale", 409],
      ["bulk_schedule_not_cancellable", 409],
      ["bulk_execution_lease_lost", 409],
      ["bulk_test_required", 400],
      ["bulk_test_not_reviewed", 400],
      ["bulk_audience_empty", 400],
    ] as const) {
      mocks.authorizeBulk.mockRejectedValue(
        new CampaignBulkDeliveryError(code),
      );
      const response = await POST(
        new Request("https://foundry.example/api/foundry-cms/campaigns", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `campaign-bulk-status-${code}`,
          },
          body: JSON.stringify({
            action: "authorize_bulk",
            campaignId: "20000000-0000-4000-8000-000000000001",
            testExecutionId: "40000000-0000-4000-8000-000000000001",
          }),
        }),
      );

      expect({ code, status: response.status }).toEqual({ code, status });
      await expect(response.json()).resolves.toEqual({ error: code });
    }
  });

  it("advances Owner send-now through the shared stable executor", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-bulk-send-now-1",
        },
        body: JSON.stringify({
          action: "send_bulk_now",
          campaignId: "20000000-0000-4000-8000-000000000001",
          authorizationId: "50000000-0000-4000-8000-000000000001",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.sendBulkNow).toHaveBeenCalledWith({
      actor: identity,
      requestId: "campaign-bulk-send-now-1",
      campaignId: "20000000-0000-4000-8000-000000000001",
      authorizationId: "50000000-0000-4000-8000-000000000001",
    });
    expect(mocks.executeBulk).toHaveBeenCalledWith(
      "60000000-0000-4000-8000-000000000001",
    );
    await expect(response.json()).resolves.toMatchObject({
      operation: { state: "provider_queued" },
    });
  });

  it("classifies malformed receipt confirmation as a test command rejection", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-confirm-malformed-1",
        },
        body: JSON.stringify({
          action: "confirm_test_receipt",
          executionId: "40000000-0000-4000-8000-000000000001",
          ownerConfirmed: true,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "campaign-test-confirm-malformed-1",
        action: "campaign.test",
        commandName: "campaign.confirm_test_receipt",
        targetId: "40000000-0000-4000-8000-000000000001",
      }),
    );
    expect(mocks.confirmReceipt).not.toHaveBeenCalled();
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

  it("returns the stable Owner-recipient confirmation reason", async () => {
    mocks.confirmReceipt.mockRejectedValueOnce(
      new CampaignValidationError(
        "test_confirmation_owner_not_recipient",
      ),
    );
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "campaign-test-confirm-owner-mismatch-1",
        },
        body: JSON.stringify({
          action: "confirm_test_receipt",
          executionId: "40000000-0000-4000-8000-000000000001",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "test_confirmation_owner_not_recipient",
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

describe("campaign delivery readiness", () => {
  function post(action: Record<string, unknown>, key: string) {
    return POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(action),
      }),
    );
  }

  const campaignId = "20000000-0000-4000-8000-000000000001";

  it("reports delivery readiness on request", async () => {
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/campaigns?readiness=delivery",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      delivery: {
        state: "connected",
        missingSettings: [],
        providerHealth: {
          state: "healthy",
          credential: "verified",
          senderIdentity: "verified",
        },
        setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
      },
      senderDetails: connectedSenderDetails,
    });
    expect(mocks.listCampaigns).not.toHaveBeenCalled();
  });

  it("names the missing settings without any value when not configured", async () => {
    mocks.readDeliveryReadiness.mockResolvedValue(notConfiguredDelivery);
    const response = await GET(
      new Request(
        "https://foundry.example/api/foundry-cms/campaigns?readiness=delivery",
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.delivery.state).toBe("not_configured");
    expect(body.delivery.missingSettings).toEqual([
      "FOUNDRY_BREVO_API_KEY",
      "FOUNDRY_BREVO_SENDERS_JSON",
    ]);
    for (const name of body.delivery.missingSettings) {
      expect(name).toMatch(/^FOUNDRY_[A-Z0-9_]+$/u);
    }
  });

  it("still lists campaigns while delivery is not configured", async () => {
    mocks.loadContext.mockResolvedValue({
      identity,
      application,
      testDelivery,
      bulkDelivery,
      delivery: notConfiguredDelivery,
      senderDetails: connectedSenderDetails,
      readDeliveryHealth: mocks.readDeliveryHealth,
      listTestRecipients: mocks.listTestRecipients,
    });
    mocks.listCampaigns.mockResolvedValue([]);
    const response = await GET(
      new Request("https://foundry.example/api/foundry-cms/campaigns"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ campaigns: [] });
  });

  describe("while the sender details are not configured", () => {
    beforeEach(() => {
      mocks.loadContext.mockResolvedValue({
        identity,
        application,
        testDelivery,
        bulkDelivery,
        delivery: connectedDelivery,
        senderDetails: notConfiguredSenderDetails,
        readDeliveryHealth: mocks.readDeliveryHealth,
        listTestRecipients: mocks.listTestRecipients,
      });
    });

    it("reports the missing settings under their own heading", async () => {
      const response = await GET(
        new Request(
          "https://foundry.example/api/foundry-cms/campaigns?readiness=delivery",
        ),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.senderDetails.state).toBe("not_configured");
      expect(body.senderDetails.missingSettings).toEqual([
        "FOUNDRY_CAMPAIGN_LEGAL_NAME",
        "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
      ]);
      // The two headings stay apart: a sender setting never appears in the
      // delivery list and the other way round.
      for (const name of body.senderDetails.missingSettings) {
        expect(body.delivery.missingSettings).not.toContain(name);
        expect(name).toMatch(/^FOUNDRY_[A-Z0-9_]+$/u);
      }
    });

    it("still lists the campaigns that are already stored", async () => {
      mocks.listCampaigns.mockResolvedValue([]);
      const response = await GET(
        new Request("https://foundry.example/api/foundry-cms/campaigns"),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ campaigns: [] });
    });

    it("refuses to create a campaign, with the named reason", async () => {
      const response = await post(
        {
          action: "create_standalone",
          input: {
            subject: "Spring news",
            previewText: "What happened this spring",
            callToAction: { label: "Read", href: "https://example.com" },
            emailContent: { version: "1.0.0", type: "document", children: [] },
          },
        },
        "campaign-create-without-footer-1",
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "campaign_sender_details_not_configured",
      });
      expect(mocks.createStandalone).not.toHaveBeenCalled();
    });

    it.each([
      ["edit", { action: "edit", campaignId, expectedVersion: 1, input: { subject: "Changed", previewText: "Changed", callToAction: { label: "Read", href: "https://example.com" }, emailContent: { version: "1.0.0", type: "document", children: [] } } }],
      ["create_from_post", { action: "create_from_post", sourcePostRevisionId: "10000000-0000-8000-8000-000000000001" }],
      ["request_test", { action: "request_test", campaignId, testRecipientIds: ["owner-primary"] }],
      ["confirm_test_receipt", { action: "confirm_test_receipt", executionId: "40000000-0000-4000-8000-000000000001" }],
      ["authorize_bulk", { action: "authorize_bulk", campaignId, testExecutionId: "40000000-0000-4000-8000-000000000001" }],
      ["send_bulk_now", { action: "send_bulk_now", campaignId, authorizationId: "50000000-0000-4000-8000-000000000001" }],
      ["retry_bulk_send", { action: "retry_bulk_send", campaignId, operationId: "60000000-0000-4000-8000-000000000001" }],
    ])("refuses %s with the same reason", async (name, body) => {
      const response = await post(body, `campaign-no-footer-${name}-1`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "campaign_sender_details_not_configured",
      });
    });

    it("refuses an action that is not on the allowed list", async () => {
      // The gate is an allowlist, so an action absent from it is refused
      // rather than permitted by omission.
      const response = await post(
        {
          action: "activate_bulk_schedule",
          campaignId,
          authorizationId: "50000000-0000-4000-8000-000000000001",
          resolvedTime: {
            localDateTime: "2026-01-01T09:00",
            ianaTimeZone: "America/Vancouver",
            utcOffsetChoice: "-08:00",
            executeAtUtc: "2026-01-01T17:00:00.000Z",
            timeZoneDatabaseVersion: "2026a",
          },
        },
        "campaign-no-footer-activate-1",
      );
      expect(response.status).toBe(503);
      expect(mocks.activateBulkSchedule).not.toHaveBeenCalled();
    });

    it("still lets an Owner cancel a scheduled send", async () => {
      mocks.cancelBulkSchedule.mockResolvedValue({
        schedule: { id: "70000000-0000-4000-8000-000000000001" },
        replayed: false,
      });
      const response = await post(
        {
          action: "cancel_bulk_schedule",
          scheduleId: "70000000-0000-4000-8000-000000000001",
        },
        "campaign-cancel-without-footer-1",
      );
      expect(response.status).toBe(201);
      expect(mocks.cancelBulkSchedule).toHaveBeenCalled();
    });

    it("reports one reason when neither the secrets nor the settings are set", async () => {
      // A new installation has neither, and both answers would be true. The
      // sender settings are checked first so the whole product — this API, the
      // MCP runtime and the scheduled worker — reports one word.
      mocks.loadContext.mockResolvedValue({
        identity,
        application,
        testDelivery,
        bulkDelivery,
        delivery: notConfiguredDelivery,
        senderDetails: notConfiguredSenderDetails,
        readDeliveryHealth: mocks.readDeliveryHealth,
        listTestRecipients: mocks.listTestRecipients,
      });
      const response = await post(
        {
          action: "request_test",
          campaignId,
          testRecipientIds: ["owner-primary"],
        },
        "campaign-new-installation-reason-1",
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "campaign_sender_details_not_configured",
      });
    });
  });

  describe("while delivery is not configured", () => {
    beforeEach(() => {
      mocks.loadContext.mockResolvedValue({
        identity,
        application,
        testDelivery,
        bulkDelivery,
        delivery: notConfiguredDelivery,
        senderDetails: connectedSenderDetails,
        readDeliveryHealth: mocks.readDeliveryHealth,
      });
    });

    it("keeps composing and saving a campaign working", async () => {
      const response = await post(
        {
          action: "create_standalone",
          input: {
            subject: "Spring news",
            previewText: "What happened this spring",
            callToAction: { label: "Read", href: "https://example.com" },
            emailContent: { version: "1.0.0", type: "document", children: [] },
          },
        },
        "campaign-create-while-unconfigured-1",
      );
      expect(response.status).toBe(201);
      expect(mocks.createStandalone).toHaveBeenCalled();
    });

    it.each([
      ["request_test", { action: "request_test", campaignId, testRecipientIds: ["owner-primary"] }],
      ["confirm_test_receipt", { action: "confirm_test_receipt", executionId: "40000000-0000-4000-8000-000000000001" }],
      ["authorize_bulk", { action: "authorize_bulk", campaignId, testExecutionId: "40000000-0000-4000-8000-000000000001" }],
      ["send_bulk_now", { action: "send_bulk_now", campaignId, authorizationId: "50000000-0000-4000-8000-000000000001" }],
      ["retry_bulk_send", { action: "retry_bulk_send", campaignId, operationId: "60000000-0000-4000-8000-000000000001" }],
    ])("refuses %s with a clear reason", async (name, body) => {
      const response = await post(body, `campaign-blocked-${name}-1`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "delivery_not_configured",
      });
    });

    it("still lets an Owner cancel a scheduled send", async () => {
      // Cancelling stops a send. An Owner needs it exactly when delivery has
      // stopped working, so it must not be refused.
      mocks.cancelBulkSchedule.mockResolvedValue({
        schedule: { id: "70000000-0000-4000-8000-000000000001" },
        replayed: false,
      });
      const response = await post(
        {
          action: "cancel_bulk_schedule",
          scheduleId: "70000000-0000-4000-8000-000000000001",
        },
        "campaign-cancel-while-unconfigured-1",
      );
      expect(response.status).toBe(201);
      expect(mocks.cancelBulkSchedule).toHaveBeenCalled();
    });

    it("refuses any action that is not on the allowed list", async () => {
      // The gate is an allowlist, so an action absent from it is refused
      // rather than permitted by omission.
      const response = await post(
        {
          action: "activate_bulk_schedule",
          campaignId,
          authorizationId: "50000000-0000-4000-8000-000000000001",
          resolvedTime: {
            localDateTime: "2026-01-01T09:00",
            ianaTimeZone: "America/Vancouver",
            utcOffsetChoice: "-08:00",
            executeAtUtc: "2026-01-01T17:00:00.000Z",
            timeZoneDatabaseVersion: "2026a",
          },
        },
        "campaign-blocked-activate-1",
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "delivery_not_configured",
      });
      expect(mocks.activateBulkSchedule).not.toHaveBeenCalled();
    });

    it("does not reach any send or test operation", async () => {
      await post(
        {
          action: "request_test",
          campaignId,
          testRecipientIds: ["owner-primary"],
        },
        "campaign-blocked-no-call-1",
      );
      await post(
        {
          action: "send_bulk_now",
          campaignId,
          authorizationId: "50000000-0000-4000-8000-000000000001",
        },
        "campaign-blocked-no-call-2",
      );
      expect(mocks.requestTest).not.toHaveBeenCalled();
      expect(mocks.sendBulkNow).not.toHaveBeenCalled();
      expect(mocks.executeBulk).not.toHaveBeenCalled();
      expect(mocks.authorizeBulk).not.toHaveBeenCalled();
    });
  });
});

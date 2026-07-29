import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("injects canonical sender, contact, and unsubscribe compliance material", async () => {
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
            senderIdentityId: "sender_primary",
            audienceDefinition: {
              id: "canonical-consent-and-suppression",
              version: 1,
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.createStandalone).toHaveBeenCalledWith({
      actor: identity,
      input: expect.objectContaining({
        complianceFooter: {
          version: "reference-footer-v1",
          content: expect.stringMatching(
            /Humber Foundry.*Contact:.*Unsubscribe:/u,
          ),
        },
      }),
    });
  });

  it("audits malformed authenticated commands", async () => {
    const response = await POST(
      new Request("https://foundry.example/api/foundry-cms/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unknown" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.recordRejectedCommand).toHaveBeenCalledWith({
      actor: identity,
      reason: "campaign_command_invalid",
    });
  });
});

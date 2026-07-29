import { describe, expect, it, vi } from "vitest";

import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@foundry/site-definition";

import {
  createCampaignApplication,
  createCampaignTestDeliveryApplication,
  createInMemoryCampaignTestDeliveryStore,
  type CampaignEditableInput,
  type NewsletterDeliveryAdapter,
} from "./campaign";
import { createInMemoryCampaignStore } from "./in-memory-campaign-store";
import {
  createHumanMembershipId,
  createHumanUserId,
  type ExternalHumanIdentity,
  type HumanMembership,
} from "./human-access";

const siteId = createSiteId("site_reference");
const actor: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "editor-nonce",
};
const membership: HumanMembership = {
  id: createHumanMembershipId("membership-editor"),
  siteId,
  userId: createHumanUserId("user-editor"),
  email: actor.email,
  identityBinding: actor.binding,
  role: "editor",
  status: "active",
};
const input: CampaignEditableInput = {
  subject: "An exact test campaign",
  previewText: "Review this exact delivery.",
  callToAction: {
    label: "Read the update",
    href: "https://example.test/update",
  },
  emailContent: createRichTextDocumentFromPlainText("Exact campaign body."),
};
const channelConfiguration = {
  senderIdentityId: "sender_primary",
  complianceFooter: {
    version: "footer-v1",
    content: "Foundry test footer.",
    unsubscribePlaceholder:
      "https://example.test/newsletter/unsubscribe" +
      "?token={{foundry.unsubscribe.token}}",
  },
  audienceDefinition: {
    id: "canonical-consent-and-suppression",
    version: 1,
  } as const,
};

function createFixture(adapter: NewsletterDeliveryAdapter) {
  let sequence = 0;
  const campaignStore = createInMemoryCampaignStore();
  const deliveryStore = createInMemoryCampaignTestDeliveryStore();
  const rejectedCommands: unknown[] = [];
  const campaignApplication = createCampaignApplication({
    siteId,
    store: campaignStore,
    authorize: async () => membership,
    identifyActor: () => membership.id,
    findPostRevision: async () => null,
    resolveAudience: async () => ({ eligibleSubscriberCount: 3 }),
    channelConfiguration,
    rendererVersion: "1111111111111111111111111111111111111111",
    schemaVersion: "1.3.0",
    clock: () => new Date("2026-07-29T19:00:00.000Z"),
    createId: (kind) =>
      kind === "campaign"
        ? "20000000-0000-4000-8000-000000000001"
        : `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const application = createCampaignTestDeliveryApplication({
    siteId,
    campaignStore,
    store: deliveryStore,
    adapter,
    authorize: async () => membership,
    identifyActor: () => membership.id,
    resolveAudience: async () => ({ eligibleSubscriberCount: 3 }),
    resolveTestRecipients: async (recipientIds) =>
      recipientIds.map((id) => ({
        id,
        address: `${id}@example.test`,
      })),
    clock: () => new Date("2026-07-29T19:05:00.000Z"),
    createExecutionId: () =>
      "40000000-0000-4000-8000-000000000001",
    recordRejectedCommand: async (command) => {
      rejectedCommands.push(command);
    },
  });
  return {
    application,
    campaignApplication,
    deliveryStore,
    rejectedCommands,
  };
}

function capableAdapter(
  overrides: Partial<NewsletterDeliveryAdapter> = {},
): NewsletterDeliveryAdapter {
  return {
    capabilities: vi.fn().mockResolvedValue({
      provider: "brevo",
      configurationFingerprint: "a".repeat(64),
      apiTestDelivery: "supported",
      explicitRecipients: "supported",
      ambiguousOutcomeReconciliation: "supported",
      plainTextArtifact: "unsupported",
    }),
    health: vi.fn().mockResolvedValue({
      state: "healthy",
      credential: "verified",
      senderIdentity: "verified",
    }),
    sendTest: vi.fn().mockResolvedValue({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-17",
      providerReceipt: "brevo-test-accepted-17",
    }),
    reconcileTest: vi.fn().mockResolvedValue({ outcome: "not_found" }),
    ...overrides,
  };
}

async function createCampaign(
  campaignApplication: ReturnType<typeof createCampaignApplication>,
) {
  return campaignApplication.commands.createStandalone({
    actor,
    requestId: "campaign-create-for-test-1",
    input,
  });
}

describe("campaign test delivery", () => {
  it("binds successful provider evidence to every send-affecting fingerprint without retaining addresses", async () => {
    const adapter = capableAdapter();
    const { application, campaignApplication, deliveryStore } =
      createFixture(adapter);
    const created = await createCampaign(campaignApplication);

    const result = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-request-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });

    expect(result).toMatchObject({
      executionId: "40000000-0000-4000-8000-000000000001",
      state: "accepted",
      evidence: {
        campaignId: created.campaign.id,
        campaignRevisionId: created.revision.id,
        campaignFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        senderFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        audienceDefinitionFingerprint:
          expect.stringMatching(/^[a-f0-9]{64}$/u),
        complianceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        providerConfigurationFingerprint: "a".repeat(64),
        providerReceiptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        acceptedAt: "2026-07-29T19:05:00.000Z",
      },
    });
    expect(adapter.sendTest).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: result.executionId,
        providerCampaignId: null,
        recipients: [
          { id: "owner-primary", address: "owner-primary@example.test" },
        ],
      }),
    );
    expect(JSON.stringify(deliveryStore.list())).not.toContain("@");
  });

  it("reconciles an ambiguous outcome before completing the same logical test", async () => {
    const adapter = capableAdapter({
      sendTest: vi.fn().mockResolvedValue({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-18",
      }),
      reconcileTest: vi.fn().mockResolvedValue({
        outcome: "accepted",
        providerCampaignId: "brevo-campaign-18",
        providerReceipt: "brevo-test-reconciled-18",
      }),
    });
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-ambiguous-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    const ambiguous = await application.commands.requestTest(request);
    const reconciled = await application.commands.requestTest(request);

    expect(ambiguous).toMatchObject({
      executionId: "40000000-0000-4000-8000-000000000001",
      state: "ambiguous",
    });
    expect(reconciled).toMatchObject({
      executionId: ambiguous.executionId,
      state: "accepted",
    });
    expect(adapter.sendTest).toHaveBeenCalledTimes(1);
    expect(adapter.reconcileTest).toHaveBeenCalledTimes(1);
  });

  it("retries with the stable execution identity only after reconciliation proves no delivery", async () => {
    const sendTest = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-19",
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        providerCampaignId: "brevo-campaign-19",
        providerReceipt: "brevo-test-retried-19",
      });
    const adapter = capableAdapter({
      sendTest,
      reconcileTest: vi.fn().mockResolvedValue({ outcome: "not_found" }),
    });
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-retry-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    const first = await application.commands.requestTest(request);
    const second = await application.commands.requestTest(request);

    expect(second.state).toBe("accepted");
    expect(sendTest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ executionId: first.executionId }),
    );
  });

  it("continues an existing provider draft when reconciliation proves the test was not sent", async () => {
    const sendTest = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-20",
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        providerCampaignId: "brevo-campaign-20",
        providerReceipt: "brevo-test-recovered-20",
      });
    const adapter = capableAdapter({
      sendTest,
      reconcileTest: vi.fn().mockResolvedValue({
        outcome: "not_sent",
        providerCampaignId: "brevo-campaign-20",
      }),
    });
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-existing-draft-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    await application.commands.requestTest(request);
    await application.commands.requestTest(request);

    expect(sendTest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        executionId: "40000000-0000-4000-8000-000000000001",
        providerCampaignId: "brevo-campaign-20",
      }),
    );
  });

  it("lets only one concurrent caller cross the provider-write fence", async () => {
    let completeSend!: (
      outcome: Awaited<ReturnType<NewsletterDeliveryAdapter["sendTest"]>>,
    ) => void;
    const sendTest = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<NewsletterDeliveryAdapter["sendTest"]>>
        >((resolve) => {
          completeSend = resolve;
        }),
    );
    const adapter = capableAdapter({ sendTest });
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-concurrent-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    const first = application.commands.requestTest(request);
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));
    const concurrent = await application.commands.requestTest(request);

    expect(concurrent.state).toBe("attempting");
    expect(sendTest).toHaveBeenCalledTimes(1);
    completeSend({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-21",
      providerReceipt: "brevo-test-accepted-21",
    });
    await expect(first).resolves.toMatchObject({ state: "accepted" });
  });

  it("makes prior evidence stale after any send-affecting campaign edit", async () => {
    const { application, campaignApplication } =
      createFixture(capableAdapter());
    const created = await createCampaign(campaignApplication);
    await application.commands.requestTest({
      actor,
      requestId: "campaign-test-before-edit-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await expect(
      application.queries.currentEvidence({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.toMatchObject({ campaignRevisionId: created.revision.id });

    await campaignApplication.commands.edit({
      actor,
      requestId: "campaign-edit-after-test-1",
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: { ...input, subject: "Changed after the test" },
    });

    await expect(
      application.queries.currentEvidence({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the configured provider lacks a required test capability", async () => {
    const adapter = capableAdapter({
      capabilities: vi.fn().mockResolvedValue({
        provider: "replacement",
        configurationFingerprint: "b".repeat(64),
        apiTestDelivery: "unsupported",
        explicitRecipients: "supported",
        ambiguousOutcomeReconciliation: "supported",
        plainTextArtifact: "unsupported",
      }),
    });
    const { application, campaignApplication, rejectedCommands } =
      createFixture(adapter);
    const created = await createCampaign(campaignApplication);

    await expect(
      application.commands.requestTest({
        actor,
        requestId: "campaign-test-unsupported-1",
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary"],
      }),
    ).rejects.toMatchObject({ message: "provider_test_delivery_unsupported" });
    expect(adapter.sendTest).not.toHaveBeenCalled();
    expect(rejectedCommands).toMatchObject([
      {
        requestId: "campaign-test-unsupported-1",
        reason: "provider_test_delivery_unsupported",
        command: {
          action: "request_test",
          testRecipientIds: ["owner-primary"],
        },
        targetId: created.campaign.id,
      },
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@humber-foundry/site-definition";

import {
  CampaignValidationError,
  createCampaignApplication,
  createCampaignTestDeliveryApplication,
  createInMemoryCampaignTestDeliveryStore,
  type CampaignEditableInput,
  type NewsletterDeliveryAdapter,
  type NewsletterProviderOwnershipEvidence,
} from "./campaign";
import { hmacSha256CanonicalJson } from "./deterministic-hash";
import { createInMemoryCampaignStore } from "./in-memory-campaign-store";
import {
  createHumanMembershipId,
  createHumanUserId,
  type ExternalHumanIdentity,
  type HumanMembership,
} from "./human-access";

const siteId = createSiteId("site_reference");
const defaultRecipientFingerprintKey =
  "recipient-fingerprint-key-".padEnd(48, "k");
const actor: ExternalHumanIdentity = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "editor-nonce",
};
const membership: HumanMembership = {
  id: createHumanMembershipId("owner-primary"),
  siteId,
  userId: createHumanUserId("user-editor"),
  email: actor.email,
  identityBinding: actor.binding,
  role: "owner",
  status: "active",
};
const input: CampaignEditableInput = {
  subject: "An exact test campaign",
  previewText: "Review this exact delivery.",
  shareImage: null,
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
const testProviderMessageId = "<foundry-test-message@brevo.test>";

function testProviderReceipt() {
  return {
    version: "foundry.newsletter-test-provider-receipt.v1" as const,
    provider: "brevo",
    messageId: testProviderMessageId,
  };
}

function createFixture(
  adapter: NewsletterDeliveryAdapter,
  clock = () => new Date("2026-07-29T19:05:00.000Z"),
  createExecutionId = () =>
    "40000000-0000-4000-8000-000000000001",
  providerOwnershipEvidence: NewsletterProviderOwnershipEvidence = {
    classification: "evaluation" as const,
    evidenceId: "provisioning-evaluation-1",
    accountScopeFingerprint: "8".repeat(64),
    verifiedAt: "2026-07-29T18:00:00.000Z",
  },
  resolveTestRecipients = async (recipientIds: ReadonlyArray<string>) =>
    recipientIds.map((id) => ({
      id,
      address: `${id}@example.test`,
    })),
  failConfirmationReceipt = false,
  authorizedMembership: HumanMembership = membership,
  activeRendererVersion = () => "1".repeat(40),
  recipientFingerprintKey = defaultRecipientFingerprintKey,
) {
  let sequence = 0;
  let campaignSequence = 0;
  const deliveryStore = createInMemoryCampaignTestDeliveryStore();
  const campaignStore = createInMemoryCampaignStore({
    cancelOpenTestDeliveries: (input) =>
      deliveryStore.cancelForCampaignEdit(input),
    persistTestReceiptConfirmation: async (confirmation) => {
      await deliveryStore.persistReceiptConfirmation(confirmation);
    },
  });
  const rejectedCommands: unknown[] = [];
  const campaignApplication = createCampaignApplication({
    siteId,
    store: campaignStore,
    authorize: async () => authorizedMembership,
    identifyActor: () => authorizedMembership.id,
    findPostRevision: async () => null,
    resolveAudience: async () => ({ eligibleSubscriberCount: 3 }),
    channelConfiguration,
    siteCanonicalOrigin: "https://example.test",
    rendererVersion: "1111111111111111111111111111111111111111",
    schemaVersion: "1.5.0",
    clock: () => new Date("2026-07-29T19:00:00.000Z"),
    createId: (kind) =>
      kind === "campaign"
        ? `20000000-0000-4000-8000-${String(++campaignSequence).padStart(12, "0")}`
        : `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const application = createCampaignTestDeliveryApplication({
    siteId,
    campaignStore,
    store: deliveryStore,
    adapter,
    authorize: async () => authorizedMembership,
    identifyActor: () => authorizedMembership.id,
    resolveAudience: async () => ({ eligibleSubscriberCount: 3 }),
    resolveTestRecipients,
    providerOwnershipEvidence,
    recipientFingerprintKey,
    activeRendererVersion,
    replayTestCommand: (command) =>
      campaignApplication.commands.replayTestCommand(command),
    recordAcceptedTestCommand: (command) =>
      campaignApplication.commands.recordAcceptedTestCommand(command),
    recordAcceptedTestReceiptConfirmation: (command) => {
      if (
        failConfirmationReceipt &&
        (command.command as { action?: unknown }).action ===
          "confirm_test_receipt"
      ) {
        throw new Error("simulated_confirmation_receipt_failure");
      }
      return campaignApplication.commands
        .recordAcceptedTestReceiptConfirmation(command);
    },
    clock,
    createExecutionId,
    recordRejectedCommand: async (command) => {
      rejectedCommands.push(command);
      await campaignApplication.commands.recordRejectedCommand({
        ...command,
        action: "campaign.test",
        commandName: command.commandName ?? "campaign.request_test",
      });
    },
  });
  return {
    application,
    campaignApplication,
    campaignStore,
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
      senderConfigurationFingerprints: {
        sender_primary: "b".repeat(64),
      },
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
    prepareTest: vi.fn().mockResolvedValue({
      outcome: "prepared",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
    }),
    sendTest: vi.fn().mockResolvedValue({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-17",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "9".repeat(64),
      providerReceipt: testProviderReceipt(),
    }),
    reconcileTest: vi.fn().mockResolvedValue({ outcome: "not_found" }),
    ...overrides,
  };
}

async function createCampaign(
  campaignApplication: ReturnType<typeof createCampaignApplication>,
  requestId = "campaign-create-for-test-1",
) {
  return campaignApplication.commands.createStandalone({
    actor,
    requestId,
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
        providerMessageId: testProviderMessageId,
        providerReceiptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        acceptedAt: "2026-07-29T19:05:00.000Z",
      },
    });
    expect(adapter.sendTest).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: result.executionId,
        providerCampaignId: "brevo-campaign-17",
        foundrySendProof: "9".repeat(64),
        recipients: [
          { id: "owner-primary", address: "owner-primary@example.test" },
        ],
      }),
    );
    expect(JSON.stringify(deliveryStore.list())).not.toContain(
      "owner-primary@example.test",
    );
    await expect(
      hmacSha256CanonicalJson(defaultRecipientFingerprintKey, {
        version: "foundry.campaign-test-recipients.v3",
        recipients: [
          {
            id: "owner-primary",
            address: "owner-primary@example.test",
          },
        ],
      }),
    ).resolves.toBe(result.binding.recipientSetFingerprint);
    expect(JSON.stringify(result)).not.toContain(
      defaultRecipientFingerprintKey,
    );
  });

  it("persists the exact Foundry send proof before invoking the provider test write", async () => {
    let durableOperation:
      | (() => ReturnType<
          ReturnType<typeof createInMemoryCampaignTestDeliveryStore>["list"]
        >[number])
      | undefined;
    const sendTest = vi.fn(
      async (
        request: Parameters<NewsletterDeliveryAdapter["sendTest"]>[0],
      ) => {
        expect(durableOperation?.()).toMatchObject({
          state: "attempting",
          providerCampaignId: request.providerCampaignId,
          foundrySendProof: request.foundrySendProof,
        });
        return {
          outcome: "accepted" as const,
          providerCampaignId: request.providerCampaignId!,
          providerMessageId: testProviderMessageId,
          foundrySendProof: request.foundrySendProof!,
          providerReceipt: testProviderReceipt(),
        };
      },
    );
    const fixture = createFixture(capableAdapter({ sendTest }));
    durableOperation = () => fixture.deliveryStore.list()[0]!;
    const created = await createCampaign(fixture.campaignApplication);

    const result = await fixture.application.commands.requestTest({
      actor,
      requestId: "campaign-test-durable-proof-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });

    expect(result).toMatchObject({
      state: "accepted",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
    });
    expect(sendTest).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      mismatch: "provider campaign",
      providerCampaignId: "brevo-campaign-other",
      foundrySendProof: "9".repeat(64),
    },
    {
      mismatch: "Foundry send proof",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "8".repeat(64),
    },
  ])(
    "keeps a mismatched accepted $mismatch response ambiguous",
    async ({ providerCampaignId, foundrySendProof }) => {
      const adapter = capableAdapter({
        sendTest: vi.fn().mockResolvedValue({
          outcome: "accepted",
          providerCampaignId,
          providerMessageId: testProviderMessageId,
          foundrySendProof,
          providerReceipt: testProviderReceipt(),
        }),
      });
      const { application, campaignApplication } =
        createFixture(adapter);
      const created = await createCampaign(campaignApplication);

      const result = await application.commands.requestTest({
        actor,
        requestId: `campaign-test-mismatched-${providerCampaignId}-${foundrySendProof.slice(0, 1)}`,
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary"],
      });

      expect(result).toMatchObject({
        state: "ambiguous",
        providerCampaignId: "brevo-campaign-17",
        foundrySendProof: "9".repeat(64),
        evidence: null,
      });
    },
  );

  it("rechecks active Owner eligibility immediately before the provider write", async () => {
    let resolutionCount = 0;
    const sendTest = vi.fn();
    const { application, campaignApplication } = createFixture(
      capableAdapter({ sendTest }),
      undefined,
      undefined,
      undefined,
      async (recipientIds) => {
        resolutionCount += 1;
        if (resolutionCount > 1) {
          throw new CampaignValidationError(
            "test_recipient_forbidden",
          );
        }
        return recipientIds.map((id) => ({
          id,
          address: `${id}@example.test`,
        }));
      },
    );
    const created = await createCampaign(campaignApplication);

    const result = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-owner-revoked-before-write-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });

    expect(result).toMatchObject({
      state: "failed",
      failureCode: "test_recipient_forbidden",
      evidence: null,
    });
    expect(resolutionCount).toBe(2);
    expect(sendTest).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous outcome before completing the same logical test", async () => {
    const adapter = capableAdapter({
      sendTest: vi.fn().mockResolvedValue({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-17",
        foundrySendProof: "9".repeat(64),
        code: "provider_rate_limited",
      }),
      reconcileTest: vi.fn().mockResolvedValue({
        outcome: "accepted",
        providerCampaignId: "brevo-campaign-17",
        providerMessageId: testProviderMessageId,
        foundrySendProof: "9".repeat(64),
        providerReceipt: testProviderReceipt(),
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
      failureCode: "provider_rate_limited",
    });
    expect(reconciled).toMatchObject({
      executionId: ambiguous.executionId,
      state: "accepted",
    });
    expect(adapter.sendTest).toHaveBeenCalledTimes(1);
    expect(adapter.reconcileTest).toHaveBeenCalledTimes(1);
  });

  it("permits a new logical request after exact reconciliation proves terminal non-delivery", async () => {
    const sendTest = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-17",
        foundrySendProof: "9".repeat(64),
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        providerCampaignId: "brevo-campaign-17",
        providerMessageId: testProviderMessageId,
        foundrySendProof: "9".repeat(64),
        providerReceipt: testProviderReceipt(),
      });
    const adapter = capableAdapter({
      sendTest,
      reconcileTest: vi.fn().mockResolvedValue({
        outcome: "rejected",
        code: "provider_test_definitively_not_delivered",
      }),
    });
    let executionSequence = 0;
    const { application, campaignApplication } = createFixture(
      adapter,
      undefined,
      () =>
        `40000000-0000-4000-8000-${String(
          ++executionSequence,
        ).padStart(12, "0")}`,
    );
    const created = await createCampaign(campaignApplication);
    const originalRequest = {
      actor,
      requestId: "campaign-test-terminal-nondelivery-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    await expect(
      application.commands.requestTest(originalRequest),
    ).resolves.toMatchObject({ state: "ambiguous" });
    await expect(
      application.commands.requestTest(originalRequest),
    ).resolves.toMatchObject({
      state: "failed",
      failureCode: "provider_test_definitively_not_delivered",
    });
    await expect(
      application.commands.requestTest({
        ...originalRequest,
        requestId: "campaign-test-terminal-nondelivery-2",
      }),
    ).resolves.toMatchObject({
      state: "accepted",
      executionId: "40000000-0000-4000-8000-000000000002",
    });
    expect(sendTest).toHaveBeenCalledTimes(2);
  });

  it("keeps a conflicting reconciliation unresolved and blocks a replacement write", async () => {
    const sendTest = vi.fn().mockResolvedValue({
      outcome: "ambiguous",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
    });
    const adapter = capableAdapter({
      sendTest,
      reconcileTest: vi.fn().mockResolvedValue({
        outcome: "rejected",
        code: "provider_campaign_fingerprint_mismatch",
      }),
    });
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const originalRequest = {
      actor,
      requestId: "campaign-test-conflicting-evidence-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    await application.commands.requestTest(originalRequest);
    await expect(
      application.commands.requestTest(originalRequest),
    ).resolves.toMatchObject({
      state: "ambiguous",
      failureCode: "provider_campaign_fingerprint_mismatch",
    });
    await expect(
      application.commands.requestTest({
        ...originalRequest,
        requestId: "campaign-test-conflicting-evidence-2",
      }),
    ).rejects.toMatchObject({ message: "test_delivery_in_progress" });
    expect(sendTest).toHaveBeenCalledTimes(1);
  });

  it("retries a preparation crash with no provider correlation or proof", async () => {
    const prepareTest = vi
      .fn()
      .mockRejectedValueOnce(new Error("preparation_crashed"))
      .mockResolvedValueOnce({
        outcome: "prepared",
        providerCampaignId: "brevo-campaign-21",
        foundrySendProof: "8".repeat(64),
      });
    const sendTest = vi.fn().mockResolvedValue({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-21",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "8".repeat(64),
      providerReceipt: testProviderReceipt(),
    });
    const adapter = capableAdapter({
      prepareTest,
      sendTest,
      reconcileTest: vi.fn(),
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
    expect(sendTest).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: first.executionId,
        providerCampaignId: "brevo-campaign-21",
        foundrySendProof: "8".repeat(64),
      }),
    );
    expect(prepareTest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        executionId: first.executionId,
        providerCampaignId: null,
      }),
    );
    expect(adapter.reconcileTest).not.toHaveBeenCalled();
  });

  it("does not retry a known provider campaign when reconciliation reports it missing", async () => {
    const sendTest = vi.fn().mockResolvedValue({
      outcome: "ambiguous",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
    });
    const adapter = capableAdapter({
      sendTest,
      reconcileTest: vi.fn().mockResolvedValue({ outcome: "not_found" }),
    });
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-deleted-after-send-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    const first = await application.commands.requestTest(request);
    const second = await application.commands.requestTest(request);

    expect(second).toMatchObject({
      executionId: first.executionId,
      state: "ambiguous",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
    });
    expect(sendTest).toHaveBeenCalledTimes(1);
  });

  it("continues an existing provider draft when reconciliation proves the test was not sent", async () => {
    const prepareTest = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-20",
      })
      .mockResolvedValueOnce({
        outcome: "prepared",
        providerCampaignId: "brevo-campaign-20",
        foundrySendProof: "8".repeat(64),
      });
    const sendTest = vi.fn().mockResolvedValue({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-20",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "8".repeat(64),
      providerReceipt: testProviderReceipt(),
    });
    const adapter = capableAdapter({
      prepareTest,
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

    expect(sendTest).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "40000000-0000-4000-8000-000000000001",
        providerCampaignId: "brevo-campaign-20",
        foundrySendProof: "8".repeat(64),
      }),
    );
    expect(sendTest).toHaveBeenCalledTimes(1);
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
      providerCampaignId: "brevo-campaign-17",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "9".repeat(64),
      providerReceipt: testProviderReceipt(),
    });
    await expect(first).resolves.toMatchObject({ state: "accepted" });
  });

  it("safely restarts an expired attempt that crashed before proof persistence", async () => {
    let now = new Date("2026-07-29T19:05:00.000Z");
    let finishFirstPreparation!: (
      preparation: Awaited<
        ReturnType<NewsletterDeliveryAdapter["prepareTest"]>
      >,
    ) => void;
    const prepareTest = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstPreparation = resolve;
          }),
      )
      .mockResolvedValue({
        outcome: "prepared",
        providerCampaignId: "brevo-campaign-17",
        foundrySendProof: "9".repeat(64),
      });
    const adapter = capableAdapter({ prepareTest });
    const { application, campaignApplication, deliveryStore } = createFixture(
      adapter,
      () => now,
    );
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-pre-proof-crash-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    const crashed = application.commands.requestTest(request);
    await vi.waitFor(() => expect(prepareTest).toHaveBeenCalledTimes(1));
    expect(deliveryStore.list()[0]).toMatchObject({
      state: "attempting",
      providerCampaignId: null,
      foundrySendProof: null,
    });

    now = new Date("2026-07-29T19:06:01.000Z");
    await expect(
      application.commands.requestTest(request),
    ).resolves.toMatchObject({
      state: "accepted",
      attemptNumber: 2,
    });
    expect(adapter.reconcileTest).not.toHaveBeenCalled();
    expect(adapter.sendTest).toHaveBeenCalledTimes(1);

    finishFirstPreparation({
      outcome: "prepared",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
    });
    await expect(crashed).resolves.toMatchObject({ state: "accepted" });
  });

  it("keeps an expired in-flight writer reconciliation-only until that writer completes", async () => {
    let completeSend!: (
      outcome: Awaited<ReturnType<NewsletterDeliveryAdapter["sendTest"]>>,
    ) => void;
    let now = new Date("2026-07-29T19:05:00.000Z");
    const sendTest = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<NewsletterDeliveryAdapter["sendTest"]>>
        >((resolve) => {
          completeSend = resolve;
        }),
    );
    const adapter = capableAdapter({ sendTest });
    const { application, campaignApplication, deliveryStore } = createFixture(
      adapter,
      () => now,
    );
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-expired-writer-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    const first = application.commands.requestTest(request);
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));
    now = new Date("2026-07-29T19:06:01.000Z");
    const recovery = await application.commands.requestTest(request);

    expect(recovery).toMatchObject({
      state: "ambiguous",
      attemptLeaseUntil: "2026-07-29T19:07:01.000Z",
    });
    expect(adapter.reconcileTest).toHaveBeenCalledTimes(1);
    expect(sendTest).toHaveBeenCalledTimes(1);
    completeSend({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-17",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "9".repeat(64),
      providerReceipt: testProviderReceipt(),
    });
    await expect(first).resolves.toMatchObject({ state: "accepted" });
  });

  it("keeps a crashed writer ambiguous after its reconciliation quarantine", async () => {
    let now = new Date("2026-07-29T19:05:00.000Z");
    const sendTest = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const adapter = capableAdapter({ sendTest });
    const { application, campaignApplication } = createFixture(
      adapter,
      () => now,
    );
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-crashed-writer-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    void application.commands.requestTest(request);
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));
    now = new Date("2026-07-29T19:06:01.000Z");
    const quarantined = await application.commands.requestTest(request);

    expect(quarantined).toMatchObject({
      state: "ambiguous",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
      attemptLeaseUntil: "2026-07-29T19:07:01.000Z",
    });
    expect(sendTest).toHaveBeenCalledTimes(1);

    now = new Date("2026-07-29T19:07:02.000Z");
    const stillAmbiguous =
      await application.commands.requestTest(request);
    expect(stillAmbiguous).toMatchObject({
      state: "ambiguous",
      providerCampaignId: "brevo-campaign-17",
      foundrySendProof: "9".repeat(64),
    });
    expect(adapter.reconcileTest).toHaveBeenCalledTimes(2);
    expect(sendTest).toHaveBeenCalledTimes(1);
  });

  it("blocks a second request identity while the revision has an unresolved test", async () => {
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
    const first = application.commands.requestTest({
      actor,
      requestId: "campaign-test-unresolved-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));

    await expect(
      application.commands.requestTest({
        actor,
        requestId: "campaign-test-unresolved-2",
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary"],
      }),
    ).rejects.toMatchObject({ message: "test_delivery_in_progress" });
    expect(sendTest).toHaveBeenCalledTimes(1);

    completeSend({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-17",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "9".repeat(64),
      providerReceipt: testProviderReceipt(),
    });
    await first;
  });

  it("blocks a send-affecting edit until the provider write completes", async () => {
    let now = new Date("2026-07-29T19:05:00.000Z");
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
    const { application, campaignApplication, deliveryStore } = createFixture(
      adapter,
      () => now,
    );
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-edit-attempting-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    const first = application.commands.requestTest(request);
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));
    await expect(
      campaignApplication.commands.edit({
        actor,
        requestId: "campaign-edit-during-attempting-test-1",
        campaignId: created.campaign.id,
        expectedVersion: 1,
        input: { ...input, subject: "Edited during provider test" },
      }),
    ).rejects.toMatchObject({ message: "campaign_revision_conflict" });
    expect(deliveryStore.list()).toEqual([
      expect.objectContaining({
        state: "attempting",
        failureCode: null,
      }),
    ]);
    expect(adapter.reconcileTest).not.toHaveBeenCalled();
    expect(sendTest).toHaveBeenCalledTimes(1);
    completeSend({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-17",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "9".repeat(64),
      providerReceipt: testProviderReceipt(),
    });
    await expect(first).resolves.toMatchObject({
      state: "accepted",
      failureCode: null,
    });
    now = new Date("2026-07-29T19:06:01.000Z");
    await expect(
      campaignApplication.commands.edit({
        actor,
        requestId: "campaign-edit-after-attempting-test-1",
        campaignId: created.campaign.id,
        expectedVersion: 1,
        input: { ...input, subject: "Edited after provider test" },
      }),
    ).resolves.toMatchObject({
      campaign: { version: 2 },
    });
  });

  it("renews the durable fence immediately before a delayed provider write", async () => {
    let now = new Date("2026-07-29T19:05:00.000Z");
    let recipientResolution = 0;
    const resolveTestRecipients = vi.fn(
      async (recipientIds: ReadonlyArray<string>) => {
        recipientResolution += 1;
        if (recipientResolution === 2) {
          now = new Date("2026-07-29T19:05:50.000Z");
        }
        return recipientIds.map((id) => ({
          id,
          address: `${id}@example.test`,
        }));
      },
    );
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
    const { application, campaignApplication, deliveryStore } = createFixture(
      adapter,
      () => now,
      undefined,
      undefined,
      resolveTestRecipients,
    );
    const created = await createCampaign(campaignApplication);
    const requested = application.commands.requestTest({
      actor,
      requestId: "campaign-test-renewed-fence-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));
    expect(deliveryStore.list()[0]).toMatchObject({
      state: "attempting",
      attemptLeaseUntil: "2026-07-29T19:06:50.000Z",
    });

    now = new Date("2026-07-29T19:06:01.000Z");
    await expect(
      campaignApplication.commands.edit({
        actor,
        requestId: "campaign-edit-during-renewed-fence-1",
        campaignId: created.campaign.id,
        expectedVersion: 1,
        input: { ...input, subject: "Blocked by renewed fence" },
      }),
    ).rejects.toMatchObject({ message: "campaign_revision_conflict" });

    completeSend({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-17",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "9".repeat(64),
      providerReceipt: testProviderReceipt(),
    });
    await expect(requested).resolves.toMatchObject({ state: "accepted" });
  });

  it("cancels an ambiguous test after an edit without reconciling or retrying", async () => {
    const adapter = capableAdapter({
      sendTest: vi.fn().mockResolvedValue({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-25",
      }),
    });
    const { application, campaignApplication, deliveryStore } =
      createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-edit-ambiguous-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    await application.commands.requestTest(request);
    await campaignApplication.commands.edit({
      actor,
      requestId: "campaign-edit-after-ambiguous-test-1",
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: { ...input, previewText: "Edited after uncertain delivery" },
    });
    expect(deliveryStore.list()).toEqual([
      expect.objectContaining({
        state: "cancelled",
        failureCode: "campaign_revision_changed",
      }),
    ]);

    await expect(
      application.commands.requestTest(request),
    ).resolves.toMatchObject({
      state: "cancelled",
      failureCode: "campaign_revision_changed",
    });
    expect(adapter.reconcileTest).not.toHaveBeenCalled();
    expect(adapter.sendTest).toHaveBeenCalledTimes(1);
  });

  it("does not cross the provider boundary when an edit wins the pre-write race", async () => {
    let releaseRecipients!: () => void;
    const recipientsBlocked = new Promise<void>((resolve) => {
      releaseRecipients = resolve;
    });
    const resolveTestRecipients = vi.fn(
      async (recipientIds: ReadonlyArray<string>) => {
        await recipientsBlocked;
        return recipientIds.map((id) => ({
          id,
          address: `${id}@example.test`,
        }));
      },
    );
    const adapter = capableAdapter();
    const { application, campaignApplication } = createFixture(
      adapter,
      undefined,
      undefined,
      undefined,
      resolveTestRecipients,
    );
    const created = await createCampaign(campaignApplication);
    const requested = application.commands.requestTest({
      actor,
      requestId: "campaign-test-edit-pre-write-race-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await vi.waitFor(() =>
      expect(resolveTestRecipients).toHaveBeenCalledTimes(1),
    );

    await campaignApplication.commands.edit({
      actor,
      requestId: "campaign-edit-pre-write-race-1",
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: { ...input, subject: "Edit wins provider race" },
    });
    releaseRecipients();

    await expect(requested).resolves.toMatchObject({
      state: "cancelled",
      failureCode: "campaign_revision_changed",
    });
    expect(adapter.sendTest).not.toHaveBeenCalled();
  });

  it("returns durable cancellation when an edit wins a reconciliation race", async () => {
    let completeReconciliation!: (
      outcome: Awaited<
        ReturnType<NewsletterDeliveryAdapter["reconcileTest"]>
      >,
    ) => void;
    const reconcileTest = vi.fn(
      () =>
        new Promise<
          Awaited<ReturnType<NewsletterDeliveryAdapter["reconcileTest"]>>
        >((resolve) => {
          completeReconciliation = resolve;
        }),
    );
    const adapter = capableAdapter({
      sendTest: vi.fn().mockResolvedValue({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-reconcile-race-1",
      }),
      reconcileTest,
    });
    const { application, campaignApplication, deliveryStore } =
      createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-edit-reconcile-race-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };
    await application.commands.requestTest(request);
    const reconciling = application.commands.requestTest(request);
    await vi.waitFor(() => expect(reconcileTest).toHaveBeenCalledTimes(1));

    await campaignApplication.commands.edit({
      actor,
      requestId: "campaign-edit-reconcile-race-1",
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: { ...input, subject: "Edit wins reconciliation race" },
    });
    completeReconciliation({
      outcome: "accepted",
      providerCampaignId: "brevo-campaign-17",
      providerMessageId: testProviderMessageId,
      foundrySendProof: "9".repeat(64),
      providerReceipt: testProviderReceipt(),
    });

    await expect(reconciling).resolves.toMatchObject({
      state: "cancelled",
      evidence: null,
      failureCode: "campaign_revision_changed",
    });
    expect(deliveryStore.list()).toEqual([
      expect.objectContaining({ state: "cancelled", evidence: null }),
    ]);
  });

  it("limits configured recipients to five at the shared application boundary", async () => {
    const adapter = capableAdapter();
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);

    await expect(
      application.commands.requestTest({
        actor,
        requestId: "campaign-test-too-many-recipients-1",
        campaignId: created.campaign.id,
        testRecipientIds: ["one", "two", "three", "four", "five", "six"],
      }),
    ).rejects.toMatchObject({ message: "test_recipient_forbidden" });
    expect(adapter.sendTest).not.toHaveBeenCalled();
  });

  it("rejects recipient identities that resolve to the same normalized address", async () => {
    const adapter = capableAdapter();
    const { application, campaignApplication } = createFixture(
      adapter,
      undefined,
      undefined,
      undefined,
      async (recipientIds) =>
        recipientIds.map((id, index) => ({
          id,
          address: index === 0
            ? "Owner@Example.Test"
            : "owner@example.test",
        })),
    );
    const created = await createCampaign(campaignApplication);

    await expect(
      application.commands.requestTest({
        actor,
        requestId: "campaign-test-duplicate-addresses-1",
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary", "owner-secondary"],
      }),
    ).rejects.toMatchObject({ message: "test_recipient_forbidden" });
    expect(adapter.prepareTest).not.toHaveBeenCalled();
    expect(adapter.sendTest).not.toHaveBeenCalled();
  });

  it("rate limits new logical tests by site and campaign revision", async () => {
    let execution = 0;
    const adapter = capableAdapter();
    const { application, campaignApplication } = createFixture(
      adapter,
      undefined,
      () =>
        `40000000-0000-4000-8000-${String(++execution).padStart(12, "0")}`,
    );
    const created = await createCampaign(campaignApplication);

    for (let index = 1; index <= 5; index += 1) {
      await application.commands.requestTest({
        actor,
        requestId: `campaign-test-rate-${index}`,
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary"],
      });
    }
    await expect(
      application.commands.requestTest({
        actor,
        requestId: "campaign-test-rate-6",
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary"],
      }),
    ).rejects.toMatchObject({ message: "test_delivery_rate_limited" });
    expect(adapter.sendTest).toHaveBeenCalledTimes(5);
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

  it("makes prior evidence stale when a configured recipient identity is remapped", async () => {
    let address = "owner-original@example.test";
    const resolveTestRecipients = async (
      recipientIds: ReadonlyArray<string>,
    ) =>
      recipientIds.map((id) => ({ id, address }));
    const { application, campaignApplication } = createFixture(
      capableAdapter(),
      undefined,
      undefined,
      undefined,
      resolveTestRecipients,
    );
    const created = await createCampaign(campaignApplication);
    await application.commands.requestTest({
      actor,
      requestId: "campaign-test-before-recipient-remap-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await expect(
      application.queries.currentEvidence({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.not.toBeNull();

    address = "owner-remapped@example.test";

    await expect(
      application.queries.currentEvidence({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.toBeNull();
  });

  it("makes prior evidence stale when the selected sender configuration changes", async () => {
    let senderConfigurationFingerprint = "b".repeat(64);
    const adapter = capableAdapter({
      capabilities: vi.fn(async () => ({
        provider: "brevo",
        configurationFingerprint: "a".repeat(64),
        senderConfigurationFingerprints: {
          sender_primary: senderConfigurationFingerprint,
        },
        apiTestDelivery: "supported" as const,
        explicitRecipients: "supported" as const,
        ambiguousOutcomeReconciliation: "supported" as const,
        plainTextArtifact: "unsupported" as const,
      })),
    });
    const { application, campaignApplication } = createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    await application.commands.requestTest({
      actor,
      requestId: "campaign-test-before-sender-change-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await expect(
      application.queries.currentEvidence({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.not.toBeNull();

    senderConfigurationFingerprint = "c".repeat(64);

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
        senderConfigurationFingerprints: {
          sender_primary: "c".repeat(64),
        },
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
        beforeState: JSON.stringify({
          current: { providerCapabilities: "unsupported_or_mismatched" },
          required: {
            apiTestDelivery: "supported",
            explicitRecipients: "supported",
            ambiguousOutcomeReconciliation: "supported",
          },
        }),
      },
    ]);
  });

  it("rejects tests and current evidence rendered by another release", async () => {
    let activeRendererVersion = "1".repeat(40);
    const adapter = capableAdapter();
    const { application, campaignApplication } = createFixture(
      adapter,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      membership,
      () => activeRendererVersion,
    );
    const created = await createCampaign(campaignApplication);
    await application.commands.requestTest({
      actor,
      requestId: "campaign-test-renderer-original-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    activeRendererVersion = "2".repeat(40);

    await expect(
      application.commands.requestTest({
        actor,
        requestId: "campaign-test-renderer-drift-1",
        campaignId: created.campaign.id,
        testRecipientIds: ["owner-primary"],
      }),
    ).rejects.toMatchObject({ message: "campaign_renderer_mismatch" });
    await expect(
      application.queries.currentEvidence({
        actor,
        campaignId: created.campaign.id,
      }),
    ).rejects.toMatchObject({ message: "campaign_renderer_mismatch" });
    expect(adapter.sendTest).toHaveBeenCalledTimes(1);
  });

  it("replays a durable pre-operation rejection without later sending", async () => {
    const health = vi
      .fn()
      .mockResolvedValueOnce({
        state: "unavailable",
        credential: "unknown",
        senderIdentity: "unknown",
      })
      .mockResolvedValue({
        state: "healthy",
        credential: "verified",
        senderIdentity: "verified",
      });
    const adapter = capableAdapter({ health });
    const { application, campaignApplication, campaignStore } =
      createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-health-rejected-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    await expect(
      application.commands.requestTest(request),
    ).rejects.toMatchObject({ message: "provider_unhealthy" });
    await expect(
      application.commands.requestTest(request),
    ).rejects.toMatchObject({ message: "provider_unhealthy" });

    expect(health).toHaveBeenCalledTimes(1);
    expect(adapter.sendTest).not.toHaveBeenCalled();
    expect(
      campaignStore.listAuditEvents().filter(
        (event) =>
          event.requestId === request.requestId &&
          event.action === "campaign.test",
      ),
    ).toHaveLength(1);
  });

  it("writes one accepted test audit without recipient addresses", async () => {
    const adapter = capableAdapter();
    const { application, campaignApplication, campaignStore } =
      createFixture(adapter);
    const created = await createCampaign(campaignApplication);
    const request = {
      actor,
      requestId: "campaign-test-accepted-audit-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    await application.commands.requestTest(request);
    await application.commands.requestTest(request);

    const events = campaignStore.listAuditEvents().filter(
      (event) =>
        event.requestId === request.requestId &&
        event.action === "campaign.test",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: created.campaign.id,
      revisionId: created.revision.id,
      outcome: "accepted",
    });
    expect(JSON.stringify(events)).not.toContain("@example.test");
  });

  it("requires a persisted Owner confirmation and client-owned provisioning evidence for readiness", async () => {
    const adapter = capableAdapter();
    const { application, campaignApplication, campaignStore } = createFixture(
      adapter,
      undefined,
      undefined,
      {
        classification: "client_owned",
        evidenceId: "provisioning-client-owned-1",
        accountScopeFingerprint: "8".repeat(64),
        verifiedAt: "2026-07-29T18:00:00.000Z",
      },
    );
    const created = await createCampaign(campaignApplication);
    const operation = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-readiness-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });

    await expect(
      application.queries.readiness({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.toMatchObject({
      state: "owner_confirmation_required",
      testDeliveryReady: false,
      ownershipEvidenceId: "provisioning-client-owned-1",
    });

    const confirmation = await application.commands.confirmReceipt({
      actor,
      requestId: "campaign-test-confirm-1",
      executionId: operation.executionId,
    });
    expect(confirmation).toMatchObject({
      executionId: operation.executionId,
      ownerActorId: membership.id,
    });
    expect(JSON.stringify(confirmation)).not.toContain("@");
    await expect(
      application.commands.confirmReceipt({
        actor,
        requestId: "campaign-test-confirm-1",
        executionId: operation.executionId,
      }),
    ).resolves.toEqual(confirmation);
    expect(
      campaignStore.listAuditEvents().filter(
        (event) =>
          event.requestId === "campaign-test-confirm-1" &&
          event.action === "campaign.test",
      ),
    ).toEqual([
      expect.objectContaining({
        targetId: operation.executionId,
        revisionId: operation.campaignRevisionId,
        outcome: "accepted",
      }),
    ]);

    await expect(
      application.queries.readiness({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      testDeliveryReady: true,
      ownershipEvidenceId: "provisioning-client-owned-1",
    });
  });

  it("keeps evaluation ownership evidence outside the readiness gate", async () => {
    const { application, campaignApplication } =
      createFixture(capableAdapter());
    const created = await createCampaign(campaignApplication);
    const operation = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-evaluation-readiness-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await application.commands.confirmReceipt({
      actor,
      requestId: "campaign-test-evaluation-confirm-1",
      executionId: operation.executionId,
    });

    await expect(
      application.queries.readiness({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.toMatchObject({
      state: "evaluation_only",
      testDeliveryReady: false,
      ownershipEvidenceId: "provisioning-evaluation-1",
    });
  });

  it("atomically leaves no confirmation when its accepted command receipt fails", async () => {
    const {
      application,
      campaignApplication,
      deliveryStore,
    } = createFixture(
      capableAdapter(),
      undefined,
      undefined,
      {
        classification: "client_owned",
        evidenceId: "provisioning-client-owned-fault-1",
        accountScopeFingerprint: "8".repeat(64),
        verifiedAt: "2026-07-29T18:00:00.000Z",
      },
      undefined,
      true,
    );
    const created = await createCampaign(campaignApplication);
    const operation = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-readiness-fault-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });

    await expect(
      application.commands.confirmReceipt({
        actor,
        requestId: "campaign-test-confirm-fault-1",
        executionId: operation.executionId,
      }),
    ).rejects.toThrow("simulated_confirmation_receipt_failure");
    await expect(
      deliveryStore.findReceiptConfirmation({
        siteId,
        executionId: operation.executionId,
      }),
    ).resolves.toBeNull();
    await expect(
      application.queries.readiness({
        actor,
        campaignId: created.campaign.id,
      }),
    ).resolves.toMatchObject({
      state: "owner_confirmation_required",
      testDeliveryReady: false,
    });
  });

  it("rejects confirmation idempotency reuse for another execution", async () => {
    let executionSequence = 0;
    const { application, campaignApplication } = createFixture(
      capableAdapter(),
      undefined,
      () =>
        `40000000-0000-4000-8000-${String(++executionSequence).padStart(12, "0")}`,
    );
    const firstCampaign = await createCampaign(campaignApplication);
    const secondCampaign = await createCampaign(
      campaignApplication,
      "campaign-create-for-test-2",
    );
    const first = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-confirm-reuse-source-1",
      campaignId: firstCampaign.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    const second = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-confirm-reuse-source-2",
      campaignId: secondCampaign.campaign.id,
      testRecipientIds: ["owner-primary"],
    });
    await application.commands.confirmReceipt({
      actor,
      requestId: "campaign-test-confirm-reused-key-1",
      executionId: first.executionId,
    });

    await expect(
      application.commands.confirmReceipt({
        actor,
        requestId: "campaign-test-confirm-reused-key-1",
        executionId: second.executionId,
      }),
    ).rejects.toMatchObject({
      message: "campaign_idempotency_key_reused",
    });
  });

  it("requires the confirming Owner to be one of the delivered recipient identities", async () => {
    const otherOwner: HumanMembership = {
      ...membership,
      id: createHumanMembershipId("owner-secondary"),
      userId: createHumanUserId("user-owner-secondary"),
      email: "owner-secondary@example.test",
    };
    const { application, campaignApplication, rejectedCommands } =
      createFixture(
        capableAdapter(),
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        otherOwner,
      );
    const created = await createCampaign(campaignApplication);
    const operation = await application.commands.requestTest({
      actor,
      requestId: "campaign-test-owner-match-source-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    });

    await expect(
      application.commands.confirmReceipt({
        actor,
        requestId: "campaign-test-owner-match-confirm-1",
        executionId: operation.executionId,
      }),
    ).rejects.toMatchObject({
      message: "test_confirmation_owner_not_recipient",
    });
    expect(rejectedCommands).toEqual([
      expect.objectContaining({
        reason: "test_confirmation_owner_not_recipient",
        commandName: "campaign.confirm_test_receipt",
      }),
    ]);
  });

  it("audits rejected receipt confirmation without recipient addresses", async () => {
    const {
      application,
      campaignStore,
      rejectedCommands,
    } = createFixture(capableAdapter());

    await expect(
      application.commands.confirmReceipt({
        actor,
        requestId: "campaign-test-confirm-rejected-1",
        executionId: "40000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({ message: "test_delivery_not_accepted" });
    expect(rejectedCommands).toEqual([
      expect.objectContaining({
        requestId: "campaign-test-confirm-rejected-1",
        commandName: "campaign.confirm_test_receipt",
        reason: "test_delivery_not_accepted",
      }),
    ]);
    const events = campaignStore.listAuditEvents().filter(
      (event) => event.requestId === "campaign-test-confirm-rejected-1",
    );
    expect(events).toEqual([
      expect.objectContaining({
        action: "campaign.test",
        outcome: "rejected",
        reason: "test_delivery_not_accepted",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("@");
  });
});

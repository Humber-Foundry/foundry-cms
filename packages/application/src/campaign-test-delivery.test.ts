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
  type NewsletterProviderOwnershipEvidence,
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
) {
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
    providerOwnershipEvidence,
    replayTestCommand: (command) =>
      campaignApplication.commands.replayTestCommand(command),
    recordAcceptedTestCommand: (command) =>
      campaignApplication.commands.recordAcceptedTestCommand(command),
    clock,
    createExecutionId,
    recordRejectedCommand: async (command) => {
      rejectedCommands.push(command);
      await campaignApplication.commands.recordRejectedCommand({
        ...command,
        action: "campaign.test",
        commandName: "campaign.request_test",
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
        code: "provider_rate_limited",
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
      failureCode: "provider_rate_limited",
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
        providerCampaignId: "brevo-campaign-21",
        providerReceipt: "brevo-test-retried-21",
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
      expect.objectContaining({
        executionId: first.executionId,
        providerCampaignId: null,
      }),
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
    const { application, campaignApplication } = createFixture(
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
      providerCampaignId: "brevo-campaign-22",
      providerReceipt: "brevo-test-accepted-22",
    });
    await expect(first).resolves.toMatchObject({ state: "accepted" });
  });

  it("recovers a crashed writer only after a reconciliation quarantine", async () => {
    let now = new Date("2026-07-29T19:05:00.000Z");
    const sendTest = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<never>(() => undefined),
      )
      .mockResolvedValueOnce({
        outcome: "accepted",
        providerCampaignId: "brevo-campaign-23",
        providerReceipt: "brevo-test-accepted-23",
      });
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
      providerCampaignId: null,
      attemptLeaseUntil: "2026-07-29T19:07:01.000Z",
    });
    expect(sendTest).toHaveBeenCalledTimes(1);

    now = new Date("2026-07-29T19:07:02.000Z");
    await expect(
      application.commands.requestTest(request),
    ).resolves.toMatchObject({
      state: "accepted",
      providerCampaignId: "brevo-campaign-23",
    });
    expect(adapter.reconcileTest).toHaveBeenCalledTimes(2);
    expect(sendTest).toHaveBeenCalledTimes(2);
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
      providerCampaignId: "brevo-campaign-24",
      providerReceipt: "brevo-test-accepted-24",
    });
    await first;
  });

  it("cancels an attempting test after a send-affecting edit before recovery", async () => {
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
      requestId: "campaign-test-edit-attempting-1",
      campaignId: created.campaign.id,
      testRecipientIds: ["owner-primary"],
    };

    void application.commands.requestTest(request);
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledTimes(1));
    await campaignApplication.commands.edit({
      actor,
      requestId: "campaign-edit-during-attempting-test-1",
      campaignId: created.campaign.id,
      expectedVersion: 1,
      input: { ...input, subject: "Edited during provider test" },
    });
    now = new Date("2026-07-29T19:06:01.000Z");

    await expect(
      application.commands.requestTest(request),
    ).resolves.toMatchObject({
      state: "cancelled",
      failureCode: "campaign_revision_changed",
    });
    expect(adapter.reconcileTest).not.toHaveBeenCalled();
    expect(sendTest).toHaveBeenCalledTimes(1);
  });

  it("cancels an ambiguous test after an edit without reconciling or retrying", async () => {
    const adapter = capableAdapter({
      sendTest: vi.fn().mockResolvedValue({
        outcome: "ambiguous",
        providerCampaignId: "brevo-campaign-25",
      }),
    });
    const { application, campaignApplication } = createFixture(adapter);
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

    await expect(
      application.commands.requestTest(request),
    ).resolves.toMatchObject({
      state: "cancelled",
      failureCode: "campaign_revision_changed",
    });
    expect(adapter.reconcileTest).not.toHaveBeenCalled();
    expect(adapter.sendTest).toHaveBeenCalledTimes(1);
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
    const { application, campaignApplication } = createFixture(
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
});

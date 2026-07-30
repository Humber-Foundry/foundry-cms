import { describe, expect, it } from "vitest";

import {
  createRichTextDocumentFromPlainText,
  createSiteId,
} from "@foundry/site-definition";

import { createInMemoryCampaignBulkStateStore } from "./in-memory-campaign-bulk-state-store";
import {
  CampaignBulkDeliveryError,
  createCampaignBulkDeliveryApplication,
  type CampaignBulkAudienceRecipient,
  type CampaignBulkArtifactPublisher,
  type CampaignBulkAuditEvent,
  type CampaignBulkDeliveryAdapter,
  type CampaignBulkProviderRequest,
  type CampaignBulkSource,
} from "./campaign-bulk-delivery";
import { renderCampaignRevision } from "./campaign-renderer";
import {
  createCampaignId,
  createCampaignRevisionId,
  type CampaignActor,
} from "./campaign";

const siteId = createSiteId("site_reference");
const campaignId = createCampaignId("00000000-0000-4000-8000-000000000052");
const revisionId = createCampaignRevisionId(
  "00000000-0000-4000-8000-000000000053",
);
const testExecutionId = "00000000-0000-4000-8000-000000000054";
const owner: CampaignActor = {
  binding: { issuer: "https://access.example", subject: "owner" },
  email: "owner@example.com",
  nonce: "owner-nonce",
};
const editor: CampaignActor = {
  binding: { issuer: "https://access.example", subject: "editor" },
  email: "editor@example.com",
  nonce: "editor-nonce",
};

async function source(): Promise<CampaignBulkSource> {
  const value: CampaignBulkSource = {
    campaign: {
      id: campaignId,
      siteId,
      lifecycleState: "draft",
      currentRevisionId: revisionId,
      version: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    revision: {
      id: revisionId,
      siteId,
      campaignId,
      revisionNumber: 1,
      provenance: { kind: "standalone" },
      subject: "Exact tested update",
      previewText: "The exact tested message.",
      callToAction: {
        label: "Read",
        href: "https://example.test/read",
      },
      emailContent: createRichTextDocumentFromPlainText("Exact body"),
      senderIdentityId: "sender_primary",
      complianceFooter: {
        version: "footer-v1",
        content: "Legal footer",
        unsubscribePlaceholder:
          "https://example.test/unsubscribe?token={{foundry.unsubscribe.token}}",
      },
      audienceDefinition: {
        id: "canonical-consent-and-suppression",
        version: 1,
      },
      schemaVersion: "1.3.0",
      rendererVersion: "1".repeat(40),
      createdAt: "2026-08-01T00:00:00.000Z",
      createdByActorId: "membership-editor",
    },
    evidence: {
      executionId: testExecutionId,
      campaignId,
      campaignRevisionId: revisionId,
      campaignFingerprint: "2".repeat(64),
      htmlFingerprint: "3".repeat(64),
      textFingerprint: "4".repeat(64),
      senderFingerprint: "5".repeat(64),
      audienceDefinitionFingerprint: "6".repeat(64),
      complianceFingerprint: "7".repeat(64),
      providerConfigurationFingerprint: "8".repeat(64),
      recipientSetFingerprint: "9".repeat(64),
      providerCampaignId: "brevo-test-52",
      providerMessageId: "brevo-message-52",
      providerReceiptHash: "a".repeat(64),
      acceptedAt: "2026-08-01T00:01:00.000Z",
    },
    confirmation: {
      executionId: testExecutionId,
      siteId,
      ownerActorId: "membership-owner",
      requestId: "confirm-test-receipt-52",
      confirmedAt: "2026-08-01T00:02:00.000Z",
    },
    currentSenderFingerprint: "5".repeat(64),
    currentSender: {
      email: "sender@example.test",
      name: "Foundry Sender",
    },
    currentProviderConfigurationFingerprint: "8".repeat(64),
  };
  const rendered = await renderCampaignRevision(value.revision, 1);
  return {
    ...value,
    evidence: {
      ...value.evidence!,
      campaignFingerprint: rendered.campaignFingerprint,
      htmlFingerprint: rendered.html.fingerprint,
      textFingerprint: rendered.text.fingerprint,
    },
  };
}

const recipient: CampaignBulkAudienceRecipient = {
  subscriberId: "subscriber-1",
  identityKey: "b".repeat(64),
  address: "subscriber@example.test",
};

function fixture(
  options: {
    adapter?: Omit<CampaignBulkDeliveryAdapter, "providerCampaignIdFor">;
    resolveAudience?: (
      call: number,
    ) => ReadonlyArray<CampaignBulkAudienceRecipient>;
    /** Every subscriber the ledger can resolve, eligible or not. */
    knownRecipients?: ReadonlyArray<CampaignBulkAudienceRecipient>;
    applyProviderSuppression?: (input: {
      providerEventId: string;
      recipientIdentityKey: string;
      reason: "unsubscribed" | "hard_bounced" | "complained";
      occurredAt: string;
    }) => Promise<void>;
    artifactPublisher?: CampaignBulkArtifactPublisher;
    loadSource?: (testExecutionId: string) => Promise<CampaignBulkSource>;
    maximumAudienceRecipients?: number;
    /**
     * The deterministic correlation key the adapter under test uses. A real
     * adapter derives it from the operation, so a fixture adapter must report
     * the same value here that its outcomes carry.
     */
    providerCampaignId?: string;
  } = {},
) {
  let now = new Date("2026-08-01T00:03:00.000Z");
  let id = 100;
  let audienceCalls = 0;
  const activeOwners = new Set(["membership-owner"]);
  const activeSubscribers = new Set([recipient.subscriberId]);
  const knownRecipients = options.knownRecipients ?? [recipient];
  let currentRevision = revisionId;
  const providerRequests: CampaignBulkProviderRequest[] = [];
  const recordedSuppressions: Array<{
    providerEventId: string;
    recipientIdentityKey: string;
    reason: string;
    occurredAt: string;
  }> = [];
  const audits: CampaignBulkAuditEvent[] = [];
  const adapter: CampaignBulkDeliveryAdapter = {
    providerCampaignIdFor: () =>
      options.providerCampaignId ?? "provider-campaign-52",
    ...(options.adapter ?? {
      async sendBulk(request: CampaignBulkProviderRequest) {
        providerRequests.push(request);
        return {
          outcome: "accepted" as const,
          providerCampaignId: "provider-campaign-52",
          providerMessageId: "provider-message-52",
        };
      },
      async reconcileBulk() {
        return { outcome: "not_sent" as const };
      },
    }),
  };
  const stateStore = createInMemoryCampaignBulkStateStore({
    currentRevision: () => currentRevision,
    activeOwners,
    activeSubscribers,
  });
  const store = {
    ...stateStore,
    async recordAudit(event: CampaignBulkAuditEvent) {
      audits.push(event);
    },
  };
  const application = createCampaignBulkDeliveryApplication({
    siteId,
    store,
    loadSource: (_campaignId, executionId) =>
      options.loadSource?.(executionId) ?? source(),
    authorizeOwner: async (actor) => {
      if (actor.binding.subject !== "owner") {
        throw new CampaignBulkDeliveryError("owner_required");
      }
      return { id: "membership-owner" };
    },
    identifyActor: (actor) =>
      actor.binding.subject === "owner"
        ? "membership-owner"
        : "membership-editor",
    validateOwnerAuthority: async (ownerActorId) =>
      activeOwners.has(ownerActorId),
    resolveAudience: async () => {
      audienceCalls += 1;
      return options.resolveAudience?.(audienceCalls) ?? [recipient];
    },
    // A negative subscriber state removes that subscriber from the resolved
    // set, exactly as the consent-and-suppression ledger does.
    resolveAudienceByIds: async (subscriberIds) =>
      subscriberIds.flatMap((subscriberId) => {
        const known = knownRecipients.find(
          (candidate) => candidate.subscriberId === subscriberId,
        );
        return known !== undefined && activeSubscribers.has(subscriberId)
          ? [known]
          : [];
      }),
    applyProviderSuppression:
      options.applyProviderSuppression ??
      (async (input) => {
        recordedSuppressions.push(input);
      }),
    artifactPublisher:
      options.artifactPublisher ??
      ({
        async publish() {
          return { outcome: "committed", commitSha: "b".repeat(40) };
        },
        async reconcile() {
          return { outcome: "not_found" };
        },
      } satisfies CampaignBulkArtifactPublisher),
    adapter,
    fingerprintKey: "bulk-delivery-test-fingerprint-key-v1",
    maximumAudienceRecipients: options.maximumAudienceRecipients ?? 1000,
    clock: () => new Date(now),
    createId: () => {
      id += 1;
      return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
    },
  });

  return {
    application,
    activeOwners,
    activeSubscribers,
    audits,
    providerRequests,
    recordedSuppressions,
    advanceTo(value: string) {
      now = new Date(value);
    },
    changeRevision() {
      currentRevision = createCampaignRevisionId(
        "00000000-0000-4000-8000-000000000099",
      );
    },
  };
}

async function authorize(
  application: ReturnType<typeof fixture>["application"],
  requestId = "bulk-authorize-request-0001",
) {
  return application.commands.authorize({
    actor: owner,
    requestId,
    campaignId,
    testExecutionId,
  });
}

describe("campaign bulk delivery", () => {
  it("permits only the authenticated Owner who confirmed the exact successful test", async () => {
    const { application, audits, providerRequests } = fixture();

    await expect(
      application.commands.authorize({
        actor: editor,
        requestId: "bulk-editor-attempt-0001",
        campaignId,
        testExecutionId,
      }),
    ).rejects.toMatchObject({ code: "owner_required" });
    expect(audits).toEqual([
      expect.objectContaining({
        actorId: "membership-editor",
        action: "campaign.bulk.authorize",
        requestId: "bulk-editor-attempt-0001",
        outcome: "rejected",
        reason: "owner_required",
      }),
    ]);

    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-send-now-request-0001",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const executed = await application.scheduler.execute(
      requested.operation.id,
    );

    expect(executed).toMatchObject({
      state: "provider_queued",
      campaignRevisionId: revisionId,
      authorizationId: authorized.authorization.id,
    });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({
      operationId: requested.operation.id,
      recipients: [recipient],
      sendArtifact: expect.objectContaining({
        campaignFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    });
    expect(JSON.stringify(providerRequests[0]!.sendArtifact)).not.toContain(
      recipient.identityKey,
    );
    expect(providerRequests[0]!.sendArtifact).toMatchObject({
      recipientCount: 1,
      complianceVersion: "footer-v1",
      audienceDefinition: {
        id: "canonical-consent-and-suppression",
        version: 1,
      },
    });
  });

  it("replays equal commands and rejects authorization or send substitution", async () => {
    const { application } = fixture();
    const first = await authorize(application);
    const replay = await authorize(application);
    expect(replay).toEqual({ ...first, replayed: true });

    await expect(
      application.commands.authorize({
        actor: owner,
        requestId: "bulk-authorize-request-0001",
        campaignId,
        testExecutionId: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({ code: "bulk_idempotency_key_reused" });

    await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-send-replay-request-1",
      campaignId,
      authorizationId: first.authorization.id,
    });
    await expect(
      application.commands.sendNow({
        actor: owner,
        requestId: "bulk-send-replay-request-1",
        campaignId,
        authorizationId: "00000000-0000-4000-8000-000000000999",
      }),
    ).rejects.toMatchObject({ code: "bulk_authorization_stale" });
  });

  it("does not allow a schedule to coexist with an immediate logical send", async () => {
    const { application } = fixture();
    const authorized = await authorize(application);
    await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-immediate-intent-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    await expect(
      application.commands.activateSchedule({
        actor: owner,
        requestId: "bulk-competing-schedule-request-1",
        campaignId,
        authorizationId: authorized.authorization.id,
        resolvedTime: {
          localDateTime: "2026-08-01T00:10:00",
          ianaTimeZone: "UTC",
          utcOffsetChoice: "+00:00",
          executeAtUtc: "2026-08-01T00:10:00.000Z",
          timeZoneDatabaseVersion: "2026a",
        },
      }),
    ).rejects.toMatchObject({ code: "bulk_send_already_exists" });
  });

  it("revalidates suppression immediately before the provider boundary", async () => {
    const { application, activeSubscribers, providerRequests } = fixture();
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-suppression-send-0001",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    activeSubscribers.delete(recipient.subscriberId);

    await expect(
      application.scheduler.execute(requested.operation.id),
    ).rejects.toMatchObject({ code: "bulk_suppression_changed" });
    expect(providerRequests).toHaveLength(0);
  });

  it("reconciles an ambiguous provider result before retrying the stable send", async () => {
    let sends = 0;
    let reconciles = 0;
    const requests: CampaignBulkProviderRequest[] = [];
    const { application } = fixture({
      providerCampaignId: "provider-campaign-ambiguous",
      adapter: {
        async sendBulk(request) {
          sends += 1;
          requests.push(request);
          return sends === 1
            ? {
                outcome: "ambiguous",
                providerCampaignId: "provider-campaign-ambiguous",
                code: "provider_timeout",
              }
            : {
                outcome: "accepted",
                providerCampaignId: "provider-campaign-ambiguous",
                providerMessageId: null,
              };
        },
        async reconcileBulk(request) {
          reconciles += 1;
          requests.push(request);
          return { outcome: "not_sent" };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-ambiguous-send-0001",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    await expect(
      application.scheduler.execute(requested.operation.id),
    ).resolves.toMatchObject({ state: "ambiguous" });
    await expect(
      application.scheduler.execute(requested.operation.id),
    ).resolves.toMatchObject({ state: "provider_queued" });

    expect({ sends, reconciles }).toEqual({ sends: 2, reconciles: 1 });
    expect(
      new Set(requests.map(({ stableSendKey }) => stableSendKey)).size,
    ).toBe(1);
    expect(new Set(requests.map(({ operationId }) => operationId)).size).toBe(
      1,
    );
  });

  it("lets the scheduler execute only a due Owner-authorized schedule and misses stale work", async () => {
    const { application, advanceTo, providerRequests } = fixture();
    const authorized = await authorize(application);
    await application.commands.activateSchedule({
      actor: owner,
      requestId: "bulk-schedule-activate-0001",
      campaignId,
      authorizationId: authorized.authorization.id,
      resolvedTime: {
        localDateTime: "2026-08-01T00:10:00",
        ianaTimeZone: "UTC",
        utcOffsetChoice: "+00:00",
        executeAtUtc: "2026-08-01T00:10:00.000Z",
        timeZoneDatabaseVersion: "2026a",
      },
    });

    await expect(application.scheduler.claimDue()).resolves.toBeNull();
    advanceTo("2026-08-01T00:11:00.000Z");
    const claimed = await application.scheduler.claimDue();
    expect(claimed).toMatchObject({
      scheduleId: expect.any(String),
      state: "preparing",
    });
    await expect(application.scheduler.claimDue()).resolves.toBeNull();

    // A second executor that cannot present the live lease is refused, so one
    // claimed operation cannot reach the provider twice.
    await expect(
      application.scheduler.execute(claimed!.id),
    ).resolves.toMatchObject({ state: "preparing" });
    expect(providerRequests).toHaveLength(0);

    // The worker that holds the lease presents it and proceeds.
    await expect(
      application.scheduler.execute(claimed!.id, claimed!.leaseToken),
    ).resolves.toMatchObject({ state: "provider_queued" });
    expect(providerRequests).toHaveLength(1);
  });

  it("deduplicates verified delivery facts and rejects event-id substitution", async () => {
    const { application } = fixture();
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-event-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const queued = await application.scheduler.execute(requested.operation.id);
    const event = {
      eventId: "c".repeat(64),
      payloadFingerprint: "d".repeat(64),
      siteId,
      operationId: queued.id,
      providerCampaignId: queued.providerCampaignId!,
      providerMessageId: queued.providerMessageId,
      providerSendProof: queued.providerSendProof!,
      recipientIdentityKey: recipient.identityKey,
      type: "delivered" as const,
      occurredAt: "2026-08-01T00:05:00.000Z",
      receivedAt: "2026-08-01T00:06:00.000Z",
      source: "webhook" as const,
    };

    await expect(application.commands.ingestVerifiedEvent(event)).resolves.toBe(
      "recorded",
    );
    await expect(application.commands.ingestVerifiedEvent(event)).resolves.toBe(
      "duplicate",
    );
    await expect(
      application.commands.ingestVerifiedEvent({
        ...event,
        payloadFingerprint: "e".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "bulk_delivery_event_identity_conflict",
    });
  });

  it("normalizes polled compliance facts and applies negative subscriber state", async () => {
    const suppressions: unknown[] = [];
    const { application } = fixture({
      providerCampaignId: "provider-campaign-poll",
      adapter: {
        async sendBulk() {
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-poll",
            providerMessageId: "provider-message-poll",
          };
        },
        async reconcileBulk() {
          return {
            outcome: "verified",
            providerCampaignId: "provider-campaign-poll",
            providerMessageIds: ["provider-message-poll"],
            facts: [
              {
                providerMessageId: "provider-message-poll",
                recipientIdentityKey: recipient.identityKey,
                type: "complained",
                occurredAt: "2026-08-01T00:08:00.000Z",
              },
            ],
          };
        },
      },
      applyProviderSuppression: async (input) => {
        suppressions.push(input);
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-poll-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const queued = await application.scheduler.execute(requested.operation.id);
    await application.commands.ingestVerifiedEvent({
      eventId: "f".repeat(64),
      payloadFingerprint: "e".repeat(64),
      siteId,
      operationId: queued.id,
      providerCampaignId: queued.providerCampaignId!,
      providerMessageId: queued.providerMessageId,
      providerSendProof: queued.providerSendProof!,
      recipientIdentityKey: recipient.identityKey,
      type: "accepted",
      occurredAt: "2026-08-01T00:07:00.000Z",
      receivedAt: "2026-08-01T00:07:01.000Z",
      source: "webhook",
    });

    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ state: "sent" }),
    ]);
    expect(suppressions).toEqual([
      expect.objectContaining({
        recipientIdentityKey: recipient.identityKey,
        reason: "complained",
        occurredAt: "2026-08-01T00:08:00.000Z",
      }),
    ]);
  });

  it("keeps exact polling evidence unresolved until authenticated webhook proof covers the audience", async () => {
    const { application } = fixture({
      providerCampaignId: "provider-campaign-poll-only",
      adapter: {
        async sendBulk() {
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-poll-only",
            providerMessageId: "provider-message-poll-only",
          };
        },
        async reconcileBulk() {
          return {
            outcome: "verified",
            providerCampaignId: "provider-campaign-poll-only",
            providerMessageIds: ["provider-message-poll-only"],
            facts: [
              {
                providerMessageId: "provider-message-poll-only",
                recipientIdentityKey: recipient.identityKey,
                type: "delivered",
                occurredAt: "2026-08-01T00:08:00.000Z",
              },
            ],
          };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-poll-only-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    await application.scheduler.execute(requested.operation.id);

    const first = await application.scheduler.reconcilePending();
    expect(first).toEqual([
      expect.objectContaining({
        state: "provider_queued",
        providerVerification: {
          providerMessageIds: ["provider-message-poll-only"],
          verifiedAt: expect.any(String),
        },
      }),
    ]);
    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({
        state: "provider_queued",
        providerVerification: first[0]!.providerVerification,
      }),
    ]);
  });

  it("blocks the operation before any provider write when Git publication fails", async () => {
    let publications = 0;
    let publicationShouldFail = true;
    const { application, providerRequests } = fixture({
      artifactPublisher: {
        async reconcile() {
          return { outcome: "not_found" };
        },
        async publish() {
          publications += 1;
          return publicationShouldFail
            ? {
                outcome: "failed",
                code: "github_artifact_publication_failed",
              }
            : { outcome: "committed", commitSha: "d".repeat(40) };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-git-failure-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    await expect(
      application.scheduler.execute(requested.operation.id),
    ).resolves.toMatchObject({
      state: "blocked",
      detail: "github_artifact_publication_failed",
    });
    expect(publications).toBe(1);
    expect(providerRequests).toHaveLength(0);

    publicationShouldFail = false;
    const replay = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-git-failure-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    await expect(
      application.scheduler.execute(replay.operation.id),
    ).resolves.toMatchObject({
      id: requested.operation.id,
      state: "provider_queued",
      sendArtifactCommitSha: "d".repeat(40),
    });
    expect(publications).toBe(2);
    expect(providerRequests).toHaveLength(1);
  });

  it("reuses the persisted Git commit and exact artifact across an ambiguous retry", async () => {
    let publications = 0;
    let publicationReconciliations = 0;
    let sends = 0;
    const requests: CampaignBulkProviderRequest[] = [];
    const { application } = fixture({
      providerCampaignId: "provider-campaign-git-retry",
      artifactPublisher: {
        async reconcile() {
          publicationReconciliations += 1;
          return { outcome: "not_found" };
        },
        async publish() {
          publications += 1;
          return { outcome: "committed", commitSha: "c".repeat(40) };
        },
      },
      adapter: {
        async sendBulk(request) {
          requests.push(request);
          sends += 1;
          return sends === 1
            ? {
                outcome: "ambiguous",
                providerCampaignId: "provider-campaign-git-retry",
                code: "provider_timeout",
              }
            : {
                outcome: "accepted",
                providerCampaignId: "provider-campaign-git-retry",
                providerMessageId: "provider-message-git-retry",
              };
        },
        async reconcileBulk() {
          return { outcome: "not_sent" };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-git-retry-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    const ambiguous = await application.scheduler.execute(
      requested.operation.id,
    );
    const queued = await application.scheduler.execute(requested.operation.id);

    expect(ambiguous).toMatchObject({
      state: "ambiguous",
      sendArtifactCommitSha: "c".repeat(40),
    });
    expect(queued).toMatchObject({
      state: "provider_queued",
      sendArtifactCommitSha: "c".repeat(40),
    });
    expect({ publications, publicationReconciliations, sends }).toEqual({
      publications: 1,
      publicationReconciliations: 1,
      sends: 2,
    });
    expect(requests[1]!.sendArtifact).toEqual(requests[0]!.sendArtifact);
  });

  it("reclaims an expired attempting operation after a process crash", async () => {
    let sends = 0;
    let reconciles = 0;
    const { application, advanceTo } = fixture({
      providerCampaignId: "provider-campaign-reclaimed",
      adapter: {
        async sendBulk() {
          sends += 1;
          if (sends === 1) throw new Error("simulated_process_crash");
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-reclaimed",
            providerMessageId: "provider-message-reclaimed",
          };
        },
        async reconcileBulk() {
          reconciles += 1;
          return { outcome: "not_sent" };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-crash-reclaim-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    await expect(
      application.scheduler.execute(requested.operation.id),
    ).rejects.toThrow("simulated_process_crash");
    advanceTo("2026-08-01T00:09:01.000Z");
    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({
        id: requested.operation.id,
        state: "provider_queued",
      }),
    ]);
    expect({ sends, reconciles }).toEqual({ sends: 2, reconciles: 1 });
  });

  it("loads the authorized test execution exactly and blocks current provider drift", async () => {
    let providerDrifted = false;
    const loadedExecutionIds: string[] = [];
    const { application, providerRequests } = fixture({
      loadSource: async (executionId) => {
        loadedExecutionIds.push(executionId);
        const loaded = await source();
        return providerDrifted
          ? {
              ...loaded,
              currentProviderConfigurationFingerprint: "f".repeat(64),
            }
          : loaded;
      },
    });
    const authorized = await authorize(application);
    providerDrifted = true;

    await expect(
      application.commands.sendNow({
        actor: owner,
        requestId: "bulk-provider-drift-send-request-1",
        campaignId,
        authorizationId: authorized.authorization.id,
      }),
    ).rejects.toMatchObject({ code: "bulk_authorization_stale" });
    expect(new Set(loadedExecutionIds)).toEqual(new Set([testExecutionId]));
    expect(providerRequests).toHaveLength(0);
  });

  it("excludes a recipient suppressed after the first resolution and still sends", async () => {
    const second = {
      subscriberId: "subscriber-2",
      identityKey: "c".repeat(64),
      address: "second@example.test",
    };
    const commits: string[] = [];
    const requests: CampaignBulkProviderRequest[] = [];
    let suppress = () => {};
    const { application, activeSubscribers } = fixture({
      knownRecipients: [recipient, second],
      resolveAudience: () =>
        activeSubscribers.has(second.subscriberId)
          ? [recipient, second]
          : [recipient],
      artifactPublisher: {
        async reconcile() {
          return { outcome: "not_found" };
        },
        async publish({ artifactHash }) {
          commits.push(artifactHash);
          // The second recipient unsubscribes while the artifact commit is in
          // flight: after the snapshot was resolved, before any provider write.
          suppress();
          return {
            outcome: "committed",
            commitSha: String(commits.length).repeat(40),
          };
        },
      },
      adapter: {
        async sendBulk(request) {
          requests.push(request);
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-52",
            providerMessageId: "provider-message-52",
          };
        },
        async reconcileBulk() {
          return { outcome: "not_sent" };
        },
      },
    });
    activeSubscribers.add(second.subscriberId);
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-late-suppression-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    suppress = () => {
      activeSubscribers.delete(second.subscriberId);
      suppress = () => {};
    };
    await expect(
      application.scheduler.execute(requested.operation.id),
    ).rejects.toMatchObject({ code: "bulk_suppression_changed" });
    expect(requests).toHaveLength(0);

    // The Owner's retry must reach the remaining eligible audience rather than
    // stay pinned to the superseded snapshot.
    const sent = await application.scheduler.execute(requested.operation.id);
    expect(sent).toMatchObject({
      id: requested.operation.id,
      state: "provider_queued",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.recipients).toEqual([recipient]);
    expect(requests[0]!.sendArtifact.recipientCount).toBe(1);
    // A replacement audience gets its own commit; the superseded one is kept.
    expect(new Set(commits).size).toBe(2);
    expect(sent.sendArtifactCommitSha).toBe("2".repeat(40));
  });

  it("hands the lease back when preparation fails before any provider write", async () => {
    const { application, activeSubscribers, providerRequests } = fixture();
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-lease-release-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    activeSubscribers.delete(recipient.subscriberId);

    await expect(
      application.scheduler.execute(requested.operation.id),
    ).rejects.toMatchObject({ code: "bulk_suppression_changed" });
    expect(providerRequests).toHaveLength(0);

    // The failed attempt released its lease, so the Owner's retry runs now
    // instead of waiting for an expiry that protects nothing.
    activeSubscribers.add(recipient.subscriberId);
    await expect(
      application.commands.retrySend({
        actor: owner,
        requestId: "bulk-lease-release-retry-1",
        campaignId,
        operationId: requested.operation.id,
      }),
    ).resolves.toMatchObject({
      id: requested.operation.id,
      state: "provider_queued",
    });
    expect(providerRequests).toHaveLength(1);
  });

  it("keeps the dispatched snapshot and artifact immutable once an attempt opened", async () => {
    let audienceCalls = 0;
    const requests: CampaignBulkProviderRequest[] = [];
    const { application } = fixture({
      resolveAudience: () => {
        audienceCalls += 1;
        return [recipient];
      },
      adapter: {
        async sendBulk(request) {
          requests.push(request);
          return {
            outcome: "ambiguous",
            providerCampaignId: "provider-campaign-52",
            code: "provider_timeout",
          };
        },
        async reconcileBulk() {
          return { outcome: "not_sent" };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-immutable-snapshot-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    const first = await application.scheduler.execute(requested.operation.id);
    const second = await application.scheduler.execute(requested.operation.id);

    expect(first).toMatchObject({ state: "ambiguous" });
    expect(second).toMatchObject({ state: "ambiguous" });
    expect(second.audienceSnapshot).toEqual(first.audienceSnapshot);
    expect(second.sendArtifact).toEqual(first.sendArtifact);
    expect(second.sendArtifactCommitSha).toBe(first.sendArtifactCommitSha);
    // The audience is resolved only while no attempt has opened.
    expect(audienceCalls).toBe(1);
    expect(requests[1]!.sendArtifact).toEqual(requests[0]!.sendArtifact);
  });

  it("lets only the authorizing Owner retry a failed send on its exact evidence", async () => {
    let sends = 0;
    let publications = 0;
    const requests: CampaignBulkProviderRequest[] = [];
    const { application, audits } = fixture({
      artifactPublisher: {
        async reconcile() {
          return { outcome: "not_found" };
        },
        async publish() {
          publications += 1;
          return { outcome: "committed", commitSha: "f".repeat(40) };
        },
      },
      adapter: {
        async sendBulk(request) {
          sends += 1;
          requests.push(request);
          return sends === 1
            ? { outcome: "rejected", code: "provider_bulk_send_rejected" }
            : {
                outcome: "accepted",
                providerCampaignId: "provider-campaign-52",
                providerMessageId: "provider-message-52",
              };
        },
        async reconcileBulk() {
          return { outcome: "not_sent" };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-retry-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    await expect(
      application.scheduler.execute(requested.operation.id),
    ).resolves.toMatchObject({
      state: "failed",
      detail: "provider_bulk_send_rejected",
    });

    await expect(
      application.commands.retrySend({
        actor: editor,
        requestId: "bulk-retry-editor-attempt-1",
        campaignId,
        operationId: requested.operation.id,
      }),
    ).rejects.toMatchObject({ code: "owner_required" });
    expect(audits.at(-1)).toMatchObject({
      action: "campaign.bulk.retry_send",
      actorId: "membership-editor",
      outcome: "rejected",
      reason: "owner_required",
    });

    const retried = await application.commands.retrySend({
      actor: owner,
      requestId: "bulk-retry-owner-request-1",
      campaignId,
      operationId: requested.operation.id,
    });

    // The same operation, snapshot and Git commit are reused.
    expect(retried).toMatchObject({
      id: requested.operation.id,
      state: "provider_queued",
      sendArtifactCommitSha: "f".repeat(40),
    });
    expect(publications).toBe(1);
    expect(requests[1]!.sendArtifact).toEqual(requests[0]!.sendArtifact);
    expect(requests[1]!.stableSendKey).toBe(requests[0]!.stableSendKey);
  });

  it("keeps polling a completed send so a lost suppression webhook still lands", async () => {
    const suppressions: Array<{ reason: string }> = [];
    let reconciles = 0;
    const { application } = fixture({
      adapter: {
        async sendBulk() {
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-52",
            providerMessageId: "provider-message-52",
          };
        },
        async reconcileBulk() {
          reconciles += 1;
          return {
            outcome: "verified",
            providerCampaignId: "provider-campaign-52",
            providerMessageIds: ["provider-message-52"],
            facts:
              reconciles === 1
                ? []
                : [
                    {
                      providerMessageId: "provider-message-52",
                      recipientIdentityKey: recipient.identityKey,
                      type: "unsubscribed",
                      occurredAt: "2026-08-01T00:20:00.000Z",
                    },
                  ],
          };
        },
      },
      applyProviderSuppression: async (input) => {
        suppressions.push(input);
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-sent-polling-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const queued = await application.scheduler.execute(requested.operation.id);
    await application.commands.ingestVerifiedEvent({
      eventId: "5".repeat(64),
      payloadFingerprint: "6".repeat(64),
      siteId,
      operationId: queued.id,
      providerCampaignId: queued.providerCampaignId!,
      providerMessageId: queued.providerMessageId,
      providerSendProof: queued.providerSendProof!,
      recipientIdentityKey: recipient.identityKey,
      type: "delivered",
      occurredAt: "2026-08-01T00:07:00.000Z",
      receivedAt: "2026-08-01T00:07:01.000Z",
      source: "webhook",
    });
    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ state: "sent" }),
    ]);
    expect(suppressions).toEqual([]);

    // The recipient later unsubscribes and only the report shows it. A sent
    // campaign is never re-sent, but the fact still reaches suppression.
    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ state: "sent" }),
    ]);
    expect(suppressions).toEqual([
      expect.objectContaining({ reason: "unsubscribed" }),
    ]);
  });

  it("suppresses from a verified webhook once, however often it is retried", async () => {
    const { application, recordedSuppressions } = fixture();
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-webhook-suppression-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const queued = await application.scheduler.execute(requested.operation.id);
    const unsubscribed = {
      eventId: "9".repeat(64),
      payloadFingerprint: "a".repeat(64),
      siteId,
      operationId: queued.id,
      providerCampaignId: queued.providerCampaignId!,
      providerMessageId: queued.providerMessageId,
      providerSendProof: queued.providerSendProof!,
      recipientIdentityKey: recipient.identityKey,
      type: "unsubscribed" as const,
      occurredAt: "2026-08-01T00:09:00.000Z",
      receivedAt: "2026-08-01T00:09:01.000Z",
      source: "webhook" as const,
    };

    await expect(
      application.commands.ingestVerifiedEvent(unsubscribed),
    ).resolves.toBe("recorded");
    // Brevo retries at least once; the retry must not append a second
    // suppression for the same fact.
    await expect(
      application.commands.ingestVerifiedEvent(unsubscribed),
    ).resolves.toBe("duplicate");

    expect(recordedSuppressions).toEqual([
      {
        providerEventId: unsubscribed.eventId,
        recipientIdentityKey: recipient.identityKey,
        reason: "unsubscribed",
        occurredAt: "2026-08-01T00:09:00.000Z",
      },
    ]);
  });

  it("refuses to call a send sent when the provider never attempted it", async () => {
    const { application } = fixture({
      adapter: {
        async sendBulk() {
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-52",
            providerMessageId: "provider-message-52",
          };
        },
        async reconcileBulk() {
          return {
            outcome: "verified",
            providerCampaignId: "provider-campaign-52",
            providerMessageIds: ["provider-message-52"],
            facts: [],
          };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-blocked-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const queued = await application.scheduler.execute(requested.operation.id);

    // Brevo blocked the recipient, so it never attempted the message. The
    // webhook is authentic, but it is not evidence that anyone was reached.
    await expect(
      application.commands.ingestVerifiedEvent({
        eventId: "7".repeat(64),
        payloadFingerprint: "8".repeat(64),
        siteId,
        operationId: queued.id,
        providerCampaignId: queued.providerCampaignId!,
        providerMessageId: queued.providerMessageId,
        providerSendProof: queued.providerSendProof!,
        recipientIdentityKey: recipient.identityKey,
        type: "blocked",
        occurredAt: "2026-08-01T00:08:00.000Z",
        receivedAt: "2026-08-01T00:08:01.000Z",
        source: "webhook",
      }),
    ).resolves.toBe("recorded");

    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ state: "provider_queued" }),
    ]);
  });

  it("finalizes a send whose every recipient hard bounced and suppresses them", async () => {
    const suppressions: Array<{ reason: string; recipientIdentityKey: string }> =
      [];
    const { application } = fixture({
      providerCampaignId: "provider-campaign-bounce",
      adapter: {
        async sendBulk() {
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-bounce",
            providerMessageId: "provider-message-bounce",
          };
        },
        async reconcileBulk() {
          return {
            outcome: "verified",
            providerCampaignId: "provider-campaign-bounce",
            providerMessageIds: ["provider-message-bounce"],
            facts: [
              {
                providerMessageId: "provider-message-bounce",
                recipientIdentityKey: recipient.identityKey,
                type: "hard_bounced",
                occurredAt: "2026-08-01T00:08:00.000Z",
              },
            ],
          };
        },
      },
      applyProviderSuppression: async (input) => {
        suppressions.push(input);
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-hard-bounce-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const queued = await application.scheduler.execute(requested.operation.id);
    await application.commands.ingestVerifiedEvent({
      eventId: "1".repeat(64),
      payloadFingerprint: "2".repeat(64),
      siteId,
      operationId: queued.id,
      providerCampaignId: queued.providerCampaignId!,
      providerMessageId: queued.providerMessageId,
      providerSendProof: queued.providerSendProof!,
      recipientIdentityKey: recipient.identityKey,
      type: "hard_bounced",
      occurredAt: "2026-08-01T00:08:00.000Z",
      receivedAt: "2026-08-01T00:08:01.000Z",
      source: "webhook",
    });

    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ state: "sent" }),
    ]);
    // The authenticated webhook suppressed on ingestion and the polled report
    // suppressed on reconciliation. Each channel carries its own evidence, so
    // each records once; the subscriber's negative state is the same either way.
    expect(
      suppressions.map(({ reason, recipientIdentityKey }) => ({
        reason,
        recipientIdentityKey,
      })),
    ).toEqual([
      { reason: "hard_bounced", recipientIdentityKey: recipient.identityKey },
      { reason: "hard_bounced", recipientIdentityKey: recipient.identityKey },
    ]);
  });

  it("records webhook and polled evidence for one fact as separate evidence", async () => {
    const suppressions: Array<{ providerEventId: string }> = [];
    const { application } = fixture({
      providerCampaignId: "provider-campaign-both",
      adapter: {
        async sendBulk() {
          return {
            outcome: "accepted",
            providerCampaignId: "provider-campaign-both",
            providerMessageId: "provider-message-both",
          };
        },
        async reconcileBulk() {
          return {
            outcome: "verified",
            providerCampaignId: "provider-campaign-both",
            providerMessageIds: ["provider-message-both"],
            facts: [
              {
                providerMessageId: "provider-message-both",
                recipientIdentityKey: recipient.identityKey,
                type: "unsubscribed",
                occurredAt: "2026-08-01T00:08:00.000Z",
              },
            ],
          };
        },
      },
      applyProviderSuppression: async (input) => {
        suppressions.push(input);
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-both-channels-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });
    const queued = await application.scheduler.execute(requested.operation.id);

    // The same provider fact also arrives on the authenticated webhook. A
    // polled row carries no pre-send proof, so it can never stand in for the
    // authenticated evidence that finalizes a send; the two evidence rows are
    // therefore distinct by design rather than a dedup failure. Neither is
    // reported as a payload conflict, and re-ingesting either is a duplicate.
    const webhookEvent = {
      eventId: "3".repeat(64),
      payloadFingerprint: "4".repeat(64),
      siteId,
      operationId: queued.id,
      providerCampaignId: queued.providerCampaignId!,
      providerMessageId: queued.providerMessageId,
      providerSendProof: queued.providerSendProof!,
      recipientIdentityKey: recipient.identityKey,
      type: "unsubscribed" as const,
      occurredAt: "2026-08-01T00:08:00.000Z",
      receivedAt: "2026-08-01T00:08:01.000Z",
      source: "webhook" as const,
    };
    await expect(
      application.commands.ingestVerifiedEvent(webhookEvent),
    ).resolves.toBe("recorded");

    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ state: "sent" }),
    ]);
    await expect(
      application.commands.ingestVerifiedEvent(webhookEvent),
    ).resolves.toBe("duplicate");
    // Polling cannot present a pre-send proof, so a polled fact can never share
    // an identity with the authenticated webhook that also reported it. Each
    // channel therefore suppresses once under its own stable identity.
    expect(suppressions).toHaveLength(2);
    expect(
      new Set(suppressions.map((input) => input.providerEventId)).size,
    ).toBe(2);

    // Reconciling the same report again re-reads the same polled fact. It is
    // already recorded, so it must not append its suppression a second time.
    await expect(application.scheduler.reconcilePending()).resolves.toEqual([
      expect.objectContaining({ state: "sent" }),
    ]);
    expect(suppressions).toHaveLength(2);
  });

  it("refuses an audience above the adapter capacity before committing or sending", async () => {
    let publications = 0;
    const { application, providerRequests } = fixture({
      maximumAudienceRecipients: 2,
      resolveAudience: () => [
        recipient,
        {
          subscriberId: "subscriber-2",
          identityKey: "c".repeat(64),
          address: "second@example.test",
        },
        {
          subscriberId: "subscriber-3",
          identityKey: "d".repeat(64),
          address: "third@example.test",
        },
      ],
      artifactPublisher: {
        async reconcile() {
          return { outcome: "not_found" };
        },
        async publish() {
          publications += 1;
          return { outcome: "committed", commitSha: "e".repeat(40) };
        },
      },
    });
    const authorized = await authorize(application);
    const requested = await application.commands.sendNow({
      actor: owner,
      requestId: "bulk-capacity-send-request-1",
      campaignId,
      authorizationId: authorized.authorization.id,
    });

    await expect(
      application.scheduler.execute(requested.operation.id),
    ).rejects.toMatchObject({ code: "bulk_audience_capacity_exceeded" });
    expect({ publications, providerCalls: providerRequests.length }).toEqual({
      publications: 0,
      providerCalls: 0,
    });
  });

  it("refuses to construct an application without a usable adapter capacity", async () => {
    expect(() => fixture({ maximumAudienceRecipients: 0 })).toThrow(
      "bulk_audience_capacity_invalid",
    );
  });

  it("names which prerequisite an authorization is missing", async () => {
    const noTest = fixture({
      loadSource: async () => ({
        ...(await source()),
        evidence: null,
        confirmation: null,
      }),
    });
    await expect(authorize(noTest.application)).rejects.toMatchObject({
      code: "bulk_test_required",
    });

    const notReviewed = fixture({
      loadSource: async () => ({ ...(await source()), confirmation: null }),
    });
    await expect(authorize(notReviewed.application)).rejects.toMatchObject({
      code: "bulk_test_not_reviewed",
    });

    const staleRevision = fixture({
      loadSource: async () => {
        const loaded = await source();
        return {
          ...loaded,
          campaign: {
            ...loaded.campaign,
            currentRevisionId: createCampaignRevisionId(
              "00000000-0000-4000-8000-000000000098",
            ),
          },
        };
      },
    });
    await expect(authorize(staleRevision.application)).rejects.toMatchObject({
      code: "bulk_test_stale",
    });

    const staleSender = fixture({
      loadSource: async () => ({
        ...(await source()),
        currentSenderFingerprint: "9".repeat(64),
      }),
    });
    await expect(authorize(staleSender.application)).rejects.toMatchObject({
      code: "bulk_test_stale",
    });

    expect(
      [noTest, notReviewed, staleRevision, staleSender].map(
        ({ audits }) => audits.at(-1)?.reason,
      ),
    ).toEqual([
      "bulk_test_required",
      "bulk_test_not_reviewed",
      "bulk_test_stale",
      "bulk_test_stale",
    ]);
  });

  it("rejects authorization evidence belonging to another campaign or site", async () => {
    const foreignCampaign = fixture({
      loadSource: async () => {
        const loaded = await source();
        return {
          ...loaded,
          evidence: {
            ...loaded.evidence!,
            campaignId: createCampaignId(
              "00000000-0000-4000-8000-000000000099",
            ),
          },
        };
      },
    });
    const foreignSite = fixture({
      loadSource: async () => {
        const loaded = await source();
        return {
          ...loaded,
          confirmation: {
            ...loaded.confirmation!,
            siteId: createSiteId("site_other"),
          },
        };
      },
    });
    const foreignOwner = fixture({
      loadSource: async () => {
        const loaded = await source();
        return {
          ...loaded,
          confirmation: {
            ...loaded.confirmation!,
            ownerActorId: "membership-other-owner",
          },
        };
      },
    });

    // No test for this campaign exists, whatever the foreign evidence claims.
    await expect(authorize(foreignCampaign.application)).rejects.toMatchObject({
      code: "bulk_test_required",
    });
    // A confirmation from another installation or another Owner is not this
    // Owner's confirmation that the delivered message was reviewed.
    await expect(authorize(foreignSite.application)).rejects.toMatchObject({
      code: "bulk_test_not_reviewed",
    });
    await expect(authorize(foreignOwner.application)).rejects.toMatchObject({
      code: "bulk_test_not_reviewed",
    });
  });
});

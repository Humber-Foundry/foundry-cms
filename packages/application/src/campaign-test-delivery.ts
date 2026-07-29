import type { SiteId } from "@foundry/site-definition";

import { sha256CanonicalJson, sha256Text } from "./deterministic-hash";
import { AccessDeniedError } from "./human-access";
import { renderCampaignRevision } from "./campaign-renderer";
import {
  CampaignIdempotencyError,
  CampaignNotFoundError,
  CampaignValidationError,
  isCampaignRequestId,
  type CampaignActor,
  type CampaignAuthor,
  type CampaignId,
  type CampaignRevision,
  type CampaignRevisionId,
  type CampaignStore,
  type RenderedCampaign,
} from "./campaign-types";

const fingerprintPattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type NewsletterDeliveryCapabilities = Readonly<{
  provider: string;
  configurationFingerprint: string;
  apiTestDelivery: "supported" | "unsupported";
  explicitRecipients: "supported" | "unsupported";
  ambiguousOutcomeReconciliation: "supported" | "unsupported";
  plainTextArtifact: "supported" | "unsupported";
}>;

export type NewsletterDeliveryHealth = Readonly<{
  state: "healthy" | "degraded" | "unavailable";
  credential: "verified" | "invalid" | "unknown";
  senderIdentity: "verified" | "invalid" | "unknown";
}>;

export type NewsletterTestRecipient = Readonly<{
  id: string;
  address: string;
}>;

export type CampaignTestDeliveryBinding = Readonly<{
  campaignId: CampaignId;
  campaignRevisionId: CampaignRevisionId;
  campaignFingerprint: string;
  htmlFingerprint: string;
  textFingerprint: string;
  senderFingerprint: string;
  audienceDefinitionFingerprint: string;
  complianceFingerprint: string;
  providerConfigurationFingerprint: string;
  recipientSetFingerprint: string;
}>;

export type NewsletterTestRequest = Readonly<{
  executionId: string;
  providerCampaignId: string | null;
  renderedCampaign: RenderedCampaign;
  subject: string;
  previewText: string;
  senderIdentityId: string;
  recipients: ReadonlyArray<NewsletterTestRecipient>;
  binding: CampaignTestDeliveryBinding;
}>;

export type NewsletterTestOutcome =
  | Readonly<{
      outcome: "accepted";
      providerCampaignId: string;
      providerReceipt: string;
    }>
  | Readonly<{
      outcome: "ambiguous";
      providerCampaignId?: string;
    }>
  | Readonly<{ outcome: "rejected"; code: string }>;

export type NewsletterTestReconciliation =
  | NewsletterTestOutcome
  | Readonly<{ outcome: "not_sent"; providerCampaignId: string }>
  | Readonly<{ outcome: "not_found" }>;

export interface NewsletterDeliveryAdapter {
  capabilities(): Promise<NewsletterDeliveryCapabilities>;
  health(): Promise<NewsletterDeliveryHealth>;
  sendTest(input: NewsletterTestRequest): Promise<NewsletterTestOutcome>;
  reconcileTest(input: {
    request: NewsletterTestRequest;
    providerCampaignId: string | null;
  }): Promise<NewsletterTestReconciliation>;
}

export type CampaignTestDeliveryEvidence =
  CampaignTestDeliveryBinding &
  Readonly<{
    executionId: string;
    providerCampaignId: string;
    providerReceiptHash: string;
    acceptedAt: string;
  }>;

export type CampaignTestDeliveryOperation = Readonly<{
  executionId: string;
  siteId: SiteId;
  actorId: string;
  requestId: string;
  campaignId: CampaignId;
  campaignRevisionId: CampaignRevisionId;
  binding: CampaignTestDeliveryBinding;
  recipientIds: ReadonlyArray<string>;
  state: "pending" | "attempting" | "ambiguous" | "accepted" | "failed";
  attemptNumber: number;
  attemptLeaseUntil: string | null;
  providerCampaignId: string | null;
  failureCode: string | null;
  evidence: CampaignTestDeliveryEvidence | null;
  createdAt: string;
  updatedAt: string;
}>;

export interface CampaignTestDeliveryStore {
  findByRequest(input: {
    siteId: SiteId;
    actorId: string;
    requestId: string;
  }): Promise<CampaignTestDeliveryOperation | null>;
  claim(operation: CampaignTestDeliveryOperation):
    Promise<CampaignTestDeliveryOperation>;
  beginAttempt(input: {
    operation: CampaignTestDeliveryOperation;
    now: string;
    leaseUntil: string;
  }): Promise<CampaignTestDeliveryOperation | null>;
  record(operation: CampaignTestDeliveryOperation):
    Promise<CampaignTestDeliveryOperation>;
  findLatestAccepted(input: {
    siteId: SiteId;
    campaignId: CampaignId;
  }): Promise<CampaignTestDeliveryOperation | null>;
}

export type CampaignTestDeliveryApplication = Readonly<{
  commands: Readonly<{
    requestTest(input: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      testRecipientIds: ReadonlyArray<string>;
    }): Promise<CampaignTestDeliveryOperation>;
  }>;
  queries: Readonly<{
    currentEvidence(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
    }): Promise<CampaignTestDeliveryEvidence | null>;
  }>;
}>;

function assertCapabilities(
  capabilities: NewsletterDeliveryCapabilities,
): void {
  if (!fingerprintPattern.test(capabilities.configurationFingerprint)) {
    throw new CampaignValidationError(
      "provider_configuration_fingerprint_invalid",
    );
  }
  if (capabilities.apiTestDelivery !== "supported") {
    throw new CampaignValidationError("provider_test_delivery_unsupported");
  }
  if (capabilities.explicitRecipients !== "supported") {
    throw new CampaignValidationError("provider_test_recipients_unsupported");
  }
  if (capabilities.ambiguousOutcomeReconciliation !== "supported") {
    throw new CampaignValidationError(
      "provider_test_reconciliation_unsupported",
    );
  }
}

function assertRecipientIds(ids: ReadonlyArray<string>): void {
  if (
    ids.length === 0 ||
    ids.length > 10 ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(id),
    )
  ) {
    throw new CampaignValidationError("test_recipient_forbidden");
  }
}

function assertResolvedRecipients(
  requestedIds: ReadonlyArray<string>,
  recipients: ReadonlyArray<NewsletterTestRecipient>,
): void {
  if (
    recipients.length !== requestedIds.length ||
    recipients.some(
      (recipient, index) =>
        recipient.id !== requestedIds[index] ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient.address),
    )
  ) {
    throw new CampaignValidationError("test_recipient_forbidden");
  }
}

async function bindingFor({
  revision,
  rendered,
  providerConfigurationFingerprint,
  recipientIds,
}: {
  revision: CampaignRevision;
  rendered: RenderedCampaign;
  providerConfigurationFingerprint: string;
  recipientIds: ReadonlyArray<string>;
}): Promise<CampaignTestDeliveryBinding> {
  const [
    senderFingerprint,
    audienceDefinitionFingerprint,
    complianceFingerprint,
    recipientSetFingerprint,
  ] = await Promise.all([
    sha256CanonicalJson({
      version: "foundry.campaign-test-sender.v1",
      senderIdentityId: revision.senderIdentityId,
    }),
    sha256CanonicalJson({
      version: "foundry.campaign-test-audience.v1",
      audienceDefinition: revision.audienceDefinition,
    }),
    sha256CanonicalJson({
      version: "foundry.campaign-test-compliance.v1",
      complianceFooter: revision.complianceFooter,
    }),
    sha256CanonicalJson({
      version: "foundry.campaign-test-recipients.v1",
      recipientIds,
    }),
  ]);
  return Object.freeze({
    campaignId: revision.campaignId,
    campaignRevisionId: revision.id,
    campaignFingerprint: rendered.campaignFingerprint,
    htmlFingerprint: rendered.html.fingerprint,
    textFingerprint: rendered.text.fingerprint,
    senderFingerprint,
    audienceDefinitionFingerprint,
    complianceFingerprint,
    providerConfigurationFingerprint,
    recipientSetFingerprint,
  });
}

function sameBinding(
  left: CampaignTestDeliveryBinding,
  right: CampaignTestDeliveryBinding,
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof CampaignTestDeliveryBinding] ===
      right[key as keyof CampaignTestDeliveryBinding],
  );
}

function testRejectionAuditState(reason: string) {
  const state =
    reason === "capability_not_authorized"
      ? {
          current: { authorization: "denied" },
          required: { capability: "campaign.author" },
        }
      : reason === "provider_unhealthy"
        ? {
            current: { providerReadiness: "not_healthy" },
            required: {
              providerHealth: "healthy",
              credential: "verified",
              senderIdentity: "verified",
            },
          }
        : reason.startsWith("provider_test_") ||
            reason.startsWith("provider_configuration_")
          ? {
              current: { providerCapabilities: "unsupported_or_mismatched" },
              required: {
                apiTestDelivery: "supported",
                explicitRecipients: "supported",
                ambiguousOutcomeReconciliation: "supported",
              },
            }
          : reason.startsWith("provider_")
            ? {
                current: { providerDelivery: reason },
                required: {
                  providerDelivery: "accepted_or_safely_reconciled",
                },
              }
          : reason === "test_recipient_forbidden"
            ? {
                current: { recipientConfiguration: "not_allowed" },
                required: { recipientConfiguration: "configured_identity" },
              }
            : reason === "campaign_not_found"
              ? {
                  current: { campaign: "not_found" },
                  required: { campaign: "current_revision_exists" },
                }
              : reason.startsWith("campaign_idempotency_")
                ? {
                    current: { requestIdentity: "invalid_or_conflicting" },
                    required: { requestIdentity: "valid_and_unique" },
                  }
                : {
                    current: { testDelivery: "rejected", reason },
                    required: { testDelivery: "eligible" },
                  };
  return JSON.stringify(state);
}

function validateProviderText(value: string, code: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    !/^[A-Za-z0-9:._-]+$/u.test(normalized)
  ) {
    throw new CampaignValidationError(code);
  }
  return normalized;
}

async function acceptedOperation(
  operation: CampaignTestDeliveryOperation,
  outcome: Extract<NewsletterTestOutcome, { outcome: "accepted" }>,
  timestamp: string,
): Promise<CampaignTestDeliveryOperation> {
  const providerCampaignId = validateProviderText(
    outcome.providerCampaignId,
    "provider_campaign_id_invalid",
  );
  const providerReceiptHash = await sha256Text(outcome.providerReceipt);
  if (outcome.providerReceipt.length === 0) {
    throw new CampaignValidationError("provider_test_evidence_invalid");
  }
  const evidence = Object.freeze({
    ...operation.binding,
    executionId: operation.executionId,
    providerCampaignId,
    providerReceiptHash,
    acceptedAt: timestamp,
  });
  return Object.freeze({
    ...operation,
    state: "accepted" as const,
    attemptLeaseUntil: null,
    providerCampaignId,
    failureCode: null,
    evidence,
    updatedAt: timestamp,
  });
}

export function createCampaignTestDeliveryApplication({
  siteId,
  campaignStore,
  store,
  adapter,
  authorize,
  identifyActor,
  resolveAudience,
  resolveTestRecipients,
  recordRejectedCommand,
  clock = () => new Date(),
  createExecutionId = () => crypto.randomUUID(),
}: {
  siteId: SiteId;
  campaignStore: CampaignStore;
  store: CampaignTestDeliveryStore;
  adapter: NewsletterDeliveryAdapter;
  authorize(
    actor: CampaignActor,
    capability: "campaign.author",
  ): Promise<CampaignAuthor>;
  identifyActor(actor: CampaignActor): string;
  resolveAudience(
    definition: CampaignRevision["audienceDefinition"],
  ): Promise<Readonly<{ eligibleSubscriberCount: number }>>;
  resolveTestRecipients(
    recipientIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<NewsletterTestRecipient>>;
  recordRejectedCommand?(input: {
    actor: CampaignActor;
    requestId: string;
    reason: string;
    command: unknown;
    targetId: string;
    beforeState: string;
  }): Promise<void>;
  clock?: () => Date;
  createExecutionId?: () => string;
}): CampaignTestDeliveryApplication {
  async function currentCampaignRevision(campaignId: CampaignId) {
    const campaign = await campaignStore.findCampaign({ siteId, campaignId });
    if (campaign === null) throw new CampaignNotFoundError();
    const revision = await campaignStore.findRevision({
      siteId,
      campaignId,
      revisionNumber: campaign.version,
    });
    if (revision === null) throw new CampaignNotFoundError();
    return { campaign, revision };
  }

  async function executeRequestTest({
    actor,
    requestId,
    campaignId,
    testRecipientIds,
  }: {
    actor: CampaignActor;
    requestId: string;
    campaignId: CampaignId;
    testRecipientIds: ReadonlyArray<string>;
  }) {
    await authorize(actor, "campaign.author");
    if (!isCampaignRequestId(requestId)) {
      throw new CampaignIdempotencyError("campaign_idempotency_key_invalid");
    }
    assertRecipientIds(testRecipientIds);
    const actorId = identifyActor(actor);
    const capabilities = await adapter.capabilities();
    assertCapabilities(capabilities);
    const health = await adapter.health();
    if (
      health.state !== "healthy" ||
      health.credential !== "verified" ||
      health.senderIdentity !== "verified"
    ) {
      throw new CampaignValidationError("provider_unhealthy");
    }
    const { revision } = await currentCampaignRevision(campaignId);
    const audience = await resolveAudience(revision.audienceDefinition);
    const rendered = await renderCampaignRevision(
      revision,
      audience.eligibleSubscriberCount,
    );
    const binding = await bindingFor({
      revision,
      rendered,
      providerConfigurationFingerprint:
        capabilities.configurationFingerprint,
      recipientIds: testRecipientIds,
    });
    const existing = await store.findByRequest({
      siteId,
      actorId,
      requestId,
    });
    let operation: CampaignTestDeliveryOperation;
    let newlyClaimed = false;
    if (existing === null) {
      const executionId = createExecutionId();
      if (!uuidPattern.test(executionId)) {
        throw new CampaignValidationError("test_execution_id_invalid");
      }
      const timestamp = clock().toISOString();
      operation = await store.claim(
        Object.freeze({
          executionId,
          siteId,
          actorId,
          requestId,
          campaignId,
          campaignRevisionId: revision.id,
          binding,
          recipientIds: Object.freeze([...testRecipientIds]),
          state: "pending" as const,
          attemptNumber: 0,
          attemptLeaseUntil: null,
          providerCampaignId: null,
          failureCode: null,
          evidence: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      newlyClaimed = operation.executionId === executionId;
    } else {
      operation = existing;
    }
    if (
      operation.campaignId !== campaignId ||
      !sameBinding(operation.binding, binding)
    ) {
      throw new CampaignIdempotencyError(
        "campaign_idempotency_key_reused",
      );
    }
    if (operation.state === "accepted" || operation.state === "failed") {
      return operation;
    }
    const now = clock().toISOString();
    const attemptExpired =
      operation.state === "attempting" &&
      operation.attemptLeaseUntil !== null &&
      operation.attemptLeaseUntil <= now;
    if (
      !newlyClaimed &&
      (operation.state === "ambiguous" || attemptExpired)
    ) {
      const recipients = await resolveTestRecipients(operation.recipientIds);
      assertResolvedRecipients(operation.recipientIds, recipients);
      const reconciled = await adapter.reconcileTest({
        request: {
          executionId: operation.executionId,
          providerCampaignId: operation.providerCampaignId,
          renderedCampaign: rendered,
          subject: revision.subject,
          previewText: revision.previewText,
          senderIdentityId: revision.senderIdentityId,
          recipients,
          binding: operation.binding,
        },
        providerCampaignId: operation.providerCampaignId,
      });
      if (reconciled.outcome === "accepted") {
        return store.record(
          await acceptedOperation(
            operation,
            reconciled,
            clock().toISOString(),
          ),
        );
      }
      if (attemptExpired) return operation;
      if (reconciled.outcome === "ambiguous") return operation;
      if (reconciled.outcome === "not_sent") {
        operation = await store.record(
          Object.freeze({
            ...operation,
            state: "ambiguous" as const,
            providerCampaignId: reconciled.providerCampaignId,
            attemptLeaseUntil: null,
            updatedAt: clock().toISOString(),
          }),
        );
      }
      if (
        reconciled.outcome === "not_found" &&
        operation.providerCampaignId !== null
      ) {
        operation = await store.record(
          Object.freeze({
            ...operation,
            state: "ambiguous" as const,
            providerCampaignId: null,
            attemptLeaseUntil: null,
            updatedAt: clock().toISOString(),
          }),
        );
      }
      if (reconciled.outcome === "rejected") {
        return store.record(
          Object.freeze({
            ...operation,
            state: "failed" as const,
            attemptLeaseUntil: null,
            failureCode: reconciled.code,
            updatedAt: clock().toISOString(),
          }),
        );
      }
    }
    if (operation.state === "attempting" && !attemptExpired) {
      return operation;
    }
    const attemptStartedAt = clock();
    const attempt = await store.beginAttempt({
      operation,
      now: attemptStartedAt.toISOString(),
      leaseUntil: new Date(
        attemptStartedAt.getTime() + 60_000,
      ).toISOString(),
    });
    if (attempt === null) {
      return (
        await store.findByRequest({ siteId, actorId, requestId })
      )!;
    }
    operation = attempt;
    const recipients = await resolveTestRecipients(operation.recipientIds);
    assertResolvedRecipients(operation.recipientIds, recipients);
    let outcome: NewsletterTestOutcome;
    try {
      outcome = await adapter.sendTest({
        executionId: operation.executionId,
        providerCampaignId: operation.providerCampaignId,
        renderedCampaign: rendered,
        subject: revision.subject,
        previewText: revision.previewText,
        senderIdentityId: revision.senderIdentityId,
        recipients,
        binding: operation.binding,
      });
    } catch {
      outcome = { outcome: "ambiguous" };
    }
    const timestamp = clock().toISOString();
    if (outcome.outcome === "accepted") {
      return store.record(
        await acceptedOperation(operation, outcome, timestamp),
      );
    }
    if (outcome.outcome === "rejected") {
      return store.record(
        Object.freeze({
          ...operation,
          state: "failed" as const,
          attemptLeaseUntil: null,
          failureCode: outcome.code,
          updatedAt: timestamp,
        }),
      );
    }
    return store.record(
      Object.freeze({
        ...operation,
        state: "ambiguous" as const,
        attemptLeaseUntil: null,
        providerCampaignId:
          outcome.providerCampaignId === undefined
            ? operation.providerCampaignId
            : validateProviderText(
                outcome.providerCampaignId,
                "provider_campaign_id_invalid",
              ),
        updatedAt: timestamp,
      }),
    );
  }

  async function requestTest(
    input: Parameters<typeof executeRequestTest>[0],
  ) {
    try {
      return await executeRequestTest(input);
    } catch (error) {
      if (
        recordRejectedCommand !== undefined &&
        isCampaignRequestId(input.requestId) &&
        (error instanceof CampaignValidationError ||
          error instanceof CampaignIdempotencyError ||
          error instanceof CampaignNotFoundError ||
          error instanceof AccessDeniedError)
      ) {
        await recordRejectedCommand({
          actor: input.actor,
          requestId: input.requestId,
          reason: error.message,
          command: {
            action: "request_test",
            campaignId: input.campaignId,
            testRecipientIds: input.testRecipientIds,
          },
          targetId: input.campaignId,
          beforeState: testRejectionAuditState(error.message),
        });
      }
      throw error;
    }
  }

  return Object.freeze({
    commands: Object.freeze({ requestTest }),
    queries: Object.freeze({
      async currentEvidence({
        actor,
        campaignId,
      }: {
        actor: CampaignActor;
        campaignId: CampaignId;
      }) {
        await authorize(actor, "campaign.author");
        const operation = await store.findLatestAccepted({
          siteId,
          campaignId,
        });
        if (operation?.evidence === null || operation === null) return null;
        const capabilities = await adapter.capabilities();
        assertCapabilities(capabilities);
        const { revision } = await currentCampaignRevision(campaignId);
        const audience = await resolveAudience(revision.audienceDefinition);
        const rendered = await renderCampaignRevision(
          revision,
          audience.eligibleSubscriberCount,
        );
        const currentBinding = await bindingFor({
          revision,
          rendered,
          providerConfigurationFingerprint:
            capabilities.configurationFingerprint,
          recipientIds: operation.recipientIds,
        });
        return sameBinding(operation.binding, currentBinding)
          ? operation.evidence
          : null;
      },
    }),
  });
}

export function createInMemoryCampaignTestDeliveryStore():
  CampaignTestDeliveryStore & {
    list(): ReadonlyArray<CampaignTestDeliveryOperation>;
  } {
  const operations = new Map<string, CampaignTestDeliveryOperation>();
  const requestKey = (operation: {
    siteId: SiteId;
    actorId: string;
    requestId: string;
  }) => `${operation.siteId}:${operation.actorId}:${operation.requestId}`;
  const store: CampaignTestDeliveryStore & {
    list(): ReadonlyArray<CampaignTestDeliveryOperation>;
  } = {
    async findByRequest(input) {
      return operations.get(requestKey(input)) ?? null;
    },
    async claim(operation) {
      const key = requestKey(operation);
      const existing = operations.get(key);
      if (existing !== undefined) return existing;
      operations.set(key, operation);
      return operation;
    },
    async beginAttempt({ operation, now, leaseUntil }) {
      const key = requestKey(operation);
      const current = operations.get(key);
      if (
        current === undefined ||
        current.executionId !== operation.executionId ||
        current.updatedAt !== operation.updatedAt ||
        !(
          current.state === "pending" ||
          current.state === "ambiguous"
        )
      ) {
        return null;
      }
      const attempting = Object.freeze({
        ...current,
        state: "attempting" as const,
        attemptNumber: current.attemptNumber + 1,
        attemptLeaseUntil: leaseUntil,
        updatedAt: now,
      });
      operations.set(key, attempting);
      return attempting;
    },
    async record(operation) {
      const key = requestKey(operation);
      const current = operations.get(key);
      if (
        current === undefined ||
        current.executionId !== operation.executionId ||
        current.attemptNumber !== operation.attemptNumber ||
        current.state === "accepted" ||
        current.state === "failed"
      ) {
        throw new CampaignValidationError("test_delivery_state_conflict");
      }
      operations.set(key, operation);
      return operation;
    },
    async findLatestAccepted({ siteId: requestedSiteId, campaignId }) {
      return (
        [...operations.values()]
          .filter(
            (operation) =>
              operation.siteId === requestedSiteId &&
              operation.campaignId === campaignId &&
              operation.state === "accepted",
          )
          .sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          )[0] ?? null
      );
    },
    list() {
      return [...operations.values()];
    },
  };
  return Object.freeze(store);
}

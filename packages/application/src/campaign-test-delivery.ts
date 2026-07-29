import type { SiteId } from "@foundry/site-definition";

import { sha256CanonicalJson, sha256Text } from "./deterministic-hash";
import { AccessDeniedError } from "./human-access";
import { renderCampaignRevision } from "./campaign-renderer";
import {
  CampaignIdempotencyError,
  CampaignNotFoundError,
  CampaignValidationError,
  isCampaignRequestId,
  type Campaign,
  type CampaignActor,
  type CampaignAuthor,
  type CampaignId,
  type CampaignRevision,
  type CampaignRevisionId,
  type CampaignStore,
  type CampaignTestReceiptConfirmationRecord,
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
      code?: string;
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

export type CampaignTestReceiptConfirmation =
  CampaignTestReceiptConfirmationRecord;

export type NewsletterProviderOwnershipEvidence = Readonly<{
  classification: "evaluation" | "client_owned";
  evidenceId: string;
  accountScopeFingerprint: string;
  verifiedAt: string;
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
  state:
    | "pending"
    | "attempting"
    | "ambiguous"
    | "accepted"
    | "failed"
    | "cancelled";
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
  findByExecution(input: {
    siteId: SiteId;
    executionId: string;
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
  findReceiptConfirmation(input: {
    siteId: SiteId;
    executionId: string;
  }): Promise<CampaignTestReceiptConfirmation | null>;
  reserveDailyRecipientBudget(input: {
    accountScopeFingerprint: string;
    executionId: string;
    attemptNumber: number;
    recipientCount: number;
    budgetDay: string;
    reservedAt: string;
  }): Promise<boolean>;
  cancelForCampaignEdit(input: {
    siteId: SiteId;
    campaignId: CampaignId;
    retainedRevisionId: CampaignRevisionId;
    cancelledAt: string;
  }): Promise<void>;
}

export const maximumCampaignTestRecipients = 5;
export const maximumCampaignTestsPerRevisionWindow = 5;
export const campaignTestRateLimitWindowMs = 60 * 60 * 1_000;
export const maximumProviderTestRecipientsPerDay = 50;

export type CampaignTestDeliveryApplication = Readonly<{
  commands: Readonly<{
    requestTest(input: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      testRecipientIds: ReadonlyArray<string>;
    }): Promise<CampaignTestDeliveryOperation>;
    confirmReceipt(input: {
      actor: CampaignActor;
      requestId: string;
      executionId: string;
    }): Promise<CampaignTestReceiptConfirmation>;
  }>;
  queries: Readonly<{
    currentEvidence(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
    }): Promise<CampaignTestDeliveryEvidence | null>;
    readiness(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
    }): Promise<
      Readonly<{
        state:
          | "evaluation_only"
          | "provider_unhealthy"
          | "live_test_required"
          | "owner_confirmation_required"
          | "ready";
        testDeliveryReady: boolean;
        provider: string;
        configurationFingerprint: string;
        acceptedAt?: string;
        ownershipEvidenceId: string;
      }>
    >;
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
    ids.length > maximumCampaignTestRecipients ||
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
  recipients,
}: {
  revision: CampaignRevision;
  rendered: RenderedCampaign;
  providerConfigurationFingerprint: string;
  recipients: ReadonlyArray<NewsletterTestRecipient>;
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
      version: "foundry.campaign-test-recipients.v2",
      recipients: recipients.map((recipient) => ({
        id: recipient.id,
        address: recipient.address.trim().toLowerCase(),
      })),
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
  if (reason === "capability_not_authorized") {
    return JSON.stringify({
      current: { authorization: "denied" },
      required: { capability: "campaign.author" },
    });
  }
  if (reason === "provider_unhealthy") {
    return JSON.stringify({
      current: { providerReadiness: "not_healthy" },
      required: {
        providerHealth: "healthy",
        credential: "verified",
        senderIdentity: "verified",
      },
    });
  }
  if (
    reason.startsWith("provider_test_") ||
    reason.startsWith("provider_configuration_")
  ) {
    return JSON.stringify({
      current: { providerCapabilities: "unsupported_or_mismatched" },
      required: {
        apiTestDelivery: "supported",
        explicitRecipients: "supported",
        ambiguousOutcomeReconciliation: "supported",
      },
    });
  }
  if (reason.startsWith("provider_")) {
    return JSON.stringify({
      current: { providerDelivery: reason },
      required: { providerDelivery: "accepted_or_safely_reconciled" },
    });
  }
  if (reason === "test_recipient_forbidden") {
    return JSON.stringify({
      current: { recipientConfiguration: "not_allowed" },
      required: { recipientConfiguration: "configured_identity" },
    });
  }
  if (reason === "campaign_not_found") {
    return JSON.stringify({
      current: { campaign: "not_found" },
      required: { campaign: "current_revision_exists" },
    });
  }
  if (reason.startsWith("campaign_idempotency_")) {
    return JSON.stringify({
      current: { requestIdentity: "invalid_or_conflicting" },
      required: { requestIdentity: "valid_and_unique" },
    });
  }
  return JSON.stringify({
    current: { testDelivery: "rejected", reason },
    required: { testDelivery: "eligible" },
  });
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
  providerOwnershipEvidence,
  replayTestCommand,
  recordAcceptedTestCommand,
  recordAcceptedTestReceiptConfirmation,
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
    capability: "campaign.author" | "campaign.test.confirm",
  ): Promise<CampaignAuthor>;
  identifyActor(actor: CampaignActor): string;
  resolveAudience(
    definition: CampaignRevision["audienceDefinition"],
  ): Promise<Readonly<{ eligibleSubscriberCount: number }>>;
  resolveTestRecipients(
    recipientIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<NewsletterTestRecipient>>;
  providerOwnershipEvidence: NewsletterProviderOwnershipEvidence;
  replayTestCommand?(input: {
    actor: CampaignActor;
    requestId: string;
    command: unknown;
    targetId: string;
    commandName?:
      | "campaign.request_test"
      | "campaign.confirm_test_receipt";
  }): Promise<
    Readonly<{ campaign: Campaign; revision: CampaignRevision }> | null
  >;
  recordAcceptedTestCommand?(input: {
    actor: CampaignActor;
    requestId: string;
    command: unknown;
    campaign: Campaign;
    revision: CampaignRevision;
    beforeState: string;
    afterState: string;
    targetId?: string;
    commandName?:
      | "campaign.request_test"
      | "campaign.confirm_test_receipt";
  }): Promise<void>;
  recordAcceptedTestReceiptConfirmation(input: {
    actor: CampaignActor;
    requestId: string;
    command: unknown;
    campaign: Campaign;
    revision: CampaignRevision;
    beforeState: string;
    afterState: string;
    targetId: string;
    confirmation: CampaignTestReceiptConfirmation;
  }): Promise<void>;
  recordRejectedCommand?(input: {
    actor: CampaignActor;
    requestId: string;
    reason: string;
    command: unknown;
    targetId: string;
    beforeState: string;
    commandName?:
      | "campaign.request_test"
      | "campaign.confirm_test_receipt";
  }): Promise<void>;
  clock?: () => Date;
  createExecutionId?: () => string;
}): CampaignTestDeliveryApplication {
  if (
    !fingerprintPattern.test(
      providerOwnershipEvidence.accountScopeFingerprint,
    ) ||
    providerOwnershipEvidence.evidenceId.length === 0 ||
    providerOwnershipEvidence.evidenceId.length > 200 ||
    !/^[A-Za-z0-9:._-]+$/u.test(providerOwnershipEvidence.evidenceId) ||
    Number.isNaN(Date.parse(providerOwnershipEvidence.verifiedAt))
  ) {
    throw new CampaignValidationError("provider_ownership_evidence_invalid");
  }
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

  async function recordOperation(
    operation: CampaignTestDeliveryOperation,
  ): Promise<CampaignTestDeliveryOperation> {
    try {
      return await store.record(operation);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/^(campaign_)?test_delivery_state_conflict$/u.test(error.message)
      ) {
        throw error;
      }
      const current = await store.findByRequest({
        siteId: operation.siteId,
        actorId: operation.actorId,
        requestId: operation.requestId,
      });
      if (
        current !== null &&
        (current.state === "accepted" ||
          current.state === "failed" ||
          current.state === "cancelled" ||
          current.attemptNumber !== operation.attemptNumber ||
          current.updatedAt !== operation.updatedAt)
      ) {
        return current;
      }
      throw error;
    }
  }

  async function executeRequestTest(
    {
      actor,
      requestId,
      campaignId,
      testRecipientIds,
    }: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      testRecipientIds: ReadonlyArray<string>;
    },
    commandState: { accepted: boolean },
  ) {
    await authorize(actor, "campaign.author");
    if (!isCampaignRequestId(requestId)) {
      throw new CampaignIdempotencyError("campaign_idempotency_key_invalid");
    }
    assertRecipientIds(testRecipientIds);
    const actorId = identifyActor(actor);
    const command = {
      action: "request_test",
      campaignId,
      testRecipientIds,
    } as const;
    const replayedCommand = (
      await replayTestCommand?.({
        actor,
        requestId,
        command,
        targetId: campaignId,
      })
    ) ?? null;
    commandState.accepted = replayedCommand !== null;
    const existing = await store.findByRequest({
      siteId,
      actorId,
      requestId,
    });
    if (
      replayedCommand !== null &&
      (existing?.state === "accepted" ||
        existing?.state === "failed" ||
        existing?.state === "cancelled")
    ) {
      return existing;
    }
    const current = await currentCampaignRevision(campaignId);
    if (
      existing !== null &&
      existing.campaignRevisionId !== current.revision.id
    ) {
      commandState.accepted = replayedCommand !== null;
      return recordOperation(
        Object.freeze({
          ...existing,
          state: "cancelled" as const,
          attemptLeaseUntil: null,
          failureCode: "campaign_revision_changed",
          updatedAt: clock().toISOString(),
        }),
      );
    }
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
    const { campaign, revision } = current;
    const audience = await resolveAudience(revision.audienceDefinition);
    const rendered = await renderCampaignRevision(
      revision,
      audience.eligibleSubscriberCount,
    );
    const configuredRecipients =
      await resolveTestRecipients(testRecipientIds);
    assertResolvedRecipients(testRecipientIds, configuredRecipients);
    const binding = await bindingFor({
      revision,
      rendered,
      providerConfigurationFingerprint:
        capabilities.configurationFingerprint,
      recipients: configuredRecipients,
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
    await recordAcceptedTestCommand?.({
      actor,
      requestId,
      command,
      campaign,
      revision,
      beforeState: JSON.stringify({
        current: {
          testDelivery:
            existing === null ? "not_started" : existing.state,
        },
        required: { testDelivery: "eligible" },
      }),
      afterState: JSON.stringify({
        executionId: operation.executionId,
        campaignRevisionId: operation.campaignRevisionId,
        state: operation.state,
        campaignFingerprint: operation.binding.campaignFingerprint,
        providerConfigurationFingerprint:
          operation.binding.providerConfigurationFingerprint,
        recipientSetFingerprint:
          operation.binding.recipientSetFingerprint,
      }),
    });
    commandState.accepted = true;
    if (
      operation.state === "accepted" ||
      operation.state === "failed" ||
      operation.state === "cancelled"
    ) {
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
      const reconciled = await adapter.reconcileTest({
        request: {
          executionId: operation.executionId,
          providerCampaignId: operation.providerCampaignId,
          renderedCampaign: rendered,
          subject: revision.subject,
          previewText: revision.previewText,
          senderIdentityId: revision.senderIdentityId,
          recipients: configuredRecipients,
          binding: operation.binding,
        },
        providerCampaignId: operation.providerCampaignId,
      });
      const postReconcileOperation = await store.findByRequest({
        siteId,
        actorId,
        requestId,
      });
      if (
        postReconcileOperation !== null &&
        (postReconcileOperation.state === "accepted" ||
          postReconcileOperation.state === "failed" ||
          postReconcileOperation.state === "cancelled" ||
          postReconcileOperation.updatedAt !== operation.updatedAt)
      ) {
        return postReconcileOperation;
      }
      if (reconciled.outcome === "accepted") {
        return recordOperation(
          await acceptedOperation(
            operation,
            reconciled,
            clock().toISOString(),
          ),
        );
      }
      if (attemptExpired) {
        const recoveryStartedAt = clock();
        return recordOperation(
          Object.freeze({
            ...operation,
            state: "ambiguous" as const,
            attemptLeaseUntil: new Date(
              recoveryStartedAt.getTime() + 60_000,
            ).toISOString(),
            providerCampaignId:
              reconciled.outcome === "not_found"
                ? null
                : reconciled.outcome === "not_sent"
                  ? reconciled.providerCampaignId
                  : reconciled.outcome === "ambiguous" &&
                      reconciled.providerCampaignId !== undefined
                    ? validateProviderText(
                        reconciled.providerCampaignId,
                        "provider_campaign_id_invalid",
                      )
                    : operation.providerCampaignId,
            failureCode:
              reconciled.outcome === "ambiguous"
                ? (reconciled.code ?? operation.failureCode)
                : operation.failureCode,
            updatedAt: recoveryStartedAt.toISOString(),
          }),
        );
      }
      if (
        operation.state === "ambiguous" &&
        operation.attemptLeaseUntil !== null &&
        operation.attemptLeaseUntil > now
      ) {
        return operation;
      }
      if (reconciled.outcome === "ambiguous") {
        if (
          reconciled.code === undefined ||
          reconciled.code === operation.failureCode
        ) {
          return operation;
        }
        return recordOperation(
          Object.freeze({
            ...operation,
            failureCode: reconciled.code,
            updatedAt: clock().toISOString(),
          }),
        );
      }
      if (reconciled.outcome === "not_sent") {
        operation = await recordOperation(
          Object.freeze({
            ...operation,
            state: "ambiguous" as const,
            providerCampaignId: reconciled.providerCampaignId,
            attemptLeaseUntil: null,
            failureCode: null,
            updatedAt: clock().toISOString(),
          }),
        );
      }
      if (
        reconciled.outcome === "not_found" &&
        operation.providerCampaignId !== null
      ) {
        operation = await recordOperation(
          Object.freeze({
            ...operation,
            state: "ambiguous" as const,
            providerCampaignId: null,
            attemptLeaseUntil: null,
            failureCode: null,
            updatedAt: clock().toISOString(),
          }),
        );
      }
      if (reconciled.outcome === "rejected") {
        return recordOperation(
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
    const latest = await currentCampaignRevision(campaignId);
    if (latest.revision.id !== operation.campaignRevisionId) {
      return recordOperation(
        Object.freeze({
          ...operation,
          state: "cancelled" as const,
          attemptLeaseUntil: null,
          failureCode: "campaign_revision_changed",
          updatedAt: clock().toISOString(),
        }),
      );
    }
    const budgetReserved = await store.reserveDailyRecipientBudget({
      accountScopeFingerprint:
        providerOwnershipEvidence.accountScopeFingerprint,
      executionId: operation.executionId,
      attemptNumber: operation.attemptNumber,
      recipientCount: configuredRecipients.length,
      budgetDay: attemptStartedAt.toISOString().slice(0, 10),
      reservedAt: attemptStartedAt.toISOString(),
    });
    if (!budgetReserved) {
      return recordOperation(
        Object.freeze({
          ...operation,
          state: "failed" as const,
          attemptLeaseUntil: null,
          failureCode: "provider_test_daily_recipient_limit",
          updatedAt: clock().toISOString(),
        }),
      );
    }
    let outcome: NewsletterTestOutcome;
    try {
      outcome = await adapter.sendTest({
        executionId: operation.executionId,
        providerCampaignId: operation.providerCampaignId,
        renderedCampaign: rendered,
        subject: revision.subject,
        previewText: revision.previewText,
        senderIdentityId: revision.senderIdentityId,
        recipients: configuredRecipients,
        binding: operation.binding,
      });
    } catch {
      outcome = { outcome: "ambiguous" };
    }
    const postWriteOperation = await store.findByRequest({
      siteId,
      actorId,
      requestId,
    });
    if (postWriteOperation?.state === "cancelled") {
      return postWriteOperation;
    }
    const timestamp = clock().toISOString();
    if (outcome.outcome === "accepted") {
      return recordOperation(
        await acceptedOperation(operation, outcome, timestamp),
      );
    }
    if (outcome.outcome === "rejected") {
      return recordOperation(
        Object.freeze({
          ...operation,
          state: "failed" as const,
          attemptLeaseUntil: null,
          failureCode: outcome.code,
          updatedAt: timestamp,
        }),
      );
    }
    return recordOperation(
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
        failureCode: outcome.code ?? null,
        updatedAt: timestamp,
      }),
    );
  }

  async function requestTest(
    input: Parameters<typeof executeRequestTest>[0],
  ) {
    const commandState = { accepted: false };
    try {
      return await executeRequestTest(input, commandState);
    } catch (error) {
      if (
        recordRejectedCommand !== undefined &&
        !commandState.accepted &&
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

  async function currentEvidenceFor(campaignId: CampaignId) {
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
    let configuredRecipients: ReadonlyArray<NewsletterTestRecipient>;
    try {
      configuredRecipients =
        await resolveTestRecipients(operation.recipientIds);
      assertResolvedRecipients(operation.recipientIds, configuredRecipients);
    } catch (error) {
      if (
        error instanceof CampaignValidationError &&
        error.message === "test_recipient_forbidden"
      ) {
        return null;
      }
      throw error;
    }
    const currentBinding = await bindingFor({
      revision,
      rendered,
      providerConfigurationFingerprint:
        capabilities.configurationFingerprint,
      recipients: configuredRecipients,
    });
    return sameBinding(operation.binding, currentBinding)
      ? operation.evidence
      : null;
  }

  async function confirmReceipt({
    actor,
    requestId,
    executionId,
  }: {
    actor: CampaignActor;
    requestId: string;
    executionId: string;
  }) {
    const command = {
      action: "confirm_test_receipt",
      executionId,
    } as const;
    let accepted = false;
    try {
      const owner = await authorize(actor, "campaign.test.confirm");
      if (!isCampaignRequestId(requestId)) {
        throw new CampaignIdempotencyError("campaign_idempotency_key_invalid");
      }
      if (!uuidPattern.test(executionId)) {
        throw new CampaignValidationError("test_execution_id_invalid");
      }
      const replayed = (
        await replayTestCommand?.({
          actor,
          requestId,
          command,
          targetId: executionId,
          commandName: "campaign.confirm_test_receipt",
        })
      ) ?? null;
      if (replayed !== null) {
        const confirmation = await store.findReceiptConfirmation({
          siteId,
          executionId,
        });
        if (confirmation === null) {
          throw new CampaignValidationError(
            "test_receipt_confirmation_missing",
          );
        }
        return confirmation;
      }
      const operation = await store.findByExecution({ siteId, executionId });
      if (operation?.state !== "accepted" || operation.evidence === null) {
        throw new CampaignValidationError("test_delivery_not_accepted");
      }
      if (!operation.recipientIds.includes(owner.id)) {
        throw new CampaignValidationError(
          "test_confirmation_owner_not_recipient",
        );
      }
      const current = await currentCampaignRevision(operation.campaignId);
      if (current.revision.id !== operation.campaignRevisionId) {
        throw new CampaignValidationError("test_delivery_not_current");
      }
      const existing = await store.findReceiptConfirmation({
        siteId,
        executionId,
      });
      if (existing !== null && existing.requestId !== requestId) {
        throw new CampaignValidationError(
          "test_receipt_already_confirmed",
        );
      }
      const confirmation = Object.freeze({
        executionId,
        siteId,
        ownerActorId: owner.id,
        requestId,
        confirmedAt: clock().toISOString(),
      });
      await recordAcceptedTestReceiptConfirmation({
        actor,
        requestId,
        command,
        campaign: current.campaign,
        revision: current.revision,
        beforeState: JSON.stringify({
          current: { ownerReceiptConfirmation: "unconfirmed" },
          required: { ownerReceiptConfirmation: "confirmed" },
        }),
        afterState: JSON.stringify({
          executionId,
          ownerReceiptConfirmation: "confirmed",
        }),
        targetId: executionId,
        confirmation,
      });
      accepted = true;
      const storedConfirmation = await store.findReceiptConfirmation({
        siteId,
        executionId,
      });
      if (storedConfirmation === null) {
        throw new CampaignValidationError(
          "test_receipt_confirmation_missing",
        );
      }
      return storedConfirmation;
    } catch (error) {
      if (
        recordRejectedCommand !== undefined &&
        !accepted &&
        isCampaignRequestId(requestId) &&
        (error instanceof CampaignValidationError ||
          error instanceof CampaignIdempotencyError ||
          error instanceof CampaignNotFoundError ||
          error instanceof AccessDeniedError)
      ) {
        await recordRejectedCommand({
          actor,
          requestId,
          reason: error.message,
          command,
          targetId: executionId,
          beforeState: JSON.stringify({
            current: { ownerReceiptConfirmation: "not_accepted" },
            required: { ownerReceiptConfirmation: "accepted_test" },
          }),
          commandName: "campaign.confirm_test_receipt",
        });
      }
      throw error;
    }
  }

  return Object.freeze({
    commands: Object.freeze({ requestTest, confirmReceipt }),
    queries: Object.freeze({
      async currentEvidence({
        actor,
        campaignId,
      }: {
        actor: CampaignActor;
        campaignId: CampaignId;
      }) {
        await authorize(actor, "campaign.author");
        return currentEvidenceFor(campaignId);
      },
      async readiness({
        actor,
        campaignId,
      }: {
        actor: CampaignActor;
        campaignId: CampaignId;
      }) {
        await authorize(actor, "campaign.author");
        const capabilities = await adapter.capabilities();
        const health = await adapter.health();
        const base = {
          provider: capabilities.provider,
          configurationFingerprint:
            capabilities.configurationFingerprint,
          ownershipEvidenceId: providerOwnershipEvidence.evidenceId,
        };
        if (providerOwnershipEvidence.classification !== "client_owned") {
          return Object.freeze({
            ...base,
            state: "evaluation_only" as const,
            testDeliveryReady: false,
          });
        }
        if (
          health.state !== "healthy" ||
          health.credential !== "verified" ||
          health.senderIdentity !== "verified"
        ) {
          return Object.freeze({
            ...base,
            state: "provider_unhealthy" as const,
            testDeliveryReady: false,
          });
        }
        const evidence = await currentEvidenceFor(campaignId);
        if (evidence === null) {
          return Object.freeze({
            ...base,
            state: "live_test_required" as const,
            testDeliveryReady: false,
          });
        }
        const confirmation = await store.findReceiptConfirmation({
          siteId,
          executionId: evidence.executionId,
        });
        if (confirmation === null) {
          return Object.freeze({
            ...base,
            state: "owner_confirmation_required" as const,
            testDeliveryReady: false,
          });
        }
        return Object.freeze({
          ...base,
          state: "ready" as const,
          testDeliveryReady: true,
          acceptedAt: evidence.acceptedAt,
        });
      },
    }),
  });
}

export function createInMemoryCampaignTestDeliveryStore():
  CampaignTestDeliveryStore & {
    list(): ReadonlyArray<CampaignTestDeliveryOperation>;
    persistReceiptConfirmation(
      confirmation: CampaignTestReceiptConfirmation,
    ): Promise<CampaignTestReceiptConfirmation>;
  } {
  const operations = new Map<string, CampaignTestDeliveryOperation>();
  const confirmations = new Map<string, CampaignTestReceiptConfirmation>();
  const confirmationRequests = new Map<string, string>();
  const dailyRecipientReservations = new Map<string, number>();
  const requestKey = (operation: {
    siteId: SiteId;
    actorId: string;
    requestId: string;
  }) => `${operation.siteId}:${operation.actorId}:${operation.requestId}`;
  const store: CampaignTestDeliveryStore & {
    list(): ReadonlyArray<CampaignTestDeliveryOperation>;
    persistReceiptConfirmation(
      confirmation: CampaignTestReceiptConfirmation,
    ): Promise<CampaignTestReceiptConfirmation>;
  } = {
    async findByRequest(input) {
      return operations.get(requestKey(input)) ?? null;
    },
    async findByExecution({ siteId: requestedSiteId, executionId }) {
      return (
        [...operations.values()].find(
          (operation) =>
            operation.siteId === requestedSiteId &&
            operation.executionId === executionId,
        ) ?? null
      );
    },
    async claim(operation) {
      const key = requestKey(operation);
      const existing = operations.get(key);
      if (existing !== undefined) return existing;
      if (
        [...operations.values()].some(
          (current) =>
            current.siteId === operation.siteId &&
            current.campaignRevisionId === operation.campaignRevisionId &&
            (current.state === "pending" ||
              current.state === "attempting" ||
              current.state === "ambiguous"),
        )
      ) {
        throw new CampaignValidationError("test_delivery_in_progress");
      }
      const windowStart = new Date(
        new Date(operation.createdAt).getTime() -
          campaignTestRateLimitWindowMs,
      ).toISOString();
      if (
        [...operations.values()].filter(
          (current) =>
            current.siteId === operation.siteId &&
            current.campaignRevisionId === operation.campaignRevisionId &&
            current.createdAt >= windowStart,
        ).length >= maximumCampaignTestsPerRevisionWindow
      ) {
        throw new CampaignValidationError("test_delivery_rate_limited");
      }
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
          (current.state === "ambiguous" &&
            (current.attemptLeaseUntil === null ||
              current.attemptLeaseUntil <= now))
        )
      ) {
        return null;
      }
      const attempting = Object.freeze({
        ...current,
        state: "attempting" as const,
        attemptNumber: current.attemptNumber + 1,
        attemptLeaseUntil: leaseUntil,
        failureCode: null,
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
        current.state === "failed" ||
        current.state === "cancelled"
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
    async persistReceiptConfirmation(confirmation) {
      const key = `${confirmation.siteId}:${confirmation.executionId}`;
      const requestKey =
        `${confirmation.siteId}:${confirmation.ownerActorId}:` +
        confirmation.requestId;
      const requestExecution = confirmationRequests.get(requestKey);
      if (
        requestExecution !== undefined &&
        requestExecution !== confirmation.executionId
      ) {
        throw new CampaignIdempotencyError(
          "campaign_idempotency_key_reused",
        );
      }
      const existing = confirmations.get(key);
      if (existing !== undefined) {
        if (
          existing.requestId !== confirmation.requestId ||
          existing.ownerActorId !== confirmation.ownerActorId
        ) {
          throw new CampaignValidationError(
            "test_receipt_already_confirmed",
          );
        }
        return existing;
      }
      const operation = [...operations.values()].find(
        (candidate) =>
          candidate.siteId === confirmation.siteId &&
          candidate.executionId === confirmation.executionId,
      );
      if (operation?.state !== "accepted") {
        throw new CampaignValidationError("test_delivery_not_accepted");
      }
      confirmations.set(key, confirmation);
      confirmationRequests.set(requestKey, confirmation.executionId);
      return confirmation;
    },
    async findReceiptConfirmation({ siteId: requestedSiteId, executionId }) {
      return confirmations.get(`${requestedSiteId}:${executionId}`) ?? null;
    },
    async reserveDailyRecipientBudget(input) {
      const reservationKey =
        `${input.accountScopeFingerprint}:${input.budgetDay}:` +
        `${input.executionId}:${input.attemptNumber}`;
      if (dailyRecipientReservations.has(reservationKey)) return true;
      const budgetPrefix =
        `${input.accountScopeFingerprint}:${input.budgetDay}:`;
      const used = [...dailyRecipientReservations.entries()]
        .filter(([key]) => key.startsWith(budgetPrefix))
        .reduce((total, [, count]) => total + count, 0);
      if (
        input.recipientCount < 1 ||
        input.recipientCount > maximumCampaignTestRecipients ||
        used + input.recipientCount > maximumProviderTestRecipientsPerDay
      ) {
        return false;
      }
      dailyRecipientReservations.set(reservationKey, input.recipientCount);
      return true;
    },
    async cancelForCampaignEdit({
      siteId: requestedSiteId,
      campaignId,
      retainedRevisionId,
      cancelledAt,
    }) {
      for (const [key, operation] of operations) {
        if (
          operation.siteId === requestedSiteId &&
          operation.campaignId === campaignId &&
          operation.campaignRevisionId !== retainedRevisionId &&
          (operation.state === "pending" ||
            operation.state === "attempting" ||
            operation.state === "ambiguous")
        ) {
          operations.set(
            key,
            Object.freeze({
              ...operation,
              state: "cancelled" as const,
              attemptLeaseUntil: null,
              failureCode: "campaign_revision_changed",
              updatedAt: cancelledAt,
            }),
          );
        }
      }
    },
    list() {
      return [...operations.values()];
    },
  };
  return Object.freeze(store);
}

import type { SiteId } from "@foundry/site-definition";

import {
  canonicalJson,
  hmacSha256CanonicalJson,
  sha256CanonicalJson,
  sha256Text,
} from "./deterministic-hash";
import { renderCampaignRevision } from "./campaign-renderer";
import type {
  Campaign,
  CampaignActor,
  CampaignId,
  CampaignRevision,
  CampaignRevisionId,
  CampaignTestDeliveryEvidence,
  CampaignTestReceiptConfirmation,
} from "./campaign";

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{15,199}$/u;
/**
 * How long after a send completes its provider report is still polled. A
 * completed send is finished, but an unsubscribe or bounce whose webhook was
 * lost must still reach the suppression ledger, and polling is the backstop.
 */
const sentReportingWindowMs = 30 * 24 * 60 * 60_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type CampaignBulkAuthorization = Readonly<{
  id: string;
  siteId: SiteId;
  campaignId: CampaignId;
  campaignRevisionId: CampaignRevisionId;
  campaignFingerprint: string;
  testExecutionId: string;
  testProviderReceiptHash: string;
  testHtmlFingerprint: string;
  testTextFingerprint: string;
  testSenderFingerprint: string;
  testProviderConfigurationFingerprint: string;
  authorizationFingerprint: string;
  ownerActorId: string;
  state: "active" | "consumed" | "invalidated";
  authorizedAt: string;
  invalidatedAt: string | null;
}>;

/**
 * The human's civil time, the offset they chose for an ambiguous local time,
 * and the single UTC instant resolved from both. Execution reads only
 * `executeAtUtc`; the rest explains what the human actually asked for.
 */
export type CampaignBulkResolvedTime = Readonly<{
  localDateTime: string;
  ianaTimeZone: string;
  utcOffsetChoice: string;
  executeAtUtc: string;
  timeZoneDatabaseVersion: string;
}>;

export type CampaignBulkSchedule = CampaignBulkResolvedTime &
  Readonly<{
    id: string;
    siteId: SiteId;
    campaignId: CampaignId;
    authorizationId: string;
    activatedBy: string;
    state:
      | "active"
      | "claimed"
      | "completed"
      | "cancelled"
      | "blocked"
      | "missed";
    createdAt: string;
    updatedAt: string;
  }>;

export type CampaignBulkAudienceRecipient = Readonly<{
  subscriberId: string;
  identityKey: string;
  address: string;
}>;

export type CampaignBulkAudienceSnapshot = Readonly<{
  id: string;
  fingerprint: string;
  subscriberIds: ReadonlyArray<string>;
  recipients: ReadonlyArray<CampaignBulkAudienceRecipient>;
  recipientCount: number;
  resolvedAt: string;
}>;

export type CampaignBulkSendArtifact = Readonly<{
  version: "foundry.campaign-bulk-send-artifact.v2";
  operationId: string;
  stableSendKey: string;
  siteId: SiteId;
  campaignId: CampaignId;
  campaignRevisionId: CampaignRevisionId;
  authorizationId: string;
  authorizationFingerprint: string;
  campaignFingerprint: string;
  senderIdentityId: string;
  sender: Readonly<{ email: string; name: string }>;
  senderFingerprint: string;
  providerConfigurationFingerprint: string;
  complianceVersion: string;
  audienceDefinition: Readonly<{ id: string; version: number }>;
  scheduledInstant: string | null;
  recipientCount: number;
  subject: string;
  htmlContent: string;
  textContent: string;
  htmlFingerprint: string;
  textFingerprint: string;
  audienceFingerprint: string;
}>;

export type CampaignBulkSendOperation = Readonly<{
  id: string;
  siteId: SiteId;
  campaignId: CampaignId;
  campaignRevisionId: CampaignRevisionId;
  authorizationId: string;
  scheduleId: string | null;
  scheduledInstant: string | null;
  stableSendKey: string;
  state:
    | "preparing"
    | "attempting"
    | "ambiguous"
    | "provider_queued"
    | "sent"
    | "failed"
    | "blocked";
  attempt: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  audienceSnapshot: CampaignBulkAudienceSnapshot | null;
  sendArtifact: CampaignBulkSendArtifact | null;
  sendArtifactHash: string | null;
  sendArtifactCommitSha: string | null;
  providerCampaignId: string | null;
  providerMessageId: string | null;
  providerSendProof: string | null;
  providerVerification: Readonly<{
    providerMessageIds: ReadonlyArray<string>;
    verifiedAt: string;
  }> | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type CampaignBulkProviderRequest = Readonly<{
  operationId: string;
  stableSendKey: string;
  providerCampaignId: string | null;
  providerSendProof: string;
  /**
   * When this operation's provider attempt was opened. An adapter needs it to
   * tell "the provider has no record of this send" apart from "the provider has
   * not reported it yet", which is the only safe basis for sending again.
   */
  attemptedAt: string;
  sendArtifact: CampaignBulkSendArtifact;
  recipients: ReadonlyArray<CampaignBulkAudienceRecipient>;
}>;

export type CampaignBulkProviderOutcome =
  | Readonly<{
      outcome: "accepted";
      providerCampaignId: string;
      providerMessageId: string | null;
    }>
  | Readonly<{
      outcome: "ambiguous";
      providerCampaignId: string | null;
      code: string;
    }>
  | Readonly<{ outcome: "rejected"; code: string }>;

/**
 * Reconciliation reports what the provider's record already shows, so it never
 * reports acceptance of a request it did not make. `not_sent` is the absence
 * proof that permits sending again; `ambiguous` and `rejected` never do.
 */
export type CampaignBulkProviderReconciliation =
  | Extract<CampaignBulkProviderOutcome, { outcome: "ambiguous" | "rejected" }>
  | Readonly<{ outcome: "not_sent" }>
  | Readonly<{
      outcome: "verified";
      providerCampaignId: string;
      providerMessageIds: ReadonlyArray<string>;
      facts?: ReadonlyArray<CampaignBulkProviderFact>;
    }>;

export type CampaignBulkProviderFact = Readonly<{
  providerMessageId: string | null;
  recipientIdentityKey: string;
  type: CampaignDeliveryEventType;
  occurredAt: string;
}>;

export interface CampaignBulkDeliveryAdapter {
  /**
   * The correlation key this adapter will use for one send operation, derived
   * from the operation identity alone. It is persisted before the first
   * provider write so a delivery event that arrives while that write is still
   * in flight already correlates to its operation.
   */
  providerCampaignIdFor(operationId: string): string;
  sendBulk(
    input: CampaignBulkProviderRequest,
  ): Promise<CampaignBulkProviderOutcome>;
  reconcileBulk(
    input: CampaignBulkProviderRequest,
  ): Promise<CampaignBulkProviderReconciliation>;
}

export type CampaignDeliveryEventType =
  | "accepted"
  | "delivered"
  | "opened"
  | "clicked"
  | "unsubscribed"
  | "hard_bounced"
  | "complained"
  | "soft_bounced"
  | "blocked"
  | "invalid"
  | "deferred"
  | "provider_error";

export type CampaignSuppressionEventType =
  | "unsubscribed"
  | "hard_bounced"
  | "complained";

/**
 * The durable negative subscriber state one normalized delivery event implies,
 * or null when the event carries no negative state. Every ingestion path reads
 * this one function, so a webhook and a polled report cannot disagree about
 * whether a given event suppresses its recipient.
 *
 * `invalid` is a permanent address rejection, so it suppresses as a hard
 * bounce. `soft_bounced`, `blocked` and `deferred` are transient or
 * provider-side and never suppress.
 */
export function campaignSuppressionReason(
  type: CampaignDeliveryEventType,
): CampaignSuppressionEventType | null {
  switch (type) {
    case "unsubscribed":
    case "hard_bounced":
    case "complained":
      return type;
    case "invalid":
      return "hard_bounced";
    default:
      return null;
  }
}

/**
 * Event types that prove the provider actually attempted this message. A bounce
 * or complaint still proves the message was sent; `blocked`, `invalid` and
 * `provider_error` prove the opposite, so they can never stand as evidence that
 * a send reached its recipient.
 */
export const campaignDeliveryAttemptedEventTypes: ReadonlySet<CampaignDeliveryEventType> =
  new Set([
    "accepted",
    "delivered",
    "opened",
    "clicked",
    "unsubscribed",
    "complained",
    "hard_bounced",
    "soft_bounced",
    "deferred",
  ]);

export type VerifiedCampaignDeliveryEvent = Readonly<{
  eventId: string;
  payloadFingerprint: string;
  siteId: SiteId;
  operationId: string;
  providerCampaignId: string;
  providerMessageId: string | null;
  providerSendProof: string | null;
  recipientIdentityKey: string;
  type: CampaignDeliveryEventType;
  occurredAt: string;
  receivedAt: string;
  source: "webhook" | "poll";
}>;

export type CampaignBulkArtifactPublicationOutcome =
  | Readonly<{ outcome: "committed"; commitSha: string }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "ambiguous"; code: string }>
  | Readonly<{ outcome: "failed"; code: string }>;

export interface CampaignBulkArtifactPublisher {
  publish(input: {
    operationId: string;
    artifactHash: string;
    bytes: string;
  }): Promise<CampaignBulkArtifactPublicationOutcome>;
  reconcile(input: {
    operationId: string;
    artifactHash: string;
    bytes: string;
  }): Promise<CampaignBulkArtifactPublicationOutcome>;
}

export type CampaignBulkAuditEvent = Readonly<{
  id: string;
  siteId: SiteId;
  actorId: string;
  action:
    | "campaign.bulk.authorize"
    | "campaign.bulk.schedule"
    | "campaign.bulk.cancel"
    | "campaign.bulk.send_now"
    | "campaign.bulk.retry_send";
  targetId: string;
  requestId: string;
  outcome: "rejected";
  reason: string;
  occurredAt: string;
}>;

export type CampaignBulkStateStore = Readonly<{
  recordAudit(event: CampaignBulkAuditEvent): Promise<void>;
  findAuthorizationByRequest(input: {
    siteId: SiteId;
    ownerActorId: string;
    requestId: string;
  }): Promise<Readonly<{
    inputHash: string;
    value: CampaignBulkAuthorization;
  }> | null>;
  findAuthorization(input: {
    siteId: SiteId;
    authorizationId: string;
  }): Promise<CampaignBulkAuthorization | null>;
  saveAuthorization(input: {
    requestId: string;
    inputHash: string;
    authorization: CampaignBulkAuthorization;
  }): Promise<
    Readonly<{ value: CampaignBulkAuthorization; replayed: boolean }>
  >;
  activateSchedule(input: {
    requestId: string;
    inputHash: string;
    schedule: CampaignBulkSchedule;
  }): Promise<Readonly<{ value: CampaignBulkSchedule; replayed: boolean }>>;
  cancelSchedule(input: {
    requestId: string;
    ownerActorId: string;
    scheduleId: string;
    now: string;
  }): Promise<CampaignBulkSchedule>;
  createSendOperation(input: {
    requestId: string;
    inputHash: string;
    operation: CampaignBulkSendOperation;
  }): Promise<
    Readonly<{ value: CampaignBulkSendOperation; replayed: boolean }>
  >;
  claimDueSchedule(input: {
    now: string;
    latenessCutoff: string;
    leaseToken: string;
    leaseExpiresAt: string;
    createOperationId(): string;
  }): Promise<CampaignBulkSendOperation | null>;
  findOperation(input: {
    siteId: SiteId;
    operationId: string;
  }): Promise<CampaignBulkSendOperation | null>;
  listReconciliationCandidates(input: {
    siteId: SiteId;
    now: string;
    /**
     * Completed sends stay in the reporting window so a polled report remains a
     * backstop for a suppression event whose webhook was lost. Sends that
     * finished before this are left alone.
     */
    sentReportingCutoff: string;
    limit: number;
  }): Promise<ReadonlyArray<CampaignBulkSendOperation>>;
  claimOperation(input: {
    siteId: SiteId;
    operationId: string;
    expectedCampaignRevisionId: CampaignRevisionId;
    expectedOwnerActorId: string;
    now: string;
    /**
     * The lease this caller already holds, or null. A live lease is only
     * claimable by a caller that can present its token, so reading the row is
     * never enough to take over from the executor holding it.
     */
    heldLeaseToken: string | null;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<CampaignBulkSendOperation | null>;
  saveAudienceSnapshot(input: {
    operation: CampaignBulkSendOperation;
    snapshot: CampaignBulkAudienceSnapshot;
    sendArtifact: CampaignBulkSendArtifact;
    sendArtifactHash: string;
    now: string;
  }): Promise<CampaignBulkSendOperation | null>;
  recordArtifactPublication(input: {
    operation: CampaignBulkSendOperation;
    outcome: CampaignBulkArtifactPublicationOutcome;
    now: string;
  }): Promise<CampaignBulkSendOperation>;
  /**
   * Give up this executor's lease when its attempt ended before any provider
   * request was made. A lease that outlives a failed preparation would block
   * the Owner's own retry until it expired, and nothing is in flight to
   * protect.
   */
  releaseLease(input: {
    operation: CampaignBulkSendOperation;
    now: string;
  }): Promise<void>;
  beginProviderAttempt(input: {
    operation: CampaignBulkSendOperation;
    activeSubscriberIds: ReadonlyArray<string>;
    providerCampaignId: string;
    providerSendProof: string;
    now: string;
  }): Promise<CampaignBulkSendOperation | null>;
  recordProviderOutcome(input: {
    operation: CampaignBulkSendOperation;
    outcome:
      | CampaignBulkProviderOutcome
      | Extract<CampaignBulkProviderReconciliation, { outcome: "verified" }>;
    now: string;
  }): Promise<CampaignBulkSendOperation>;
  recordEvent(
    event: VerifiedCampaignDeliveryEvent,
  ): Promise<"recorded" | "duplicate" | "conflict">;
  confirmProviderAcceptance(input: {
    siteId: SiteId;
    operationId: string;
    providerCampaignId: string;
    providerMessageIds: ReadonlyArray<string>;
    now: string;
  }): Promise<CampaignBulkSendOperation | null>;
}>;

export type CampaignBulkSource = Readonly<{
  campaign: Campaign;
  revision: CampaignRevision;
  evidence: CampaignTestDeliveryEvidence | null;
  confirmation: CampaignTestReceiptConfirmation | null;
  currentSenderFingerprint: string | null;
  currentSender: Readonly<{ email: string; name: string }> | null;
  currentProviderConfigurationFingerprint: string | null;
}>;

export type CampaignBulkDeliveryApplication = Readonly<{
  commands: Readonly<{
    authorize(input: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      testExecutionId: string;
    }): Promise<
      Readonly<{ authorization: CampaignBulkAuthorization; replayed: boolean }>
    >;
    activateSchedule(input: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      authorizationId: string;
      resolvedTime: CampaignBulkResolvedTime;
    }): Promise<
      Readonly<{ schedule: CampaignBulkSchedule; replayed: boolean }>
    >;
    cancelSchedule(input: {
      actor: CampaignActor;
      requestId: string;
      scheduleId: string;
    }): Promise<CampaignBulkSchedule>;
    /**
     * Re-run one existing send operation. It reuses that operation's identity,
     * audience snapshot and committed artifact, and reconciles an uncertain
     * provider outcome before it will send again.
     */
    retrySend(input: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      operationId: string;
    }): Promise<CampaignBulkSendOperation>;
    sendNow(input: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      authorizationId: string;
    }): Promise<
      Readonly<{ operation: CampaignBulkSendOperation; replayed: boolean }>
    >;
    ingestVerifiedEvent(
      event: VerifiedCampaignDeliveryEvent,
    ): Promise<"recorded" | "duplicate">;
  }>;
  scheduler: Readonly<{
    claimDue(): Promise<CampaignBulkSendOperation | null>;
    /**
     * Run one send operation. `heldLeaseToken` is the lease the caller already
     * holds — the scheduler passes the one `claimDue` gave it — and lets that
     * caller continue an execution it owns.
     */
    execute(
      operationId: string,
      heldLeaseToken?: string | null,
    ): Promise<CampaignBulkSendOperation>;
    reconcilePending(): Promise<ReadonlyArray<CampaignBulkSendOperation>>;
  }>;
}>;

export class CampaignBulkDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CampaignBulkDeliveryError";
  }
}

function requireRequestId(value: string) {
  if (!requestIdPattern.test(value)) {
    throw new CampaignBulkDeliveryError("bulk_idempotency_key_invalid");
  }
}

function requireId(value: string, code: string) {
  if (!uuidPattern.test(value)) throw new CampaignBulkDeliveryError(code);
}

function civilParts(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

function offsetAt(instant: Date, timeZone: string): string {
  const parts = civilParts(instant, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const minutes = Math.round((asUtc - instant.getTime()) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function localDateTimeAt(instant: Date, timeZone: string): string {
  const parts = civilParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function requireResolvedFutureTime(
  input: CampaignBulkResolvedTime,
  now: Date,
) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(input.localDateTime) ||
    !/^[+-]\d{2}:\d{2}$/u.test(input.utcOffsetChoice) ||
    input.timeZoneDatabaseVersion.trim() === ""
  ) {
    throw new CampaignBulkDeliveryError("bulk_schedule_time_invalid");
  }
  const instant = new Date(input.executeAtUtc);
  if (
    Number.isNaN(instant.getTime()) ||
    instant.toISOString() !== input.executeAtUtc ||
    instant.getTime() <= now.getTime()
  ) {
    throw new CampaignBulkDeliveryError("bulk_schedule_time_invalid");
  }
  try {
    if (
      localDateTimeAt(instant, input.ianaTimeZone) !== input.localDateTime ||
      offsetAt(instant, input.ianaTimeZone) !== input.utcOffsetChoice
    ) {
      throw new CampaignBulkDeliveryError("bulk_schedule_time_mismatch");
    }
  } catch (error) {
    if (error instanceof CampaignBulkDeliveryError) throw error;
    throw new CampaignBulkDeliveryError("bulk_schedule_time_invalid");
  }
}

function sameRecipients(
  left: ReadonlyArray<CampaignBulkAudienceRecipient>,
  right: ReadonlyArray<CampaignBulkAudienceRecipient>,
) {
  return (
    left.length === right.length &&
    left.every((recipient, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        recipient.subscriberId === other.subscriberId &&
        recipient.identityKey === other.identityKey &&
        recipient.address.trim().toLowerCase() ===
          other.address.trim().toLowerCase()
      );
    })
  );
}

function sortedRecipients(
  recipients: ReadonlyArray<CampaignBulkAudienceRecipient>,
) {
  return [...recipients].sort((left, right) =>
    left.subscriberId.localeCompare(right.subscriberId),
  );
}

async function authorizationFingerprint(
  evidence: CampaignTestDeliveryEvidence,
) {
  return sha256CanonicalJson({
    version: "foundry.bulk-authorization.v2",
    campaignFingerprint: evidence.campaignFingerprint,
    htmlFingerprint: evidence.htmlFingerprint,
    textFingerprint: evidence.textFingerprint,
    senderFingerprint: evidence.senderFingerprint,
    providerConfigurationFingerprint: evidence.providerConfigurationFingerprint,
    testExecutionId: evidence.executionId,
    testProviderReceiptHash: evidence.providerReceiptHash,
    testAcceptedAt: evidence.acceptedAt,
  });
}

async function requireExactAuthorizationSource(
  authorization: CampaignBulkAuthorization,
  source: CampaignBulkSource,
  requireCurrentAuthority: boolean,
) {
  const evidence = source.evidence;
  if (
    evidence === null ||
    source.confirmation === null ||
    evidence.executionId !== authorization.testExecutionId ||
    evidence.campaignId !== authorization.campaignId ||
    evidence.campaignRevisionId !== authorization.campaignRevisionId ||
    evidence.campaignFingerprint !== authorization.campaignFingerprint ||
    evidence.providerReceiptHash !== authorization.testProviderReceiptHash ||
    evidence.htmlFingerprint !== authorization.testHtmlFingerprint ||
    evidence.textFingerprint !== authorization.testTextFingerprint ||
    evidence.senderFingerprint !== authorization.testSenderFingerprint ||
    evidence.providerConfigurationFingerprint !==
      authorization.testProviderConfigurationFingerprint ||
    source.confirmation.executionId !== authorization.testExecutionId ||
    source.confirmation.siteId !== authorization.siteId ||
    source.confirmation.ownerActorId !== authorization.ownerActorId ||
    (await authorizationFingerprint(evidence)) !==
      authorization.authorizationFingerprint ||
    (requireCurrentAuthority &&
      (source.campaign.currentRevisionId !== authorization.campaignRevisionId ||
        source.revision.id !== authorization.campaignRevisionId ||
        source.currentSenderFingerprint !==
          authorization.testSenderFingerprint ||
        source.currentProviderConfigurationFingerprint !==
          authorization.testProviderConfigurationFingerprint))
  ) {
    throw new CampaignBulkDeliveryError("bulk_authorization_stale");
  }
  return evidence;
}

function artifactBytes(artifact: CampaignBulkSendArtifact) {
  return `${canonicalJson(artifact)}\n`;
}

export function createCampaignBulkDeliveryApplication({
  siteId,
  store,
  loadSource,
  authorizeOwner,
  identifyActor,
  validateOwnerAuthority,
  resolveAudience,
  resolveAudienceByIds,
  applyProviderSuppression,
  artifactPublisher,
  adapter,
  fingerprintKey,
  maximumAudienceRecipients,
  clock = () => new Date(),
  createId = () => crypto.randomUUID(),
}: {
  siteId: SiteId;
  store: CampaignBulkStateStore;
  loadSource(
    campaignId: CampaignId,
    testExecutionId: string,
  ): Promise<CampaignBulkSource>;
  authorizeOwner(actor: CampaignActor): Promise<Readonly<{ id: string }>>;
  identifyActor(actor: CampaignActor): string;
  validateOwnerAuthority(ownerActorId: string): Promise<boolean>;
  resolveAudience(
    revision: CampaignRevision,
  ): Promise<ReadonlyArray<CampaignBulkAudienceRecipient>>;
  resolveAudienceByIds(
    subscriberIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<CampaignBulkAudienceRecipient>>;
  /**
   * Apply a provider-reported negative subscriber state. Required, because a
   * wiring that omitted it would silently drop every unsubscribe and bounce
   * this application observes.
   */
  applyProviderSuppression(input: {
    providerEventId: string;
    recipientIdentityKey: string;
    reason: CampaignSuppressionEventType;
    occurredAt: string;
  }): Promise<void>;
  artifactPublisher: CampaignBulkArtifactPublisher;
  adapter: CampaignBulkDeliveryAdapter;
  fingerprintKey: string;
  /**
   * The largest audience one logical send operation may dispatch in a single
   * provider request. The installed adapter owns this number; the application
   * only refuses to resolve, commit or dispatch an audience above it so an
   * oversized send fails before any Git commit or provider write.
   */
  maximumAudienceRecipients: number;
  clock?: () => Date;
  createId?: (
    kind:
      | "authorization"
      | "schedule"
      | "operation"
      | "snapshot"
      | "lease"
      | "audit",
  ) => string;
}): CampaignBulkDeliveryApplication {
  if (fingerprintKey.length < 32) {
    throw new CampaignBulkDeliveryError("bulk_fingerprint_key_invalid");
  }
  if (
    !Number.isSafeInteger(maximumAudienceRecipients) ||
    maximumAudienceRecipients < 1
  ) {
    throw new CampaignBulkDeliveryError("bulk_audience_capacity_invalid");
  }

  async function withRejectedAudit<T>(
    input: {
      actor: CampaignActor;
      requestId: string;
      action: CampaignBulkAuditEvent["action"];
      targetId: string;
    },
    execute: () => Promise<T>,
  ) {
    try {
      return await execute();
    } catch (error) {
      const reason =
        error instanceof CampaignBulkDeliveryError
          ? error.code
          : error instanceof Error && /^[a-z][a-z0-9_]+$/u.test(error.message)
            ? error.message
            : "bulk_command_rejected";
      await store.recordAudit({
        id: createId("audit"),
        siteId,
        actorId: identifyActor(input.actor),
        action: input.action,
        targetId: input.targetId,
        requestId:
          input.requestId.length <= 200
            ? input.requestId
            : input.requestId.slice(0, 200),
        outcome: "rejected",
        reason,
        occurredAt: clock().toISOString(),
      });
      throw error;
    }
  }

  async function authorize(input: {
    actor: CampaignActor;
    requestId: string;
    campaignId: CampaignId;
    testExecutionId: string;
  }) {
    requireRequestId(input.requestId);
    requireId(input.testExecutionId, "bulk_test_execution_id_invalid");
    const owner = await authorizeOwner(input.actor);
    const inputHash = await sha256CanonicalJson({
      campaignId: input.campaignId,
      testExecutionId: input.testExecutionId,
    });
    const prior = await store.findAuthorizationByRequest({
      siteId,
      ownerActorId: owner.id,
      requestId: input.requestId,
    });
    if (prior !== null) {
      if (prior.inputHash !== inputHash) {
        throw new CampaignBulkDeliveryError("bulk_idempotency_key_reused");
      }
      return Object.freeze({
        authorization: prior.value,
        replayed: true,
      });
    }
    const source = await loadSource(input.campaignId, input.testExecutionId);
    // The three refusals are separate because they need separate next actions:
    // run a test, confirm the delivered test, or retest the current revision.
    if (
      source.evidence === null ||
      source.evidence.executionId !== input.testExecutionId ||
      source.evidence.campaignId !== source.campaign.id
    ) {
      throw new CampaignBulkDeliveryError("bulk_test_required");
    }
    if (
      source.confirmation === null ||
      source.confirmation.executionId !== input.testExecutionId ||
      source.confirmation.siteId !== siteId ||
      source.confirmation.ownerActorId !== owner.id
    ) {
      throw new CampaignBulkDeliveryError("bulk_test_not_reviewed");
    }
    if (
      source.campaign.currentRevisionId !== source.revision.id ||
      source.evidence.campaignRevisionId !== source.revision.id ||
      source.currentSenderFingerprint !== source.evidence.senderFingerprint ||
      source.currentProviderConfigurationFingerprint !==
        source.evidence.providerConfigurationFingerprint
    ) {
      throw new CampaignBulkDeliveryError("bulk_test_stale");
    }
    const now = clock().toISOString();
    const exactAuthorizationFingerprint = await authorizationFingerprint(
      source.evidence,
    );
    const authorization: CampaignBulkAuthorization = Object.freeze({
      id: createId("authorization"),
      siteId,
      campaignId: source.campaign.id,
      campaignRevisionId: source.revision.id,
      campaignFingerprint: source.evidence.campaignFingerprint,
      testExecutionId: source.evidence.executionId,
      testProviderReceiptHash: source.evidence.providerReceiptHash,
      testHtmlFingerprint: source.evidence.htmlFingerprint,
      testTextFingerprint: source.evidence.textFingerprint,
      testSenderFingerprint: source.evidence.senderFingerprint,
      testProviderConfigurationFingerprint:
        source.evidence.providerConfigurationFingerprint,
      authorizationFingerprint: exactAuthorizationFingerprint,
      ownerActorId: owner.id,
      state: "active",
      authorizedAt: now,
      invalidatedAt: null,
    });
    const result = await store.saveAuthorization({
      requestId: input.requestId,
      inputHash,
      authorization,
    });
    return Object.freeze({
      authorization: result.value,
      replayed: result.replayed,
    });
  }

  async function requireOwnerAndAuthorization(
    actor: CampaignActor,
    campaignId: CampaignId,
    authorizationId: string,
  ) {
    requireId(authorizationId, "bulk_authorization_id_invalid");
    const owner = await authorizeOwner(actor);
    const authorization = await store.findAuthorization({
      siteId,
      authorizationId,
    });
    if (
      authorization === null ||
      authorization.siteId !== siteId ||
      authorization.campaignId !== campaignId ||
      authorization.ownerActorId !== owner.id ||
      authorization.state !== "active"
    ) {
      throw new CampaignBulkDeliveryError("bulk_authorization_stale");
    }
    const source = await loadSource(campaignId, authorization.testExecutionId);
    await requireExactAuthorizationSource(authorization, source, true);
    return { owner, source, authorization };
  }

  async function activateSchedule(input: {
    actor: CampaignActor;
    requestId: string;
    campaignId: CampaignId;
    authorizationId: string;
    resolvedTime: CampaignBulkResolvedTime;
  }) {
    requireRequestId(input.requestId);
    requireResolvedFutureTime(input.resolvedTime, clock());
    const { owner, source } = await requireOwnerAndAuthorization(
      input.actor,
      input.campaignId,
      input.authorizationId,
    );
    const now = clock().toISOString();
    const schedule: CampaignBulkSchedule = Object.freeze({
      id: createId("schedule"),
      siteId,
      campaignId: input.campaignId,
      authorizationId: input.authorizationId,
      ...input.resolvedTime,
      activatedBy: owner.id,
      state: "active",
      createdAt: now,
      updatedAt: now,
    });
    const inputHash = await sha256CanonicalJson({
      campaignId: source.campaign.id,
      campaignRevisionId: source.revision.id,
      authorizationId: input.authorizationId,
      resolvedTime: input.resolvedTime,
    });
    const result = await store.activateSchedule({
      requestId: input.requestId,
      inputHash,
      schedule,
    });
    return Object.freeze({ schedule: result.value, replayed: result.replayed });
  }

  async function sendNow(input: {
    actor: CampaignActor;
    requestId: string;
    campaignId: CampaignId;
    authorizationId: string;
  }) {
    requireRequestId(input.requestId);
    const { owner, source } = await requireOwnerAndAuthorization(
      input.actor,
      input.campaignId,
      input.authorizationId,
    );
    const now = clock().toISOString();
    const operationId = createId("operation");
    const stableSendKey = await sha256CanonicalJson({
      version: "foundry.campaign-bulk-send.v1",
      siteId,
      operationId,
      campaignId: source.campaign.id,
      campaignRevisionId: source.revision.id,
      authorizationId: input.authorizationId,
    });
    const operation: CampaignBulkSendOperation = Object.freeze({
      id: operationId,
      siteId,
      campaignId: source.campaign.id,
      campaignRevisionId: source.revision.id,
      authorizationId: input.authorizationId,
      scheduleId: null,
      scheduledInstant: null,
      stableSendKey,
      state: "preparing",
      attempt: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      audienceSnapshot: null,
      sendArtifact: null,
      sendArtifactHash: null,
      sendArtifactCommitSha: null,
      providerCampaignId: null,
      providerMessageId: null,
      providerSendProof: null,
      providerVerification: null,
      detail: null,
      createdAt: now,
      updatedAt: now,
    });
    const inputHash = await sha256CanonicalJson({
      campaignId: source.campaign.id,
      campaignRevisionId: source.revision.id,
      authorizationId: input.authorizationId,
      ownerActorId: owner.id,
    });
    const result = await store.createSendOperation({
      requestId: input.requestId,
      inputHash,
      operation,
    });
    return Object.freeze({
      operation: result.value,
      replayed: result.replayed,
    });
  }

  async function recordPolledFacts(
    operation: CampaignBulkSendOperation,
    facts: ReadonlyArray<CampaignBulkProviderFact>,
  ) {
    if (operation.providerCampaignId === null) {
      throw new CampaignBulkDeliveryError("bulk_provider_evidence_invalid");
    }
    for (const fact of facts) {
      const stableFact = {
        siteId,
        operationId: operation.id,
        providerCampaignId: operation.providerCampaignId,
        providerMessageId: fact.providerMessageId,
        providerSendProof: null,
        recipientIdentityKey: fact.recipientIdentityKey,
        type: fact.type,
        occurredAt: fact.occurredAt,
        source: "poll" as const,
      };
      const payloadFingerprint = await hmacSha256CanonicalJson(fingerprintKey, {
        version: "foundry.campaign-poll-payload.v1",
        ...stableFact,
      });
      const eventId = await hmacSha256CanonicalJson(fingerprintKey, {
        version: "foundry.campaign-poll-event.v1",
        ...stableFact,
      });
      const result = await store.recordEvent({
        eventId,
        payloadFingerprint,
        ...stableFact,
        receivedAt: clock().toISOString(),
      });
      if (result === "conflict") {
        throw new CampaignBulkDeliveryError(
          "bulk_delivery_event_identity_conflict",
        );
      }
      const reason = campaignSuppressionReason(fact.type);
      // Only the first record of a fact applies its suppression, so repeated
      // reconciliation of the same report cannot append it again.
      if (result === "recorded" && reason !== null) {
        await applyProviderSuppression({
          providerEventId: eventId,
          recipientIdentityKey: fact.recipientIdentityKey,
          reason,
          occurredAt: fact.occurredAt,
        });
      }
    }
  }

  async function execute(
    operationId: string,
    heldLeaseToken: string | null = null,
  ) {
    requireId(operationId, "bulk_operation_id_invalid");
    let existing = await store.findOperation({ siteId, operationId });
    if (existing === null) {
      throw new CampaignBulkDeliveryError("bulk_operation_not_found");
    }
    const authorization = await store.findAuthorization({
      siteId,
      authorizationId: existing.authorizationId,
    });
    if (authorization === null) {
      throw new CampaignBulkDeliveryError("bulk_authorization_stale");
    }

    function requestFor(operation: CampaignBulkSendOperation) {
      if (
        operation.sendArtifact === null ||
        operation.audienceSnapshot === null ||
        operation.providerSendProof === null ||
        operation.sendArtifactCommitSha === null
      ) {
        throw new CampaignBulkDeliveryError("bulk_provider_evidence_invalid");
      }
      return Object.freeze({
        operationId,
        stableSendKey: operation.stableSendKey,
        providerCampaignId: operation.providerCampaignId,
        providerSendProof: operation.providerSendProof,
        attemptedAt: operation.updatedAt,
        sendArtifact: operation.sendArtifact,
        recipients: operation.audienceSnapshot.recipients,
      }) satisfies CampaignBulkProviderRequest;
    }

    if (existing.state === "sent") {
      // A completed send is never re-sent, but its reported facts are still
      // ingested so a suppression event whose webhook was lost is not silently
      // dropped from the ledger.
      const reported = await adapter.reconcileBulk(requestFor(existing));
      if (reported.outcome === "verified") {
        await recordPolledFacts(existing, reported.facts ?? []);
      }
      return existing;
    }

    async function reconcileUncertain(operation: CampaignBulkSendOperation) {
      const reconciled = await adapter.reconcileBulk(requestFor(operation));
      if (reconciled.outcome !== "verified") return reconciled;
      const recorded = await store.recordProviderOutcome({
        operation,
        outcome: reconciled,
        now: clock().toISOString(),
      });
      await recordPolledFacts(recorded, reconciled.facts ?? []);
      const confirmed = await store.confirmProviderAcceptance({
        siteId,
        operationId,
        providerCampaignId: reconciled.providerCampaignId,
        providerMessageIds: reconciled.providerMessageIds,
        now: clock().toISOString(),
      });
      return confirmed ?? recorded;
    }

    if (
      existing.state === "attempting" ||
      existing.state === "ambiguous" ||
      existing.state === "provider_queued"
    ) {
      const reconciled = await reconcileUncertain(existing);
      if (
        !("outcome" in reconciled) ||
        reconciled.outcome !== "not_sent" ||
        existing.state === "provider_queued"
      ) {
        return "outcome" in reconciled ? existing : reconciled;
      }
    }

    const source = await loadSource(
      existing.campaignId,
      authorization.testExecutionId,
    );
    await requireExactAuthorizationSource(authorization, source, true);
    if (
      authorization.state !== "active" ||
      !(await validateOwnerAuthority(authorization.ownerActorId))
    ) {
      throw new CampaignBulkDeliveryError("bulk_authorization_stale");
    }

    const now = clock();
    // Always a fresh token. A live lease is claimable only by a caller that
    // presents its token, so a second executor cannot take over an execution
    // that is still in flight.
    const leaseToken = createId("lease");
    const claimed = await store.claimOperation({
      siteId,
      operationId,
      heldLeaseToken,
      expectedCampaignRevisionId: existing.campaignRevisionId,
      expectedOwnerActorId: authorization.ownerActorId,
      now: now.toISOString(),
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    });
    if (claimed === null) {
      const concurrent = await store.findOperation({ siteId, operationId });
      if (concurrent === null) {
        throw new CampaignBulkDeliveryError("bulk_operation_not_found");
      }
      return concurrent;
    }

    try {
      return await executeClaimed(claimed, authorization);
    } catch (error) {
      // Nothing reached the provider, so hand this executor's own lease back
      // rather than making the Owner wait for it to expire. It presents the
      // lease it claimed, so a lease another executor has since taken is left
      // alone.
      await store.releaseLease({
        operation: claimed,
        now: clock().toISOString(),
      });
      throw error;
    }

    // The authorization arrives as a parameter so this body reads it as
    // definitely present rather than re-narrowing the enclosing lookup.
    async function executeClaimed(
      claimedOperation: CampaignBulkSendOperation,
      activeAuthorization: CampaignBulkAuthorization,
    ) {
      const authorization = activeAuthorization;
      let operation = claimedOperation;
      // An audience snapshot is immutable once a provider attempt has opened,
      // because only then can a request exist that a replacement would
      // contradict. Until then a negative subscriber state that appears after
      // the previous resolution must be able to remove that recipient, so
      // preparation re-resolves rather than dead-ending on the stale snapshot.
      if (operation.providerSendProof === null) {
        const recipients = sortedRecipients(
          await resolveAudience(source.revision),
        );
        if (recipients.length === 0) {
          throw new CampaignBulkDeliveryError("bulk_audience_empty");
        }
        if (recipients.length > maximumAudienceRecipients) {
          throw new CampaignBulkDeliveryError("bulk_audience_capacity_exceeded");
        }
        const revalidated = sortedRecipients(
          await resolveAudienceByIds(recipients.map(({ subscriberId }) => subscriberId)),
        );
        if (!sameRecipients(recipients, revalidated)) {
          throw new CampaignBulkDeliveryError("bulk_suppression_changed");
        }
        const snapshotFingerprint = await hmacSha256CanonicalJson(
          fingerprintKey,
          {
            version: "foundry.campaign-audience-snapshot.v2",
            siteId,
            operationId,
            recipients,
          },
        );
        const snapshot: CampaignBulkAudienceSnapshot = Object.freeze({
          id: createId("snapshot"),
          fingerprint: snapshotFingerprint,
          subscriberIds: Object.freeze(
            recipients.map(({ subscriberId }) => subscriberId),
          ),
          recipients: Object.freeze(recipients),
          recipientCount: recipients.length,
          resolvedAt: clock().toISOString(),
        });
        const rendered = await renderCampaignRevision(
          source.revision,
          recipients.length,
        );
        if (
          rendered.campaignFingerprint !== authorization.campaignFingerprint ||
          rendered.html.fingerprint !== authorization.testHtmlFingerprint ||
          rendered.text.fingerprint !== authorization.testTextFingerprint ||
          source.currentSender === null
        ) {
          throw new CampaignBulkDeliveryError("bulk_test_evidence_invalid");
        }
        const artifact: CampaignBulkSendArtifact = Object.freeze({
          version: "foundry.campaign-bulk-send-artifact.v2",
          operationId,
          stableSendKey: operation.stableSendKey,
          siteId,
          campaignId: operation.campaignId,
          campaignRevisionId: operation.campaignRevisionId,
          authorizationId: authorization.id,
          authorizationFingerprint: authorization.authorizationFingerprint,
          campaignFingerprint: authorization.campaignFingerprint,
          senderIdentityId: source.revision.senderIdentityId,
          sender: source.currentSender,
          senderFingerprint: authorization.testSenderFingerprint,
          providerConfigurationFingerprint:
            authorization.testProviderConfigurationFingerprint,
          complianceVersion: source.revision.complianceFooter.version,
          audienceDefinition: Object.freeze({
            id: source.revision.audienceDefinition.id,
            version: source.revision.audienceDefinition.version,
          }),
          scheduledInstant: operation.scheduledInstant,
          recipientCount: recipients.length,
          subject: source.revision.subject,
          htmlContent: rendered.html.bytes,
          textContent: rendered.text.bytes,
          htmlFingerprint: rendered.html.fingerprint,
          textFingerprint: rendered.text.fingerprint,
          audienceFingerprint: snapshot.fingerprint,
        });
        const sendArtifactHash = await sha256Text(artifactBytes(artifact));
        const saved = await store.saveAudienceSnapshot({
          operation,
          snapshot,
          sendArtifact: artifact,
          sendArtifactHash,
          now: clock().toISOString(),
        });
        if (saved === null) {
          throw new CampaignBulkDeliveryError("bulk_execution_lease_lost");
        }
        operation = saved;
      }

      if (
        operation.sendArtifact === null ||
        operation.sendArtifactHash === null ||
        operation.audienceSnapshot === null
      ) {
        throw new CampaignBulkDeliveryError("bulk_send_artifact_invalid");
      }

      if (operation.sendArtifactCommitSha === null) {
        const publicationInput = {
          operationId,
          artifactHash: operation.sendArtifactHash,
          bytes: artifactBytes(operation.sendArtifact),
        };
        let publication = await artifactPublisher.reconcile(publicationInput);
        if (publication.outcome === "not_found") {
          publication = await artifactPublisher.publish(publicationInput);
        }
        operation = await store.recordArtifactPublication({
          operation,
          outcome: publication,
          now: clock().toISOString(),
        });
        if (publication.outcome !== "committed") {
          return operation;
        }
      }

      const persistedSnapshot = operation.audienceSnapshot;
      if (persistedSnapshot === null) {
        throw new CampaignBulkDeliveryError("bulk_send_artifact_invalid");
      }
      const revalidatedSnapshot = sortedRecipients(
        await resolveAudienceByIds(persistedSnapshot.subscriberIds),
      );
      if (!sameRecipients(persistedSnapshot.recipients, revalidatedSnapshot)) {
        throw new CampaignBulkDeliveryError("bulk_suppression_changed");
      }
      const providerSendProof =
        operation.providerSendProof ??
        (await hmacSha256CanonicalJson(fingerprintKey, {
          version: "foundry.campaign-provider-send-proof.v2",
          operationId,
          stableSendKey: operation.stableSendKey,
          authorizationFingerprint: authorization.authorizationFingerprint,
          audienceFingerprint: persistedSnapshot.fingerprint,
          sendArtifactHash: operation.sendArtifactHash,
          sendArtifactCommitSha: operation.sendArtifactCommitSha,
        }));
      const providerCampaignId = adapter.providerCampaignIdFor(operationId);
      const attempting = await store.beginProviderAttempt({
        operation,
        activeSubscriberIds: persistedSnapshot.recipients.map(
          ({ subscriberId }) => subscriberId,
        ),
        providerCampaignId,
        providerSendProof,
        now: clock().toISOString(),
      });
      if (attempting === null) {
        // The write refuses either because a recipient is no longer eligible or
        // because a prior attempt is correlated to a different provider key.
        // Naming which one keeps the recorded reason truthful.
        const current = await store.findOperation({ siteId, operationId });
        throw new CampaignBulkDeliveryError(
          current !== null &&
          current.providerCampaignId !== null &&
          current.providerCampaignId !== providerCampaignId
            ? "bulk_provider_correlation_conflict"
            : "bulk_suppression_changed",
        );
      }
      operation = attempting;
      const outcome = await adapter.sendBulk(requestFor(operation));
      return store.recordProviderOutcome({
        operation,
        outcome,
        now: clock().toISOString(),
      });
    }
  }

  const application: CampaignBulkDeliveryApplication = Object.freeze({
    commands: Object.freeze({
      authorize: (
        input: Parameters<
          CampaignBulkDeliveryApplication["commands"]["authorize"]
        >[0],
      ) =>
        withRejectedAudit(
          {
            actor: input.actor,
            requestId: input.requestId,
            action: "campaign.bulk.authorize",
            targetId: input.campaignId,
          },
          () => authorize(input),
        ),
      activateSchedule: (
        input: Parameters<
          CampaignBulkDeliveryApplication["commands"]["activateSchedule"]
        >[0],
      ) =>
        withRejectedAudit(
          {
            actor: input.actor,
            requestId: input.requestId,
            action: "campaign.bulk.schedule",
            targetId: input.campaignId,
          },
          () => activateSchedule(input),
        ),
      async cancelSchedule({
        actor,
        requestId,
        scheduleId,
      }: {
        actor: CampaignActor;
        requestId: string;
        scheduleId: string;
      }) {
        return withRejectedAudit(
          {
            actor,
            requestId,
            action: "campaign.bulk.cancel",
            targetId: scheduleId,
          },
          async () => {
            requireRequestId(requestId);
            requireId(scheduleId, "bulk_schedule_id_invalid");
            const owner = await authorizeOwner(actor);
            return store.cancelSchedule({
              requestId,
              ownerActorId: owner.id,
              scheduleId,
              now: clock().toISOString(),
            });
          },
        );
      },
      sendNow: (
        input: Parameters<
          CampaignBulkDeliveryApplication["commands"]["sendNow"]
        >[0],
      ) =>
        withRejectedAudit(
          {
            actor: input.actor,
            requestId: input.requestId,
            action: "campaign.bulk.send_now",
            targetId: input.campaignId,
          },
          () => sendNow(input),
        ),
      async retrySend({
        actor,
        requestId,
        campaignId,
        operationId,
      }: {
        actor: CampaignActor;
        requestId: string;
        campaignId: CampaignId;
        operationId: string;
      }) {
        return withRejectedAudit(
          {
            actor,
            requestId,
            action: "campaign.bulk.retry_send",
            targetId: operationId,
          },
          async () => {
            requireRequestId(requestId);
            requireId(operationId, "bulk_operation_id_invalid");
            const owner = await authorizeOwner(actor);
            const operation = await store.findOperation({ siteId, operationId });
            if (operation === null || operation.campaignId !== campaignId) {
              throw new CampaignBulkDeliveryError("bulk_operation_not_found");
            }
            const authorization = await store.findAuthorization({
              siteId,
              authorizationId: operation.authorizationId,
            });
            if (
              authorization === null ||
              authorization.ownerActorId !== owner.id ||
              authorization.state !== "active"
            ) {
              throw new CampaignBulkDeliveryError("bulk_authorization_stale");
            }
            return execute(operationId);
          },
        );
      },
      async ingestVerifiedEvent(event: VerifiedCampaignDeliveryEvent) {
        if (
          event.siteId !== siteId ||
          !Number.isFinite(Date.parse(event.occurredAt)) ||
          !Number.isFinite(Date.parse(event.receivedAt))
        ) {
          throw new CampaignBulkDeliveryError("bulk_delivery_event_invalid");
        }
        const result = await store.recordEvent(event);
        if (result === "conflict") {
          throw new CampaignBulkDeliveryError(
            "bulk_delivery_event_identity_conflict",
          );
        }
        // Suppression belongs to recording the event, not to whichever caller
        // happened to deliver it, and only the first record of an event applies
        // it so a webhook retry cannot append the same negative state twice.
        const reason = campaignSuppressionReason(event.type);
        if (result === "recorded" && reason !== null) {
          await applyProviderSuppression({
            providerEventId: event.eventId,
            recipientIdentityKey: event.recipientIdentityKey,
            reason,
            occurredAt: event.occurredAt,
          });
        }
        return result;
      },
    }),
    scheduler: Object.freeze({
      async claimDue() {
        const now = clock();
        return store.claimDueSchedule({
          now: now.toISOString(),
          latenessCutoff: new Date(now.getTime() - 15 * 60_000).toISOString(),
          leaseToken: createId("lease"),
          leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
          createOperationId: () => createId("operation"),
        });
      },
      execute: (operationId: string, heldLeaseToken?: string | null) =>
        execute(operationId, heldLeaseToken ?? null),
      async reconcilePending() {
        const now = clock();
        const candidates = await store.listReconciliationCandidates({
          siteId,
          now: now.toISOString(),
          sentReportingCutoff: new Date(
            now.getTime() - sentReportingWindowMs,
          ).toISOString(),
          limit: 25,
        });
        const reconciled: CampaignBulkSendOperation[] = [];
        for (const candidate of candidates) {
          try {
            reconciled.push(await execute(candidate.id));
          } catch {
            const current = await store.findOperation({
              siteId,
              operationId: candidate.id,
            });
            if (current !== null) reconciled.push(current);
          }
        }
        return Object.freeze(reconciled);
      },
    }),
  });
  return application;
}

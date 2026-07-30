import type {
  BlogPost,
  BlogPostId,
  RichTextDocument,
  SiteDefinition,
  SiteId,
} from "@foundry/site-definition";

import type { ExternalHumanIdentity } from "./human-access";

declare const campaignIdBrand: unique symbol;
declare const campaignRevisionIdBrand: unique symbol;
declare const sourcePostRevisionIdBrand: unique symbol;

export type CampaignId = string & {
  readonly [campaignIdBrand]: "campaign";
};
export type CampaignRevisionId = string & {
  readonly [campaignRevisionIdBrand]: "campaign_revision";
};
export type SourcePostRevisionId = string & {
  readonly [sourcePostRevisionIdBrand]: "source_post_revision";
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function brandedUuid<T extends string>(value: string, code: string): T {
  if (!uuidPattern.test(value)) {
    throw new TypeError(code);
  }
  return value as T;
}

export const createCampaignId = (value: string) =>
  brandedUuid<CampaignId>(value, "campaign_id_invalid");
export const createCampaignRevisionId = (value: string) =>
  brandedUuid<CampaignRevisionId>(value, "campaign_revision_id_invalid");
export const createSourcePostRevisionId = (value: string) =>
  brandedUuid<SourcePostRevisionId>(value, "source_post_revision_id_invalid");

export const campaignAudienceDefinition =
  Object.freeze({
    id: "canonical-consent-and-suppression",
    version: 1,
  }) satisfies CampaignAudienceDefinition;

export type CampaignAudienceDefinition = Readonly<{
  id: "canonical-consent-and-suppression";
  version: 1;
}>;

export type CampaignCallToAction = Readonly<{
  label: string;
  href: string;
}>;

export type CampaignEditableInput = Readonly<{
  subject: string;
  previewText: string;
  callToAction: CampaignCallToAction;
  emailContent: RichTextDocument;
}>;

export type CampaignChannelConfiguration = Readonly<{
  senderIdentityId: string;
  complianceFooter: Readonly<{
    version: string;
    content: string;
    unsubscribePlaceholder: string;
  }>;
  audienceDefinition: CampaignAudienceDefinition;
}>;

export type CampaignAuthoringInput =
  CampaignEditableInput & CampaignChannelConfiguration;

export type CampaignLifecycleState = "draft";

export type Campaign = Readonly<{
  id: CampaignId;
  siteId: SiteId;
  lifecycleState: CampaignLifecycleState;
  currentRevisionId: CampaignRevisionId;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

export type CampaignProvenance =
  | Readonly<{ kind: "standalone" }>
  | Readonly<{
      kind: "post_revision";
      postId: BlogPostId;
      postRevisionId: SourcePostRevisionId;
      postRevisionNumber: number;
    }>;

export type CampaignRevision = Readonly<
  CampaignAuthoringInput & {
    id: CampaignRevisionId;
    siteId: SiteId;
    campaignId: CampaignId;
    revisionNumber: number;
    provenance: CampaignProvenance;
    schemaVersion: SiteDefinition["schemaVersion"];
    rendererVersion: string;
    createdAt: string;
    createdByActorId: string;
  }
>;

export type CampaignActor = ExternalHumanIdentity;
export type CampaignAuthor = Readonly<{ id: string }>;

export type CampaignArtifact = Readonly<{
  channel: "html" | "text";
  bytes: string;
  fingerprint: string;
  schemaVersion: SiteDefinition["schemaVersion"];
  rendererVersion: string;
}>;

export type RenderedCampaign = Readonly<{
  campaignId: CampaignId;
  campaignRevisionId: CampaignRevisionId;
  revisionNumber: number;
  html: CampaignArtifact;
  text: CampaignArtifact;
  campaignFingerprint: string;
  eligibleSubscriberCount: number;
}>;

export type CampaignAuditEvent = Readonly<{
  id: string;
  siteId: SiteId;
  actorId: string;
  targetId: string;
  revisionId: CampaignRevisionId | null;
  requestId: string;
  inputHash: string;
  action:
    | "campaign.create"
    | "campaign.edit"
    | "campaign.test"
    | "campaign.bulk";
  outcome: "accepted" | "rejected";
  reason: string | null;
  beforeState: string | null;
  afterState: string | null;
  occurredAt: string;
}>;

export type CampaignCommandName =
  | "campaign.create_standalone"
  | "campaign.create_from_post"
  | "campaign.edit"
  | "campaign.request_test"
  | "campaign.confirm_test_receipt"
  | "campaign.authorize_bulk"
  | "campaign.activate_bulk_schedule"
  | "campaign.cancel_bulk_schedule"
  | "campaign.send_bulk_now"
  | "campaign.retry_bulk_send";

export function isCampaignRequestId(value: string): boolean {
  return (
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(value)
  );
}

export type CampaignCommandReceipt =
  | Readonly<{
      siteId: SiteId;
      actorId: string;
      commandName: CampaignCommandName;
      requestId: string;
      inputHash: string;
      outcome: "accepted";
      campaign: Campaign;
      revision: CampaignRevision;
      reason: null;
      completedAt: string;
    }>
  | Readonly<{
      siteId: SiteId;
      actorId: string;
      commandName: CampaignCommandName;
      requestId: string;
      inputHash: string;
      outcome: "rejected";
      campaign: null;
      revision: null;
      reason: string;
      completedAt: string;
    }>;

export type CampaignCommandKey = Readonly<
  Pick<
    CampaignCommandReceipt,
    "siteId" | "actorId" | "commandName" | "requestId" | "inputHash"
  >
>;

export type CampaignCommandStoreResult = Readonly<{
  receipt: CampaignCommandReceipt;
  replayed: boolean;
}>;

export type CampaignTestReceiptConfirmationRecord = Readonly<{
  executionId: string;
  siteId: SiteId;
  ownerActorId: string;
  requestId: string;
  confirmedAt: string;
}>;

export interface CampaignStore {
  findCommandReceipt(input: Omit<CampaignCommandKey, "inputHash">):
    Promise<CampaignCommandReceipt | null>;
  create(input: {
    command: CampaignCommandKey;
    campaign: Campaign;
    revision: CampaignRevision;
    acceptedAudit: CampaignAuditEvent;
    rejectedAudit: CampaignAuditEvent;
  }): Promise<CampaignCommandStoreResult>;
  findCampaign(input: {
    siteId: SiteId;
    campaignId: CampaignId;
  }): Promise<Campaign | null>;
  findRevision(input: {
    siteId: SiteId;
    campaignId: CampaignId;
    revisionNumber: number;
  }): Promise<CampaignRevision | null>;
  listCampaigns(siteId: SiteId): Promise<ReadonlyArray<Campaign>>;
  appendRevision(input: {
    command: CampaignCommandKey;
    expectedVersion: number;
    campaign: Campaign;
    revision: CampaignRevision;
    acceptedAudit: CampaignAuditEvent;
    rejectedAudit: CampaignAuditEvent;
  }): Promise<CampaignCommandStoreResult>;
  rejectCommand(input: {
    command: CampaignCommandKey;
    audit: CampaignAuditEvent;
  }): Promise<CampaignCommandStoreResult>;
  acceptTestCommand(input: {
    command: CampaignCommandKey;
    campaign: Campaign;
    revision: CampaignRevision;
    audit: CampaignAuditEvent;
  }): Promise<CampaignCommandStoreResult>;
  acceptTestReceiptConfirmation(input: {
    command: CampaignCommandKey;
    campaign: Campaign;
    revision: CampaignRevision;
    audit: CampaignAuditEvent;
    conflictAudit: CampaignAuditEvent;
    staleAudit: CampaignAuditEvent;
    authorityAudit: CampaignAuditEvent;
    confirmation: CampaignTestReceiptConfirmationRecord;
  }): Promise<CampaignCommandStoreResult>;
  recordAudit(event: CampaignAuditEvent): Promise<void>;
}

export type CampaignApplication = Readonly<{
  commands: Readonly<{
    createStandalone(input: {
      actor: CampaignActor;
      requestId: string;
      input: CampaignEditableInput;
    }): Promise<
      Readonly<{
        campaign: Campaign;
        revision: CampaignRevision;
        replayed: boolean;
      }>
    >;
    createFromPost(input: {
      actor: CampaignActor;
      requestId: string;
      sourcePostRevisionId: string;
    }): Promise<
      Readonly<{
        campaign: Campaign;
        revision: CampaignRevision;
        replayed: boolean;
      }>
    >;
    edit(input: {
      actor: CampaignActor;
      requestId: string;
      campaignId: CampaignId;
      expectedVersion: number;
      input: CampaignEditableInput;
    }): Promise<
      Readonly<{
        campaign: Campaign;
        revision: CampaignRevision;
        replayed: boolean;
      }>
    >;
    recordRejectedCommand(input: {
      actor: CampaignActor;
      requestId: string;
      reason: string;
      command: unknown;
      targetId?: string;
      beforeState?: string | null;
      action?: CampaignAuditEvent["action"];
      commandName?: CampaignCommandName;
    }): Promise<void>;
    replayTestCommand(input: {
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
    recordAcceptedTestCommand(input: {
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
      confirmation: CampaignTestReceiptConfirmationRecord;
    }): Promise<void>;
  }>;
  queries: Readonly<{
    getCampaign(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
    }): Promise<Campaign>;
    getRevision(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
      revisionNumber: number;
    }): Promise<CampaignRevision>;
    render(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
      revisionNumber?: number;
    }): Promise<RenderedCampaign>;
    listCampaigns(input: {
      actor: CampaignActor;
    }): Promise<
      ReadonlyArray<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>
    >;
  }>;
}>;

export type CampaignApplicationDependencies = Readonly<{
  siteId: SiteId;
  store: CampaignStore;
  authorize(
    actor: CampaignActor,
    capability: "campaign.author",
  ): Promise<CampaignAuthor>;
  identifyActor(actor: CampaignActor): string;
  findPostRevision(
    siteId: SiteId,
    revisionId: string,
  ): Promise<BlogPost | null>;
  resolveAudience(
    definition: CampaignAudienceDefinition,
  ): Promise<Readonly<{ eligibleSubscriberCount: number }>>;
  channelConfiguration: CampaignChannelConfiguration;
  rendererVersion: string;
  schemaVersion: SiteDefinition["schemaVersion"];
  clock?: () => Date;
  createId?: (kind: "campaign" | "campaign_revision" | "audit") => string;
}>;

export class CampaignNotFoundError extends Error {
  constructor() {
    super("campaign_not_found");
    this.name = "CampaignNotFoundError";
  }
}

export class CampaignConflictError extends Error {
  constructor() {
    super("campaign_revision_conflict");
    this.name = "CampaignConflictError";
  }
}

export class CampaignValidationError extends Error {
  constructor(code = "campaign_schema_invalid") {
    super(code);
    this.name = "CampaignValidationError";
  }
}

export class CampaignIdempotencyError extends Error {
  readonly code:
    | "campaign_idempotency_key_invalid"
    | "campaign_idempotency_key_reused";

  constructor(code: CampaignIdempotencyError["code"]) {
    super(code);
    this.name = "CampaignIdempotencyError";
    this.code = code;
  }
}

export type NewsletterUnsubscribeResolution = Readonly<{
  identityKey: string;
  providerEventId: string;
}>;

export interface NewsletterUnsubscribeAdapter {
  readonly unsubscribePlaceholder: string;
  createUnsubscribeUrl(input: {
    identityKey: string;
    expiresAt: string;
  }): Promise<string>;
  consumeUnsubscribeToken(token: string):
    Promise<NewsletterUnsubscribeResolution>;
}

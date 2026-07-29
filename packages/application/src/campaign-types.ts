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
  complianceFooter: Readonly<{ version: string; content: string }>;
  audienceDefinition: CampaignAudienceDefinition;
}>;

export type CampaignAuthoringInput =
  CampaignEditableInput & CampaignChannelConfiguration;

export type CampaignLifecycleState =
  | "draft"
  | "test_pending"
  | "tested"
  | "test_failed"
  | "approved"
  | "scheduled"
  | "schedule_missed"
  | "preparing_send"
  | "provider_queued"
  | "sending"
  | "sent"
  | "send_failed"
  | "cancelled";

export type Campaign = Readonly<{
  id: CampaignId;
  siteId: SiteId;
  lifecycleState: CampaignLifecycleState;
  currentRevisionId: CampaignRevisionId;
  testDeliveryId: string | null;
  bulkAuthorizationId: string | null;
  activeScheduleId: string | null;
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

export type CampaignMcpActor = Readonly<{
  type: "mcp";
  connectionId: string;
  siteId: SiteId;
}>;
export type CampaignActor = ExternalHumanIdentity | CampaignMcpActor;
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
  action: "campaign.create" | "campaign.edit";
  outcome: "accepted" | "rejected";
  reason: string | null;
  beforeState: string | null;
  afterState: string | null;
  occurredAt: string;
}>;

export interface CampaignStore {
  create(input: {
    campaign: Campaign;
    revision: CampaignRevision;
    audit: CampaignAuditEvent;
  }): Promise<boolean>;
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
    expectedVersion: number;
    campaign: Campaign;
    revision: CampaignRevision;
    audit: CampaignAuditEvent;
  }): Promise<boolean>;
  recordAudit(event: CampaignAuditEvent): Promise<void>;
}

export type CampaignApplication = Readonly<{
  commands: Readonly<{
    createStandalone(input: {
      actor: CampaignActor;
      input: CampaignEditableInput;
    }): Promise<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
    createFromPost(input: {
      actor: CampaignActor;
      sourcePostRevisionId: string;
    }): Promise<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
    edit(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
      expectedVersion: number;
      input: CampaignEditableInput;
    }): Promise<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
    recordRejectedCommand(input: {
      actor: CampaignActor;
      reason: string;
      targetId?: string;
      action?: CampaignAuditEvent["action"];
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

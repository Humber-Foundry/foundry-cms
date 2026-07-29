import {
  SAFE_RICH_TEXT_LINK_PATTERN,
  validateRichTextDocument,
  visitRichTextBlock,
  type BlogPost,
  type BlogPostId,
  type RichTextDocument,
  type RichTextLinkMark,
  type RichTextParagraph,
  type RichTextText,
  type SiteDefinition,
  type SiteId,
} from "@foundry/site-definition";

import {
  lengthDelimitedText,
  sha256Text,
} from "./deterministic-hash";
import type {
  ExternalHumanIdentity,
} from "./human-access";

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

export type CampaignAuthoringInput = Readonly<{
  subject: string;
  previewText: string;
  callToAction: CampaignCallToAction;
  emailContent: RichTextDocument;
  senderIdentityId: string;
  complianceFooter: Readonly<{ version: string; content: string }>;
  audienceDefinition: CampaignAudienceDefinition;
}>;

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
  providerCancellationRequired: boolean;
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
  saveRenderedArtifacts(input: {
    siteId: SiteId;
    campaignRevisionId: CampaignRevisionId;
    html: CampaignArtifact;
    text: CampaignArtifact;
    campaignFingerprint: string;
  }): Promise<void>;
  recordAudit(event: CampaignAuditEvent): Promise<void>;
}

export type CampaignApplication = Readonly<{
  commands: Readonly<{
    createStandalone(input: {
      actor: CampaignActor;
      input: CampaignAuthoringInput;
    }): Promise<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
    createFromPost(input: {
      actor: CampaignActor;
      sourcePostRevisionId: string;
      senderIdentityId: string;
      complianceFooter: CampaignAuthoringInput["complianceFooter"];
      audienceDefinition: CampaignAudienceDefinition;
    }): Promise<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
    edit(input: {
      actor: CampaignActor;
      campaignId: CampaignId;
      expectedVersion: number;
      input: CampaignAuthoringInput;
    }): Promise<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
    recordRejectedCommand(input: {
      actor: CampaignActor;
      reason: string;
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

function requireText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new CampaignValidationError();
  }
  return normalized;
}

const safeLink = new RegExp(SAFE_RICH_TEXT_LINK_PATTERN, "u");

function validateInput(input: CampaignAuthoringInput): CampaignAuthoringInput {
  const subject = requireText(input.subject, 200);
  const previewText = requireText(input.previewText, 1_000);
  const callToAction = Object.freeze({
    label: requireText(input.callToAction.label, 200),
    href: input.callToAction.href.trim(),
  });
  if (!safeLink.test(callToAction.href)) {
    throw new CampaignValidationError();
  }
  const emailContent = deepFreeze(
    validateRichTextDocument(structuredClone(input.emailContent)),
  );
  const senderIdentityId = requireText(input.senderIdentityId, 200);
  const complianceFooter = Object.freeze({
    version: requireText(input.complianceFooter.version, 200),
    content: requireText(input.complianceFooter.content, 2_000),
  });
  if (
    input.audienceDefinition.id !== campaignAudienceDefinition.id ||
    input.audienceDefinition.version !== campaignAudienceDefinition.version
  ) {
    throw new CampaignValidationError("campaign_audience_definition_invalid");
  }
  return Object.freeze({
    subject,
    previewText,
    callToAction,
    emailContent,
    senderIdentityId,
    complianceFooter,
    audienceDefinition: campaignAudienceDefinition,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderTextNode(node: RichTextText): string {
  let rendered = escapeHtml(node.text);
  if (node.marks.includes("bold")) {
    rendered = `<strong>${rendered}</strong>`;
  }
  if (node.marks.includes("italic")) {
    rendered = `<em>${rendered}</em>`;
  }
  const link = node.marks.find(
    (mark): mark is RichTextLinkMark =>
      typeof mark === "object" && mark.type === "link",
  );
  return link === undefined
    ? rendered
    : `<a href="${escapeHtml(link.href)}">${rendered}</a>`;
}

const renderInline = (children: RichTextParagraph["children"]) =>
  children.map(renderTextNode).join("");
const renderListItemInline = (
  item: Readonly<{ children: ReadonlyArray<RichTextParagraph> }>,
) => renderInline(item.children[0]!.children);

function renderRichTextHtml(document: RichTextDocument): string {
  return document.children
    .map((block) =>
      visitRichTextBlock(block, {
        paragraph: (paragraph) => `<p>${renderInline(paragraph.children)}</p>`,
        heading: (heading) =>
          `<h${heading.level}>${renderInline(heading.children)}</h${heading.level}>`,
        blockquote: (blockquote) =>
          `<blockquote>${blockquote.children
            .map(
              (paragraph) => `<p>${renderInline(paragraph.children)}</p>`,
            )
            .join("")}</blockquote>`,
        bulletList: (list) =>
          `<ul>${list.children
            .map(
              (item) =>
                `<li>${renderListItemInline(item)}</li>`,
            )
            .join("")}</ul>`,
        orderedList: (list) =>
          `<ol>${list.children
            .map(
              (item) =>
                `<li>${renderListItemInline(item)}</li>`,
            )
            .join("")}</ol>`,
      }),
    )
    .join("");
}

const renderPlainInline = (children: RichTextParagraph["children"]) =>
  children
    .map((node) => {
      const link = node.marks.find(
        (mark): mark is RichTextLinkMark =>
          typeof mark === "object" && mark.type === "link",
      );
      return link === undefined ? node.text : `${node.text} (${link.href})`;
    })
    .join("");

function renderRichTextPlain(document: RichTextDocument): string {
  return document.children
    .map((block) =>
      visitRichTextBlock(block, {
        paragraph: (paragraph) => renderPlainInline(paragraph.children),
        heading: (heading) => renderPlainInline(heading.children),
        blockquote: (blockquote) =>
          blockquote.children
            .map((paragraph) => `> ${renderPlainInline(paragraph.children)}`)
            .join("\n>\n"),
        bulletList: (list) =>
          list.children
            .map(
              (item) => `- ${renderPlainInline(item.children[0]!.children)}`,
            )
            .join("\n"),
        orderedList: (list) =>
          list.children
            .map(
              (item, index) =>
                `${index + 1}. ${renderPlainInline(
                  item.children[0]!.children,
                )}`,
            )
            .join("\n"),
      }),
    )
    .join("\n\n");
}

function renderCampaignBytes(revision: CampaignRevision) {
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(revision.subject)}</title></head><body>`,
    `<p>${escapeHtml(revision.previewText)}</p>`,
    renderRichTextHtml(revision.emailContent),
    `<p><a href="${escapeHtml(revision.callToAction.href)}">${escapeHtml(
      revision.callToAction.label,
    )}</a></p>`,
    `<footer>${escapeHtml(revision.complianceFooter.content)}</footer>`,
    "</body></html>",
  ].join("");
  const plainContent = renderRichTextPlain(revision.emailContent);
  const text = [
    revision.subject,
    "",
    revision.previewText,
    "",
    plainContent,
    "",
    `${revision.callToAction.label}: ${revision.callToAction.href}`,
    "",
    revision.complianceFooter.content,
    "",
  ].join("\n");
  return { html, text };
}

async function renderCampaign(
  revision: CampaignRevision,
  eligibleSubscriberCount: number,
): Promise<RenderedCampaign> {
  const bytes = renderCampaignBytes(revision);
  const htmlFingerprint = await sha256Text(
    lengthDelimitedText([
      "foundry.campaign-artifact.v1",
      "html",
      bytes.html,
    ]),
  );
  const textFingerprint = await sha256Text(
    lengthDelimitedText([
      "foundry.campaign-artifact.v1",
      "text",
      bytes.text,
    ]),
  );
  const htmlBytesHash = await sha256Text(bytes.html);
  const textBytesHash = await sha256Text(bytes.text);
  const campaignFingerprint = await sha256Text(
    lengthDelimitedText([
      "foundry.campaign-send.v1",
      revision.campaignId,
      revision.id,
      revision.subject,
      revision.previewText,
      htmlBytesHash,
      textBytesHash,
      revision.senderIdentityId,
      revision.complianceFooter.version,
      revision.audienceDefinition.id,
      String(revision.audienceDefinition.version),
      revision.schemaVersion,
      revision.rendererVersion,
    ]),
  );
  return Object.freeze({
    campaignId: revision.campaignId,
    campaignRevisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    html: Object.freeze({
      channel: "html",
      bytes: bytes.html,
      fingerprint: htmlFingerprint,
      schemaVersion: revision.schemaVersion,
      rendererVersion: revision.rendererVersion,
    }),
    text: Object.freeze({
      channel: "text",
      bytes: bytes.text,
      fingerprint: textFingerprint,
      schemaVersion: revision.schemaVersion,
      rendererVersion: revision.rendererVersion,
    }),
    campaignFingerprint,
    eligibleSubscriberCount,
  });
}

export function createCampaignApplication({
  siteId,
  store,
  authorize,
  findPostRevision,
  resolveAudience,
  rendererVersion,
  schemaVersion,
  clock = () => new Date(),
  createId = () => crypto.randomUUID(),
}: {
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
  rendererVersion: string;
  schemaVersion: SiteDefinition["schemaVersion"];
  clock?: () => Date;
  createId?: (kind: "campaign" | "campaign_revision" | "audit") => string;
}): CampaignApplication {
  async function requireAuthor(actor: CampaignActor) {
    return authorize(actor, "campaign.author");
  }
  const normalizedRendererVersion = requireText(rendererVersion, 40);
  if (!/^[a-f0-9]{40}$/u.test(normalizedRendererVersion)) {
    throw new CampaignValidationError("campaign_renderer_commit_invalid");
  }

  async function audited<T>(
    actor: CampaignActor,
    action: CampaignAuditEvent["action"],
    operation: () => Promise<T>,
    targetId = "campaign:new",
  ): Promise<T> {
    const actorId =
      "binding" in actor
        ? `human:${actor.binding.issuer}:${actor.binding.subject}`
        : `mcp:${actor.connectionId}`;
    try {
      return await operation();
    } catch (error) {
      const auditId = createId("audit");
      await store.recordAudit({
        id: auditId,
        siteId,
        actorId,
        targetId,
        requestId: auditId,
        action,
        outcome: "rejected",
        reason:
          error instanceof Error ? error.message : "campaign_command_rejected",
        beforeState: null,
        afterState: null,
        occurredAt: clock().toISOString(),
      });
      throw error;
    }
  }

  async function getCampaign(campaignId: CampaignId) {
    const campaign = await store.findCampaign({ siteId, campaignId });
    if (campaign === null) {
      throw new CampaignNotFoundError();
    }
    return campaign;
  }

  async function getRevision(
    campaignId: CampaignId,
    revisionNumber: number,
  ) {
    const revision = await store.findRevision({
      siteId,
      campaignId,
      revisionNumber,
    });
    if (revision === null) {
      throw new CampaignNotFoundError();
    }
    return revision;
  }

  async function createFirstRevision({
    author,
    auditActorId,
    input,
    provenance,
  }: {
    author: CampaignAuthor;
    auditActorId: string;
    input: CampaignAuthoringInput;
    provenance: CampaignProvenance;
  }) {
    const authored = validateInput(input);
    const campaignId = createCampaignId(createId("campaign"));
    const revisionId = createCampaignRevisionId(createId("campaign_revision"));
    const timestamp = clock().toISOString();
    const revision: CampaignRevision = Object.freeze({
      id: revisionId,
      siteId,
      campaignId,
      revisionNumber: 1,
      provenance,
      ...authored,
      schemaVersion,
      rendererVersion: normalizedRendererVersion,
      createdAt: timestamp,
      createdByActorId: author.id,
    });
    const campaign: Campaign = Object.freeze({
      id: campaignId,
      siteId,
      lifecycleState: "draft",
      currentRevisionId: revisionId,
      testDeliveryId: null,
      bulkAuthorizationId: null,
      activeScheduleId: null,
      providerCancellationRequired: false,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const auditId = createId("audit");
    const audit: CampaignAuditEvent = Object.freeze({
      id: auditId,
      siteId,
      actorId: auditActorId,
      targetId: campaign.id,
      requestId: auditId,
      action: "campaign.create",
      outcome: "accepted",
      reason: null,
      beforeState: null,
      afterState: JSON.stringify(campaign),
      occurredAt: timestamp,
    });
    if (!(await store.create({ campaign, revision, audit }))) {
      throw new CampaignConflictError();
    }
    return Object.freeze({ campaign, revision });
  }

  const commands: CampaignApplication["commands"] = Object.freeze({
      async recordRejectedCommand({ actor, reason }) {
        const auditId = createId("audit");
        await store.recordAudit({
          id: auditId,
          siteId,
          actorId:
            "binding" in actor
              ? `human:${actor.binding.issuer}:${actor.binding.subject}`
              : `mcp:${actor.connectionId}`,
          targetId: "campaign:unknown",
          requestId: auditId,
          action: "campaign.create",
          outcome: "rejected",
          reason,
          beforeState: null,
          afterState: null,
          occurredAt: clock().toISOString(),
        });
      },
      async createStandalone({ actor, input }) {
        return audited(actor, "campaign.create", async () => {
          const author = await requireAuthor(actor);
          return createFirstRevision({
            author,
            auditActorId:
              "binding" in actor
                ? `human:${actor.binding.issuer}:${actor.binding.subject}`
                : `mcp:${actor.connectionId}`,
            input,
            provenance: Object.freeze({ kind: "standalone" }),
          });
        });
      },
      async createFromPost({
        actor,
        sourcePostRevisionId,
        senderIdentityId,
        complianceFooter,
        audienceDefinition,
      }) {
        return audited(actor, "campaign.create", async () => {
          const author = await requireAuthor(actor);
          const postRevisionId = createSourcePostRevisionId(
            sourcePostRevisionId,
          );
          const post = await findPostRevision(siteId, postRevisionId);
          if (post === null) {
            throw new CampaignNotFoundError();
          }
          return createFirstRevision({
            author,
            auditActorId:
              "binding" in actor
                ? `human:${actor.binding.issuer}:${actor.binding.subject}`
                : `mcp:${actor.connectionId}`,
            input: {
            subject: post.title,
            previewText: post.excerpt,
            callToAction: {
              label: "Read more",
              href: `/blog/${post.slug}`,
            },
            emailContent: post.body,
            senderIdentityId,
            complianceFooter,
            audienceDefinition,
            },
            provenance: Object.freeze({
            kind: "post_revision",
            postId: post.id,
            postRevisionId,
            postRevisionNumber: post.revision,
            }),
          });
        });
      },
      async edit({ actor, campaignId, expectedVersion, input }) {
        return audited(actor, "campaign.edit", async () => {
          const author = await requireAuthor(actor);
          const current = await getCampaign(campaignId);
        if (
          current.version !== expectedVersion ||
          ["preparing_send", "provider_queued", "sending", "sent"].includes(
            current.lifecycleState,
          )
        ) {
          throw new CampaignConflictError();
        }
        const currentRevision = await getRevision(
          campaignId,
          current.version,
        );
        const authored = validateInput(input);
        const revisionId = createCampaignRevisionId(
          createId("campaign_revision"),
        );
        const timestamp = clock().toISOString();
        const revision: CampaignRevision = Object.freeze({
          id: revisionId,
          siteId,
          campaignId,
          revisionNumber: current.version + 1,
          provenance: currentRevision.provenance,
          ...authored,
          schemaVersion,
          rendererVersion: normalizedRendererVersion,
          createdAt: timestamp,
          createdByActorId: author.id,
        });
        const campaign: Campaign = Object.freeze({
          ...current,
          lifecycleState: "draft",
          currentRevisionId: revisionId,
          testDeliveryId: null,
          bulkAuthorizationId: null,
          activeScheduleId: null,
          providerCancellationRequired:
            current.testDeliveryId !== null ||
            current.bulkAuthorizationId !== null ||
            current.activeScheduleId !== null ||
            current.lifecycleState !== "draft",
          version: current.version + 1,
          updatedAt: timestamp,
        });
        if (
          !(await store.appendRevision({
            expectedVersion,
            campaign,
            revision,
            audit: (() => {
              const auditId = createId("audit");
              return Object.freeze({
              id: auditId,
              siteId,
              actorId:
                "binding" in actor
                  ? `human:${actor.binding.issuer}:${actor.binding.subject}`
                  : `mcp:${actor.connectionId}`,
              targetId: campaign.id,
              requestId: auditId,
              action: "campaign.edit",
              outcome: "accepted",
              reason: null,
              beforeState: JSON.stringify(current),
              afterState: JSON.stringify(campaign),
              occurredAt: timestamp,
              });
            })(),
          }))
        ) {
          throw new CampaignConflictError();
        }
          return Object.freeze({ campaign, revision });
        }, campaignId);
      },
    });
  const queries: CampaignApplication["queries"] = Object.freeze({
      async getCampaign({ actor, campaignId }) {
        await requireAuthor(actor);
        return getCampaign(campaignId);
      },
      async getRevision({ actor, campaignId, revisionNumber }) {
        await requireAuthor(actor);
        return getRevision(campaignId, revisionNumber);
      },
      async listCampaigns({ actor }) {
        await requireAuthor(actor);
        const campaigns = await store.listCampaigns(siteId);
        return Promise.all(
          campaigns.map(async (campaign) =>
            Object.freeze({
              campaign,
              revision: await getRevision(
                campaign.id,
                campaign.version,
              ),
            }),
          ),
        );
      },
      async render({ actor, campaignId, revisionNumber }) {
        await requireAuthor(actor);
        const campaign = await getCampaign(campaignId);
        const revision = await getRevision(
          campaignId,
          revisionNumber ?? campaign.version,
        );
        const audience = await resolveAudience(revision.audienceDefinition);
        const rendered = await renderCampaign(
          revision,
          audience.eligibleSubscriberCount,
        );
        await store.saveRenderedArtifacts({
          siteId,
          campaignRevisionId: revision.id,
          html: rendered.html,
          text: rendered.text,
          campaignFingerprint: rendered.campaignFingerprint,
        });
        return rendered;
      },
    });
  return Object.freeze({
    commands,
    queries,
  });
}

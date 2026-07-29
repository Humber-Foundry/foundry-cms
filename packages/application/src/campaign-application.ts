import {
  renderCampaignRevision,
  validateCampaignChannelConfiguration,
  validateCampaignInput,
} from "./campaign-renderer";
import {
  CampaignConflictError,
  CampaignNotFoundError,
  CampaignValidationError,
  createCampaignId,
  createCampaignRevisionId,
  createSourcePostRevisionId,
  type Campaign,
  type CampaignActor,
  type CampaignApplication,
  type CampaignApplicationDependencies,
  type CampaignAuditEvent,
  type CampaignAuthor,
  type CampaignEditableInput,
  type CampaignProvenance,
  type CampaignRevision,
} from "./campaign-types";

function stableRejectionReason(error: unknown): string {
  return error instanceof CampaignConflictError ||
    error instanceof CampaignNotFoundError ||
    error instanceof CampaignValidationError ||
    (error instanceof Error && /^[a-z][a-z0-9_]+$/u.test(error.message))
    ? error.message
    : "campaign_command_rejected";
}

export function createCampaignApplication({
  siteId,
  store,
  authorize,
  identifyActor,
  findPostRevision,
  resolveAudience,
  channelConfiguration,
  rendererVersion,
  schemaVersion,
  clock = () => new Date(),
  createId = () => crypto.randomUUID(),
}: CampaignApplicationDependencies): CampaignApplication {
  const configuredChannel =
    validateCampaignChannelConfiguration(channelConfiguration);
  const normalizedRendererVersion = rendererVersion.trim();
  if (!/^[a-f0-9]{40}$/u.test(normalizedRendererVersion)) {
    throw new CampaignValidationError("campaign_renderer_commit_invalid");
  }

  async function requireAuthor(actor: CampaignActor) {
    return authorize(actor, "campaign.author");
  }

  async function recordRejected(
    actor: CampaignActor,
    requestId: string,
    action: CampaignAuditEvent["action"],
    reason: string,
    targetId: string,
    beforeState: string | null = null,
  ) {
    const auditId = createId("audit");
    await store.recordAudit({
      id: auditId,
      siteId,
      actorId: identifyActor(actor),
      targetId,
      revisionId: null,
      requestId,
      action,
      outcome: "rejected",
      reason,
      beforeState,
      afterState: null,
      occurredAt: clock().toISOString(),
    });
  }

  async function audited<T>(
    actor: CampaignActor,
    requestId: string,
    action: CampaignAuditEvent["action"],
    operation: () => Promise<T>,
    targetId = "campaign:new",
    observedState: () => string | null = () => null,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await recordRejected(
        actor,
        requestId,
        action,
        stableRejectionReason(error),
        targetId,
        observedState(),
      );
      throw error;
    }
  }

  async function getCampaign(campaignId: Campaign["id"]) {
    const campaign = await store.findCampaign({ siteId, campaignId });
    if (campaign === null) throw new CampaignNotFoundError();
    return campaign;
  }

  async function getRevision(
    campaignId: Campaign["id"],
    revisionNumber: number,
  ) {
    const revision = await store.findRevision({
      siteId,
      campaignId,
      revisionNumber,
    });
    if (revision === null) throw new CampaignNotFoundError();
    return revision;
  }

  async function createFirstRevision({
    author,
    auditActorId,
    requestId,
    input,
    provenance,
  }: {
    author: CampaignAuthor;
    auditActorId: string;
    requestId: string;
    input: CampaignEditableInput;
    provenance: CampaignProvenance;
  }) {
    const authored = validateCampaignInput(input, configuredChannel);
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
      revisionId: revision.id,
      requestId,
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
    async recordRejectedCommand({
      actor,
      requestId,
      reason,
      targetId = "campaign:unknown",
      action = "campaign.create",
    }) {
      await recordRejected(actor, requestId, action, reason, targetId);
    },
    async createStandalone({ actor, requestId, input }) {
      return audited(actor, requestId, "campaign.create", async () => {
        const author = await requireAuthor(actor);
        return createFirstRevision({
          author,
          auditActorId: author.id,
          requestId,
          input,
          provenance: Object.freeze({ kind: "standalone" }),
        });
      });
    },
    async createFromPost({ actor, requestId, sourcePostRevisionId }) {
      return audited(actor, requestId, "campaign.create", async () => {
        const author = await requireAuthor(actor);
        const postRevisionId =
          createSourcePostRevisionId(sourcePostRevisionId);
        const post = await findPostRevision(siteId, postRevisionId);
        if (post === null) throw new CampaignNotFoundError();
        return createFirstRevision({
          author,
          auditActorId: author.id,
          requestId,
          input: {
            subject: post.title,
            previewText: post.excerpt,
            callToAction: {
              label: "Read more",
              href: `/blog/${post.slug}`,
            },
            emailContent: post.body,
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
    async edit({ actor, requestId, campaignId, expectedVersion, input }) {
      let observedState: string | null = null;
      return audited(
        actor,
        requestId,
        "campaign.edit",
        async () => {
          const author = await requireAuthor(actor);
          const current = await getCampaign(campaignId);
          observedState = JSON.stringify(current);
          if (current.version !== expectedVersion) {
            throw new CampaignConflictError();
          }
          const currentRevision = await getRevision(
            campaignId,
            current.version,
          );
          const authored = validateCampaignInput(input, configuredChannel);
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
            version: current.version + 1,
            updatedAt: timestamp,
          });
          const auditId = createId("audit");
          const audit: CampaignAuditEvent = Object.freeze({
            id: auditId,
            siteId,
            actorId: author.id,
            targetId: campaign.id,
            revisionId: revision.id,
            requestId,
            action: "campaign.edit",
            outcome: "accepted",
            reason: null,
            beforeState: JSON.stringify(current),
            afterState: JSON.stringify(campaign),
            occurredAt: timestamp,
          });
          if (
            !(await store.appendRevision({
              expectedVersion,
              campaign,
              revision,
              audit,
            }))
          ) {
            throw new CampaignConflictError();
          }
          return Object.freeze({ campaign, revision });
        },
        campaignId,
        () => observedState,
      );
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
            revision: await getRevision(campaign.id, campaign.version),
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
      return renderCampaignRevision(
        revision,
        audience.eligibleSubscriberCount,
      );
    },
  });

  return Object.freeze({ commands, queries });
}

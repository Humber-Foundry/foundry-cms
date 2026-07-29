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

function actorAuditId(actor: CampaignActor): string {
  return "binding" in actor
    ? `human:${actor.binding.issuer}:${actor.binding.subject}`
    : `mcp:${actor.connectionId}`;
}

export function createCampaignApplication({
  siteId,
  store,
  authorize,
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
    action: CampaignAuditEvent["action"],
    reason: string,
    targetId: string,
  ) {
    const auditId = createId("audit");
    await store.recordAudit({
      id: auditId,
      siteId,
      actorId: actorAuditId(actor),
      targetId,
      revisionId: null,
      requestId: auditId,
      action,
      outcome: "rejected",
      reason,
      beforeState: null,
      afterState: null,
      occurredAt: clock().toISOString(),
    });
  }

  async function audited<T>(
    actor: CampaignActor,
    action: CampaignAuditEvent["action"],
    operation: () => Promise<T>,
    targetId = "campaign:new",
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await recordRejected(
        actor,
        action,
        error instanceof Error ? error.message : "campaign_command_rejected",
        targetId,
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
    input,
    provenance,
  }: {
    author: CampaignAuthor;
    auditActorId: string;
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
      testDeliveryId: null,
      bulkAuthorizationId: null,
      activeScheduleId: null,
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
    async recordRejectedCommand({
      actor,
      reason,
      targetId = "campaign:unknown",
      action = "campaign.create",
    }) {
      await recordRejected(actor, action, reason, targetId);
    },
    async createStandalone({ actor, input }) {
      return audited(actor, "campaign.create", async () => {
        const author = await requireAuthor(actor);
        return createFirstRevision({
          author,
          auditActorId: actorAuditId(actor),
          input,
          provenance: Object.freeze({ kind: "standalone" }),
        });
      });
    },
    async createFromPost({ actor, sourcePostRevisionId }) {
      return audited(actor, "campaign.create", async () => {
        const author = await requireAuthor(actor);
        const postRevisionId =
          createSourcePostRevisionId(sourcePostRevisionId);
        const post = await findPostRevision(siteId, postRevisionId);
        if (post === null) throw new CampaignNotFoundError();
        return createFirstRevision({
          author,
          auditActorId: actorAuditId(actor),
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
    async edit({ actor, campaignId, expectedVersion, input }) {
      return audited(
        actor,
        "campaign.edit",
        async () => {
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
            testDeliveryId: null,
            bulkAuthorizationId: null,
            activeScheduleId: null,
            version: current.version + 1,
            updatedAt: timestamp,
          });
          const auditId = createId("audit");
          const audit: CampaignAuditEvent = Object.freeze({
            id: auditId,
            siteId,
            actorId: actorAuditId(actor),
            targetId: campaign.id,
            revisionId: revision.id,
            requestId: auditId,
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

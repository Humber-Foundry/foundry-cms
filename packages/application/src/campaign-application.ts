import {
  renderCampaignRevision,
  validateCampaignChannelConfiguration,
  validateCampaignInput,
} from "./campaign-renderer";
import { sha256CanonicalJson } from "./deterministic-hash";
import {
  CampaignConflictError,
  CampaignIdempotencyError,
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
  type CampaignCommandKey,
  type CampaignCommandName,
  type CampaignCommandReceipt,
  type CampaignCommandStoreResult,
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

function rejectionError(reason: string): Error {
  if (reason === "campaign_revision_conflict") {
    return new CampaignConflictError();
  }
  if (reason === "campaign_not_found") return new CampaignNotFoundError();
  return new CampaignValidationError(reason);
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
  const activeRendererCommit = rendererVersion.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(activeRendererCommit)) {
    throw new CampaignValidationError("campaign_renderer_commit_invalid");
  }

  async function requireAuthor(actor: CampaignActor) {
    return authorize(actor, "campaign.author");
  }

  function auditEvent({
    actorId,
    targetId,
    revisionId,
    requestId,
    action,
    outcome,
    reason,
    beforeState,
    afterState,
    occurredAt,
  }: Omit<CampaignAuditEvent, "id" | "siteId">): CampaignAuditEvent {
    return Object.freeze({
      id: createId("audit"),
      siteId,
      actorId,
      targetId,
      revisionId,
      requestId,
      action,
      outcome,
      reason,
      beforeState,
      afterState,
      occurredAt,
    });
  }

  async function recordRejected(
    actor: CampaignActor,
    requestId: string,
    action: CampaignAuditEvent["action"],
    reason: string,
    targetId: string,
    beforeState: string | null = null,
  ) {
    await store.recordAudit(
      auditEvent({
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
      }),
    );
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

  async function commandKey({
    author,
    requestId,
    commandName,
    input,
  }: {
    author: CampaignAuthor;
    requestId: string;
    commandName: CampaignCommandName;
    input: unknown;
  }): Promise<CampaignCommandKey> {
    if (
      requestId.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(requestId)
    ) {
      const action =
        commandName === "campaign.edit"
          ? "campaign.edit"
          : "campaign.create";
      await store.recordAudit(
        auditEvent({
          actorId: author.id,
          targetId: "campaign:unknown",
          revisionId: null,
          requestId:
            requestId === "" ? "campaign:missing" : requestId.slice(0, 200),
          action,
          outcome: "rejected",
          reason: "campaign_idempotency_key_invalid",
          beforeState: null,
          afterState: null,
          occurredAt: clock().toISOString(),
        }),
      );
      throw new CampaignIdempotencyError(
        "campaign_idempotency_key_invalid",
      );
    }
    return Object.freeze({
      siteId,
      actorId: author.id,
      commandName,
      requestId,
      inputHash: await sha256CanonicalJson(input),
    });
  }

  function resolveReceipt(
    result: CampaignCommandStoreResult,
    expectedInputHash: string,
  ) {
    const { receipt } = result;
    if (receipt.inputHash !== expectedInputHash) {
      throw new CampaignIdempotencyError(
        "campaign_idempotency_key_reused",
      );
    }
    if (receipt.outcome === "rejected") {
      throw rejectionError(receipt.reason);
    }
    return Object.freeze({
      campaign: receipt.campaign,
      revision: receipt.revision,
      replayed: result.replayed,
    });
  }

  async function replay(
    command: CampaignCommandKey,
  ): Promise<
    ReturnType<typeof resolveReceipt> | null
  > {
    const receipt = await store.findCommandReceipt(command);
    return receipt === null
      ? null
      : resolveReceipt(
          Object.freeze({ receipt, replayed: true }),
          command.inputHash,
        );
  }

  async function rejectCommand({
    command,
    action,
    error,
    targetId,
    beforeState = null,
  }: {
    command: CampaignCommandKey;
    action: CampaignAuditEvent["action"];
    error: unknown;
    targetId: string;
    beforeState?: string | null;
  }) {
    const reason = stableRejectionReason(error);
    const result = await store.rejectCommand({
      command,
      audit: auditEvent({
        actorId: command.actorId,
        targetId,
        revisionId: null,
        requestId: command.requestId,
        action,
        outcome: "rejected",
        reason,
        beforeState,
        afterState: null,
        occurredAt: clock().toISOString(),
      }),
    });
    return resolveReceipt(result, command.inputHash);
  }

  async function createFirstRevision({
    author,
    command,
    input,
    provenance,
  }: {
    author: CampaignAuthor;
    command: CampaignCommandKey;
    input: CampaignEditableInput;
    provenance: CampaignProvenance;
  }) {
    let authored;
    try {
      authored = validateCampaignInput(input, configuredChannel);
    } catch (error) {
      return rejectCommand({
        command,
        action: "campaign.create",
        error,
        targetId: "campaign:new",
      });
    }
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
      rendererVersion: activeRendererCommit,
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
    const acceptedAudit = auditEvent({
      actorId: author.id,
      targetId: campaign.id,
      revisionId: revision.id,
      requestId: command.requestId,
      action: "campaign.create",
      outcome: "accepted",
      reason: null,
      beforeState: null,
      afterState: JSON.stringify(campaign),
      occurredAt: timestamp,
    });
    const rejectedAudit = auditEvent({
      actorId: author.id,
      targetId: campaign.id,
      revisionId: null,
      requestId: command.requestId,
      action: "campaign.create",
      outcome: "rejected",
      reason: "campaign_revision_conflict",
      beforeState: null,
      afterState: null,
      occurredAt: timestamp,
    });
    return resolveReceipt(
      await store.create({
        command,
        campaign,
        revision,
        acceptedAudit,
        rejectedAudit,
      }),
      command.inputHash,
    );
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
      const author = await requireAuthor(actor);
      const command = await commandKey({
        author,
        requestId,
        commandName: "campaign.create_standalone",
        input,
      });
      const existing = await replay(command);
      return existing ?? createFirstRevision({
        author,
        command,
        input,
        provenance: Object.freeze({ kind: "standalone" }),
      });
    },
    async createFromPost({ actor, requestId, sourcePostRevisionId }) {
      const author = await requireAuthor(actor);
      const command = await commandKey({
        author,
        requestId,
        commandName: "campaign.create_from_post",
        input: { sourcePostRevisionId },
      });
      const existing = await replay(command);
      if (existing !== null) return existing;
      let postRevisionId;
      let post;
      try {
        postRevisionId = createSourcePostRevisionId(sourcePostRevisionId);
        post = await findPostRevision(siteId, postRevisionId);
        if (post === null) throw new CampaignNotFoundError();
      } catch (error) {
        return rejectCommand({
          command,
          action: "campaign.create",
          error,
          targetId: "campaign:new",
        });
      }
      return createFirstRevision({
        author,
        command,
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
    },
    async edit({ actor, requestId, campaignId, expectedVersion, input }) {
      const author = await requireAuthor(actor);
      const command = await commandKey({
        author,
        requestId,
        commandName: "campaign.edit",
        input: { campaignId, expectedVersion, input },
      });
      const existing = await replay(command);
      if (existing !== null) return existing;
      let current: Campaign;
      let currentRevision: CampaignRevision;
      let authored;
      try {
        current = await getCampaign(campaignId);
        if (current.version !== expectedVersion) {
          throw new CampaignConflictError();
        }
        currentRevision = await getRevision(campaignId, current.version);
        authored = validateCampaignInput(input, configuredChannel);
      } catch (error) {
        return rejectCommand({
          command,
          action: "campaign.edit",
          error,
          targetId: campaignId,
          beforeState:
            typeof current! === "undefined"
              ? null
              : JSON.stringify(current!),
        });
      }
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
        rendererVersion: activeRendererCommit,
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
      const beforeState = JSON.stringify(current);
      const acceptedAudit = auditEvent({
        actorId: author.id,
        targetId: campaign.id,
        revisionId: revision.id,
        requestId,
        action: "campaign.edit",
        outcome: "accepted",
        reason: null,
        beforeState,
        afterState: JSON.stringify(campaign),
        occurredAt: timestamp,
      });
      const rejectedAudit = auditEvent({
        actorId: author.id,
        targetId: campaign.id,
        revisionId: null,
        requestId,
        action: "campaign.edit",
        outcome: "rejected",
        reason: "campaign_revision_conflict",
        beforeState,
        afterState: null,
        occurredAt: timestamp,
      });
      return resolveReceipt(
        await store.appendRevision({
          command,
          expectedVersion,
          campaign,
          revision,
          acceptedAudit,
          rejectedAudit,
        }),
        command.inputHash,
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
      if (revision.rendererVersion !== activeRendererCommit) {
        throw new CampaignValidationError("campaign_renderer_mismatch");
      }
      const audience = await resolveAudience(revision.audienceDefinition);
      return renderCampaignRevision(
        revision,
        audience.eligibleSubscriberCount,
      );
    },
  });

  return Object.freeze({ commands, queries });
}

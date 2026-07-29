import {
  renderCampaignRevision,
  validateCampaignChannelConfiguration,
  validateCampaignInput,
} from "./campaign-renderer";
import { sha256CanonicalJson } from "./deterministic-hash";
import { AccessDeniedError } from "./human-access";
import {
  CampaignConflictError,
  CampaignIdempotencyError,
  CampaignNotFoundError,
  CampaignValidationError,
  createCampaignId,
  createCampaignRevisionId,
  createSourcePostRevisionId,
  isCampaignRequestId,
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
  if (reason === "capability_not_authorized") {
    return new AccessDeniedError(reason);
  }
  return new CampaignValidationError(reason);
}

function auditTargetId(targetId: string) {
  return targetId.length <= 200 &&
      /^[A-Za-z0-9:._-]+$/u.test(targetId)
    ? targetId
    : "campaign:invalid";
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
    inputHash,
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
      inputHash,
      action,
      outcome,
      reason,
      beforeState,
      afterState,
      occurredAt,
    });
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
    actorId,
    requestId,
    commandName,
    input,
  }: {
    actorId: string;
    requestId: string;
    commandName: CampaignCommandName;
    input: unknown;
  }): Promise<CampaignCommandKey> {
    const inputHash = await sha256CanonicalJson(input);
    if (!isCampaignRequestId(requestId)) {
      const action =
        commandName === "campaign.edit"
          ? "campaign.edit"
          : "campaign.create";
      await store.recordAudit(
        auditEvent({
          actorId,
          targetId: "campaign:unknown",
          revisionId: null,
          requestId:
            requestId === "" ? "campaign:missing" : requestId.slice(0, 200),
          inputHash,
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
      actorId,
      commandName,
      requestId,
      inputHash,
    });
  }

  async function resolveReceipt(
    result: CampaignCommandStoreResult,
    command: CampaignCommandKey,
    action: CampaignAuditEvent["action"],
  ) {
    const { receipt } = result;
    if (receipt.inputHash !== command.inputHash) {
      await store.recordAudit(
        auditEvent({
          actorId: command.actorId,
          targetId:
            receipt.outcome === "accepted"
              ? receipt.campaign.id
              : "campaign:unknown",
          revisionId: null,
          requestId: command.requestId,
          inputHash: command.inputHash,
          action,
          outcome: "rejected",
          reason: "campaign_idempotency_key_reused",
          beforeState: null,
          afterState: null,
          occurredAt: clock().toISOString(),
        }),
      );
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
    action: CampaignAuditEvent["action"],
  ) {
    const receipt = await store.findCommandReceipt(command);
    return receipt === null
      ? null
      : await resolveReceipt(
          Object.freeze({ receipt, replayed: true }),
          command,
          action,
        );
  }

  async function authorizeCommand(
    actor: CampaignActor,
    command: CampaignCommandKey,
    action: CampaignAuditEvent["action"],
    targetId = "campaign:unknown",
  ) {
    try {
      return await requireAuthor(actor);
    } catch (error) {
      const reason = stableRejectionReason(error);
      const event = auditEvent({
        actorId: command.actorId,
        targetId: auditTargetId(targetId),
        revisionId: null,
        requestId: command.requestId,
        inputHash: command.inputHash,
        action,
        outcome: "rejected",
        reason,
        beforeState: null,
        afterState: null,
        occurredAt: clock().toISOString(),
      });
      const result = await store.rejectCommand({
        command,
        audit: event,
      });
      if (
        result.replayed &&
        !(
          result.receipt.outcome === "rejected" &&
          result.receipt.reason === reason &&
          result.receipt.inputHash === command.inputHash
        )
      ) {
        await store.recordAudit(event);
      }
      throw error;
    }
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
        inputHash: command.inputHash,
        action,
        outcome: "rejected",
        reason,
        beforeState,
        afterState: null,
        occurredAt: clock().toISOString(),
      }),
    });
    return resolveReceipt(result, command, action);
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
      inputHash: command.inputHash,
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
      inputHash: command.inputHash,
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
      command,
      "campaign.create",
    );
  }

  const commands: CampaignApplication["commands"] = Object.freeze({
    async recordRejectedCommand({
      actor,
      requestId,
      reason,
      command: input,
      targetId = "campaign:unknown",
      action = "campaign.create",
      commandName =
        action === "campaign.edit"
          ? "campaign.edit"
          : "campaign.create_standalone",
    }) {
      const command = await commandKey({
        actorId: identifyActor(actor),
        requestId,
        commandName,
        input,
      });
      await authorizeCommand(actor, command, action, targetId);
      const existing = await store.findCommandReceipt(command);
      if (
        existing !== null &&
        existing.inputHash !== command.inputHash
      ) {
        await resolveReceipt(
          Object.freeze({ receipt: existing, replayed: true }),
          command,
          action,
        );
      }
      if (existing !== null) return;
      await store.rejectCommand({
        command,
        audit: auditEvent({
          actorId: command.actorId,
          targetId: auditTargetId(targetId),
          revisionId: null,
          requestId: command.requestId,
          inputHash: command.inputHash,
          action,
          outcome: "rejected",
          reason,
          beforeState: null,
          afterState: null,
          occurredAt: clock().toISOString(),
        }),
      });
    },
    async createStandalone({ actor, requestId, input }) {
      const command = await commandKey({
        actorId: identifyActor(actor),
        requestId,
        commandName: "campaign.create_standalone",
        input,
      });
      const author = await authorizeCommand(
        actor,
        command,
        "campaign.create",
      );
      const existing = await replay(command, "campaign.create");
      return existing ?? createFirstRevision({
        author,
        command,
        input,
        provenance: Object.freeze({ kind: "standalone" }),
      });
    },
    async createFromPost({ actor, requestId, sourcePostRevisionId }) {
      const command = await commandKey({
        actorId: identifyActor(actor),
        requestId,
        commandName: "campaign.create_from_post",
        input: { sourcePostRevisionId },
      });
      const author = await authorizeCommand(
        actor,
        command,
        "campaign.create",
      );
      const existing = await replay(command, "campaign.create");
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
      const command = await commandKey({
        actorId: identifyActor(actor),
        requestId,
        commandName: "campaign.edit",
        input: { campaignId, expectedVersion, input },
      });
      const author = await authorizeCommand(
        actor,
        command,
        "campaign.edit",
      );
      const existing = await replay(command, "campaign.edit");
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
        inputHash: command.inputHash,
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
        inputHash: command.inputHash,
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
        command,
        "campaign.edit",
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

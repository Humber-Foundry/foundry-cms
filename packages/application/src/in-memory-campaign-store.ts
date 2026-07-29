import type {
  Campaign,
  CampaignAuditEvent,
  CampaignCommandKey,
  CampaignCommandReceipt,
  CampaignCommandStoreResult,
  CampaignRevision,
  CampaignStore,
} from "./campaign";

export function createInMemoryCampaignStore(
  cancelOpenTestDeliveries?: (input: {
    siteId: Campaign["siteId"];
    campaignId: Campaign["id"];
    retainedRevisionId: CampaignRevision["id"];
    cancelledAt: string;
  }) => Promise<void>,
): CampaignStore & {
  listAuditEvents(): ReadonlyArray<CampaignAuditEvent>;
} {
  const campaigns = new Map<string, Campaign>();
  const revisions = new Map<string, CampaignRevision>();
  const audits: CampaignAuditEvent[] = [];
  const receipts = new Map<string, CampaignCommandReceipt>();
  const revisionKey = (
    revision: Pick<
      CampaignRevision,
      "siteId" | "campaignId" | "revisionNumber"
    >,
  ) => `${revision.siteId}:${revision.campaignId}:${revision.revisionNumber}`;
  const commandKey = (
    command: Omit<CampaignCommandKey, "inputHash">,
  ) =>
    `${command.siteId}:${command.actorId}:${command.commandName}:${command.requestId}`;

  function existingResult(
    command: CampaignCommandKey,
  ): CampaignCommandStoreResult | null {
    const receipt = receipts.get(commandKey(command));
    return receipt === undefined
      ? null
      : Object.freeze({ receipt, replayed: true });
  }

  function acceptedReceipt(
    command: CampaignCommandKey,
    campaign: Campaign,
    revision: CampaignRevision,
  ): CampaignCommandReceipt {
    return Object.freeze({
      ...command,
      outcome: "accepted",
      campaign,
      revision,
      reason: null,
      completedAt: revision.createdAt,
    });
  }

  function rejectedReceipt(
    command: CampaignCommandKey,
    audit: CampaignAuditEvent,
  ): CampaignCommandReceipt {
    return Object.freeze({
      ...command,
      outcome: "rejected",
      campaign: null,
      revision: null,
      reason: audit.reason ?? "campaign_command_rejected",
      completedAt: audit.occurredAt,
    });
  }

  const store: CampaignStore & {
    listAuditEvents(): ReadonlyArray<CampaignAuditEvent>;
  } = {
    async findCommandReceipt(command) {
      return receipts.get(commandKey(command)) ?? null;
    },
    async create({
      command,
      campaign,
      revision,
      acceptedAudit,
      rejectedAudit,
    }) {
      const existing = existingResult(command);
      if (existing !== null) return existing;
      if (campaigns.has(`${campaign.siteId}:${campaign.id}`)) {
        const receipt = rejectedReceipt(command, rejectedAudit);
        receipts.set(commandKey(command), receipt);
        audits.push(rejectedAudit);
        return Object.freeze({ receipt, replayed: false });
      }
      campaigns.set(`${campaign.siteId}:${campaign.id}`, campaign);
      revisions.set(revisionKey(revision), revision);
      audits.push(acceptedAudit);
      const receipt = acceptedReceipt(command, campaign, revision);
      receipts.set(commandKey(command), receipt);
      return Object.freeze({ receipt, replayed: false });
    },
    async findCampaign({ siteId, campaignId }) {
      return campaigns.get(`${siteId}:${campaignId}`) ?? null;
    },
    async findRevision({ siteId, campaignId, revisionNumber }) {
      return (
        revisions.get(`${siteId}:${campaignId}:${revisionNumber}`) ?? null
      );
    },
    async listCampaigns(siteId) {
      return [...campaigns.values()]
        .filter((campaign) => campaign.siteId === siteId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async appendRevision({
      command,
      expectedVersion,
      campaign,
      revision,
      acceptedAudit,
      rejectedAudit,
    }) {
      const existing = existingResult(command);
      if (existing !== null) return existing;
      const key = `${campaign.siteId}:${campaign.id}`;
      const current = campaigns.get(key);
      if (
        current === undefined ||
        current.version !== expectedVersion ||
        revisions.has(revisionKey(revision))
      ) {
        const receipt = rejectedReceipt(command, rejectedAudit);
        receipts.set(commandKey(command), receipt);
        audits.push(rejectedAudit);
        return Object.freeze({ receipt, replayed: false });
      }
      await cancelOpenTestDeliveries?.({
        siteId: campaign.siteId,
        campaignId: campaign.id,
        retainedRevisionId: revision.id,
        cancelledAt: revision.createdAt,
      });
      campaigns.set(key, campaign);
      revisions.set(revisionKey(revision), revision);
      audits.push(acceptedAudit);
      const receipt = acceptedReceipt(command, campaign, revision);
      receipts.set(commandKey(command), receipt);
      return Object.freeze({ receipt, replayed: false });
    },
    async rejectCommand({ command, audit }) {
      const existing = existingResult(command);
      if (existing !== null) return existing;
      const receipt = rejectedReceipt(command, audit);
      receipts.set(commandKey(command), receipt);
      audits.push(audit);
      return Object.freeze({ receipt, replayed: false });
    },
    async acceptTestCommand({ command, campaign, revision, audit }) {
      const existing = existingResult(command);
      if (existing !== null) return existing;
      const receipt = acceptedReceipt(command, campaign, revision);
      receipts.set(commandKey(command), receipt);
      audits.push(audit);
      return Object.freeze({ receipt, replayed: false });
    },
    async recordAudit(event) {
      audits.push(Object.freeze({ ...event }));
    },
    listAuditEvents() {
      return [...audits];
    },
  };
  return Object.freeze(store);
}

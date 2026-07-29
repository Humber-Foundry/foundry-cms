import type {
  Campaign,
  CampaignAuditEvent,
  CampaignRevision,
  CampaignStore,
} from "./campaign";

export function createInMemoryCampaignStore(): CampaignStore & {
  listAuditEvents(): ReadonlyArray<CampaignAuditEvent>;
} {
  const campaigns = new Map<string, Campaign>();
  const revisions = new Map<string, CampaignRevision>();
  const artifacts = new Map<string, string>();
  const audits: CampaignAuditEvent[] = [];
  const revisionKey = (
    revision: Pick<
      CampaignRevision,
      "siteId" | "campaignId" | "revisionNumber"
    >,
  ) => `${revision.siteId}:${revision.campaignId}:${revision.revisionNumber}`;

  const store: CampaignStore & {
    listAuditEvents(): ReadonlyArray<CampaignAuditEvent>;
  } = {
    async create({ campaign, revision, audit }) {
      if (campaigns.has(`${campaign.siteId}:${campaign.id}`)) {
        return false;
      }
      campaigns.set(`${campaign.siteId}:${campaign.id}`, campaign);
      revisions.set(revisionKey(revision), revision);
      audits.push(audit);
      return true;
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
    async appendRevision({ expectedVersion, campaign, revision, audit }) {
      const key = `${campaign.siteId}:${campaign.id}`;
      const current = campaigns.get(key);
      if (
        current === undefined ||
        current.version !== expectedVersion ||
        revisions.has(revisionKey(revision))
      ) {
        return false;
      }
      campaigns.set(key, campaign);
      revisions.set(revisionKey(revision), revision);
      audits.push(audit);
      return true;
    },
    async saveRenderedArtifacts(input) {
      const key = `${input.siteId}:${input.campaignRevisionId}`;
      const serialized = JSON.stringify({
        html: input.html,
        text: input.text,
        campaignFingerprint: input.campaignFingerprint,
      });
      const existing = artifacts.get(key);
      if (existing !== undefined && existing !== serialized) {
        throw new Error("campaign_artifact_immutable");
      }
      artifacts.set(key, serialized);
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

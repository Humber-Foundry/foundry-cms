import type { Campaign, CampaignRevision, CampaignStore } from "./campaign";

export function createInMemoryCampaignStore(): CampaignStore {
  const campaigns = new Map<string, Campaign>();
  const revisions = new Map<string, CampaignRevision>();
  const revisionKey = (
    revision: Pick<
      CampaignRevision,
      "siteId" | "campaignId" | "revisionNumber"
    >,
  ) => `${revision.siteId}:${revision.campaignId}:${revision.revisionNumber}`;

  const store: CampaignStore = {
    async create({ campaign, revision }) {
      if (campaigns.has(`${campaign.siteId}:${campaign.id}`)) {
        return false;
      }
      campaigns.set(`${campaign.siteId}:${campaign.id}`, campaign);
      revisions.set(revisionKey(revision), revision);
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
    async appendRevision({ expectedVersion, campaign, revision }) {
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
      return true;
    },
  };
  return Object.freeze(store);
}

import {
  createSubscriberId,
  requireCanonicalAudienceDefinition,
  type CampaignBulkAudienceRecipient,
  type CampaignRevision,
  type SubscriberLedgerStore,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

/**
 * Resolving a bulk audience is one rule, not two. Both the Owner's immediate
 * send and the scheduler read this module, so the eligibility a snapshot was
 * built from and the eligibility it is revalidated against can never drift
 * apart between those paths.
 */
export function createCampaignBulkAudience({
  siteId,
  store,
}: {
  siteId: SiteId;
  store: SubscriberLedgerStore;
}) {
  async function eligible(): Promise<
    ReadonlyArray<CampaignBulkAudienceRecipient>
  > {
    return (await store.listSubscribers(siteId))
      .filter(({ state, email }) => state === "active" && email !== null)
      .map((subscriber) => ({
        subscriberId: subscriber.id,
        identityKey: subscriber.identityKey,
        address: subscriber.email!,
      }));
  }

  return Object.freeze({
    /**
     * Every subscriber the revision's audience definition currently admits. A
     * subscriber with no address cannot be a recipient, so a bulk audience is
     * narrower than the definition's eligible count.
     */
    async resolve(revision: CampaignRevision) {
      requireCanonicalAudienceDefinition(revision.audienceDefinition);
      return eligible();
    },
    /**
     * Re-resolve exactly the named subscribers. One that is no longer eligible
     * is omitted rather than substituted, so the caller observes the audience
     * change instead of silently sending to a different recipient set.
     */
    async resolveByIds(subscriberIds: ReadonlyArray<string>) {
      const admitted = new Map(
        (await eligible()).map((recipient) => [
          recipient.subscriberId,
          recipient,
        ]),
      );
      return subscriberIds.flatMap((subscriberId) => {
        const recipient = admitted.get(createSubscriberId(subscriberId));
        return recipient === undefined ? [] : [recipient];
      });
    },
  });
}

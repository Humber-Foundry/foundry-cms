import "server-only";

import { createCampaignScheduleProposalApplication } from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";

import { createD1CampaignBulkStateStore } from "./d1-campaign-bulk-state-store";
import { createD1CampaignScheduleProposalStore } from "./d1-campaign-schedule-proposal-store";
import { createD1CampaignStore } from "./d1-campaign-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";

/**
 * The send-time requests waiting for a person, for Overview's "Needs
 * attention" list.
 *
 * This reads; it grants nothing and changes nothing. It answers with the
 * email's own subject, the time that was asked for, and who asked — never a
 * subscriber, an address or a count of people. See ADR-0039.
 */
export type PendingCampaignScheduleRequest = Readonly<{
  proposalId: string;
  campaignId: string;
  subject: string;
  createdBy: string;
  localDateTime: string;
  ianaTimeZone: string;
}>;

export async function loadPendingCampaignScheduleRequests(): Promise<
  ReadonlyArray<PendingCampaignScheduleRequest>
> {
  const environment = await loadHumanAccessEnvironment();
  const database = environment.FOUNDRY_DB;
  if (database === undefined) return [];
  const siteId = installedSiteDefinition.site.id;
  const campaigns = createD1CampaignStore(database);
  const bulkState = createD1CampaignBulkStateStore(database);
  const proposals = createCampaignScheduleProposalApplication({
    siteId,
    store: createD1CampaignScheduleProposalStore(database),
    loadCampaign: (campaignId) =>
      campaigns.findCampaign({ siteId, campaignId }),
    hasActiveSchedule: async (campaignId) =>
      (await bulkState.findCampaignBulkState({ siteId, campaignId }))
        .schedule !== null,
  });
  const pending = await proposals.queries.listPending();
  const described = await Promise.all(
    pending.map(
      async (proposal): Promise<PendingCampaignScheduleRequest | null> => {
        const campaign = await campaigns.findCampaign({
          siteId,
          campaignId: proposal.campaignId,
        });
        if (campaign === null) return null;
        const revision = await campaigns.findRevision({
          siteId,
          campaignId: proposal.campaignId,
          revisionNumber: campaign.version,
        });
        if (revision === null) return null;
        return {
          proposalId: proposal.id,
          campaignId: proposal.campaignId,
          subject: revision.subject,
          createdBy: proposal.createdBy,
          localDateTime: proposal.localDateTime,
          ianaTimeZone: proposal.ianaTimeZone,
        };
      },
    ),
  );
  return described.filter(
    (request): request is PendingCampaignScheduleRequest => request !== null,
  );
}

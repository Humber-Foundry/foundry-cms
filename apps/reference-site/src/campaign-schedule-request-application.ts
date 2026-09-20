import {
  createCampaignScheduleProposalApplication,
  type CampaignBulkStateStore,
  type CampaignScheduleProposalApplication,
  type CampaignScheduleProposalStore,
  type CampaignStore,
} from "@humber-foundry/application";
import type { SiteId } from "@humber-foundry/site-definition";

/**
 * One place to build the campaign schedule request application.
 *
 * A request is a proposal only: it creates no schedule and sends nothing. The
 * dashboard and the MCP path both build it here, so "which campaign is this
 * about" and "is a send already set for it" are answered the same way on both
 * paths. See ADR-0039.
 */

/** Build the request application from the stores this installation has. */
export function createCampaignScheduleRequests({
  siteId,
  campaigns,
  bulkState,
  proposals,
  timeZoneDatabaseVersion,
}: {
  siteId: SiteId;
  campaigns: CampaignStore;
  bulkState: CampaignBulkStateStore;
  proposals: CampaignScheduleProposalStore;
  /**
   * The time-zone database version a new request records. Only the path that
   * writes a request needs it; a path that only reads or declines never does.
   */
  timeZoneDatabaseVersion?: () => string | undefined;
}): CampaignScheduleProposalApplication {
  return createCampaignScheduleProposalApplication({
    siteId,
    store: proposals,
    ...(timeZoneDatabaseVersion === undefined
      ? {}
      : { timeZoneDatabaseVersion }),
    loadCampaign: (campaignId) =>
      campaigns.findCampaign({ siteId, campaignId }),
    hasActiveSchedule: async (campaignId) =>
      (await bulkState.findCampaignBulkState({ siteId, campaignId }))
        .schedule !== null,
  });
}

import {
  createCampaignScheduleProposalApplication,
  type CampaignBulkStateStore,
  type CampaignScheduleProposalApplication,
  type CampaignScheduleProposalStore,
  type CampaignStore,
} from "@humber-foundry/application";
import type { SiteId } from "@humber-foundry/site-definition";

import { createD1CampaignBulkStateStore } from "./d1-campaign-bulk-state-store";
import { createD1CampaignScheduleProposalStore } from "./d1-campaign-schedule-proposal-store";
import { createD1CampaignStore } from "./d1-campaign-store";
import type { HumanAccessEnvironment } from "./human-access-configuration";

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

/** The same, built from one D1 binding. */
export function createD1CampaignScheduleRequests(
  siteId: SiteId,
  database: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>,
): CampaignScheduleProposalApplication {
  return createCampaignScheduleRequests({
    siteId,
    campaigns: createD1CampaignStore(database),
    bulkState: createD1CampaignBulkStateStore(database),
    proposals: createD1CampaignScheduleProposalStore(database),
  });
}


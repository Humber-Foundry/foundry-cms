import "server-only";

import {
  type CampaignId,
  type CampaignScheduleProposal,
  type CampaignScheduleProposalApplication,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";

import { createD1CampaignScheduleRequests } from "./campaign-schedule-request-application";
import { createD1CampaignStore } from "./d1-campaign-store";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import { mcpScheduleRequestAgentName } from "./mcp-schedule-request-agent";
import type { HumanAccessEnvironment } from "./human-access-configuration";

/**
 * The send-time requests waiting for a person, named by the app that asked.
 *
 * This reads; it grants nothing and changes nothing. See ADR-0039.
 */

/**
 * One send-time request in the plain words every screen shows: which
 * campaign, which app asked, and the time in the zone the request itself
 * carries (ADR-0038 §4). It names no subscriber and no address.
 */
export type PendingCampaignScheduleRequest = Readonly<{
  proposalId: string;
  campaignId: string;
  agentName: string;
  localDateTime: string;
  ianaTimeZone: string;
}>;

/**
 * Name each request after the app that asked.
 *
 * A request a person made directly is left out, because this product never
 * shows that as an app's request — the rule ADR-0038 §3 fixed for a post.
 */
async function nameScheduleRequests(
  environment: HumanAccessEnvironment,
  proposals: ReadonlyArray<CampaignScheduleProposal>,
): Promise<ReadonlyArray<PendingCampaignScheduleRequest>> {
  const named = await Promise.all(
    proposals.map(async (proposal) => {
      const agentName = await mcpScheduleRequestAgentName(
        environment,
        proposal.createdBy,
      );
      return agentName === null
        ? null
        : {
            proposalId: proposal.id,
            campaignId: String(proposal.campaignId),
            agentName,
            localDateTime: proposal.localDateTime,
            ianaTimeZone: proposal.ianaTimeZone,
          };
    }),
  );
  return named.filter(
    (request): request is PendingCampaignScheduleRequest => request !== null,
  );
}

/**
 * Every pending request for this site, or one campaign's.
 *
 * A failure answers with an empty list, so a request store that cannot be
 * read never stops a screen loading. Overview already treats a post's
 * schedule request the same way.
 */
export async function loadPendingCampaignScheduleRequests({
  requests,
  environment,
  campaignId,
}: {
  requests: CampaignScheduleProposalApplication;
  /** The installation's own settings, read here when a caller has none. */
  environment?: HumanAccessEnvironment;
  campaignId?: CampaignId;
}): Promise<ReadonlyArray<PendingCampaignScheduleRequest>> {
  try {
    const settings = environment ?? (await loadHumanAccessEnvironment());
    const pending =
      campaignId === undefined
        ? await requests.queries.listPending()
        : [await requests.queries.pending({ campaignId })].filter(
            (proposal) => proposal !== null,
          );
    return await nameScheduleRequests(settings, pending);
  } catch {
    return [];
  }
}

/**
 * The pending requests Overview shows. Its list names the email, so this
 * reads each campaign's subject as well.
 */
export async function loadOverviewCampaignScheduleRequests(): Promise<
  ReadonlyArray<PendingCampaignScheduleRequest & { subject: string }>
> {
  try {
    const environment = await loadHumanAccessEnvironment();
    const database = environment.FOUNDRY_DB;
    if (database === undefined) return [];
    const siteId = installedSiteDefinition.site.id;
    const campaigns = createD1CampaignStore(database);
    const named = await loadPendingCampaignScheduleRequests({
      requests: createD1CampaignScheduleRequests(siteId, database),
      environment,
    });
    const described = await Promise.all(
      named.map(async (request) => {
        const campaign = await campaigns.findCampaign({
          siteId,
          campaignId: request.campaignId as CampaignId,
        });
        if (campaign === null) return null;
        const revision = await campaigns.findRevision({
          siteId,
          campaignId: campaign.id,
          revisionNumber: campaign.version,
        });
        return revision === null
          ? null
          : { ...request, subject: revision.subject };
      }),
    );
    return described.filter(
      (
        request,
      ): request is PendingCampaignScheduleRequest & { subject: string } =>
        request !== null,
    );
  } catch {
    return [];
  }
}

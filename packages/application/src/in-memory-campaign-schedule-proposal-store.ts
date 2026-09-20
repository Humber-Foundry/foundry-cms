import {
  CampaignScheduleProposalError,
  mcpCampaignOperationScopes,
  type CampaignScheduleProposal,
  type CampaignScheduleProposalStore,
} from "./campaign-schedule-proposals";

/**
 * The campaign schedule request store a development installation and the
 * tests use. It holds the same rules the D1 store holds: one request per
 * idempotency key, a decline that cannot be taken back, and a connection
 * admitted only when it holds the permission pinned to the command.
 */
export function createInMemoryCampaignScheduleProposalStore({
  humanAuthorities = new Set<string>(),
  mcpAuthorities = new Set<string>(),
}: {
  /** Membership ids that are an active Owner or Editor of the site. */
  humanAuthorities?: Set<string>;
  /** `<connectionId>:<actorId>:<scope>` for each granted permission. */
  mcpAuthorities?: Set<string>;
} = {}): CampaignScheduleProposalStore {
  const proposals = new Map<string, CampaignScheduleProposal>();
  const byRequest = new Map<string, string>();
  const declines = new Set<string>();

  function requestKey(
    siteId: string,
    campaignId: string,
    requestId: string,
  ) {
    return `${siteId}:${campaignId}:${requestId}`;
  }

  function newestUndeclined(siteId: string, campaignId: string) {
    return (
      [...proposals.values()]
        .filter(
          (proposal) =>
            proposal.siteId === siteId &&
            proposal.campaignId === campaignId &&
            !declines.has(proposal.id),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .at(0) ?? null
    );
  }

  return Object.freeze({
    async findByRequest({ siteId, campaignId, requestId }) {
      const id = byRequest.get(
        requestKey(String(siteId), campaignId, requestId),
      );
      return id === undefined ? null : (proposals.get(id) ?? null);
    },
    async save(proposal, requestId) {
      const key = requestKey(
        String(proposal.siteId),
        proposal.campaignId,
        requestId,
      );
      const existing = byRequest.get(key);
      if (existing !== undefined) {
        return proposals.get(existing)!;
      }
      proposals.set(proposal.id, proposal);
      byRequest.set(key, proposal.id);
      return proposal;
    },
    async findNewestUndeclined({ siteId, campaignId }) {
      return newestUndeclined(String(siteId), campaignId);
    },
    async listNewestUndeclined({ siteId }) {
      const campaignIds = new Set(
        [...proposals.values()]
          .filter((proposal) => proposal.siteId === siteId)
          .map((proposal) => proposal.campaignId),
      );
      return Object.freeze(
        [...campaignIds]
          .map((campaignId) => newestUndeclined(String(siteId), campaignId))
          .filter(
            (proposal): proposal is CampaignScheduleProposal =>
              proposal !== null,
          )
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          ),
      );
    },
    async decline({ siteId, proposalId }) {
      const proposal = proposals.get(proposalId);
      if (proposal === undefined || proposal.siteId !== siteId) {
        throw new CampaignScheduleProposalError(
          "schedule_request_not_found",
        );
      }
      declines.add(proposalId);
      return proposal;
    },
    async hasMcpAuthority({ connectionId, actorId, operation, requiredScopes }) {
      const granted = (scope: string) =>
        mcpAuthorities.has(`${connectionId}:${actorId}:${scope}`);
      return (
        requiredScopes.length > 0 &&
        granted(mcpCampaignOperationScopes[operation]) &&
        requiredScopes.every(granted)
      );
    },
    async hasHumanAuthority({ actorId }) {
      return humanAuthorities.has(actorId);
    },
  });
}

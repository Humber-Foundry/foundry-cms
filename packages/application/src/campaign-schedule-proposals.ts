import type { SiteId } from "@humber-foundry/site-definition";

import {
  campaignScheduleCivilTime,
  requireResolvedFutureTime,
  type CampaignBulkResolvedTime,
} from "./campaign-bulk-delivery";
import type { Campaign, CampaignId, CampaignRevisionId } from "./campaign-types";

/**
 * A campaign schedule request: an app asks a person to send one newsletter at
 * a named time.
 *
 * This layer records the request and nothing else. It creates no schedule, it
 * authorizes no send, and it never touches the subscriber list. A person turns
 * a request into a real send through the Newsletter screen's own send and
 * schedule controls, which still need the Owner's test confirmation and the
 * Owner's approval of that exact email. See ADR-0039, and ADR-0036 for the
 * blog request this copies.
 */

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{15,199}$/u;

/**
 * Which campaign operations an MCP connection may carry out in its own name,
 * and the one permission each of them needs.
 *
 * The permission is pinned to the command here. It is never read out of the
 * caller's own list, so a request that asked for a different permission
 * cannot reach this command. The D1 statement pins the same value again, so
 * neither check stands alone. See ADR-0036 §2 and ADR-0039.
 */
export const mcpCampaignOperationScopes = Object.freeze({
  "foundry.campaign.schedule_request": "publication.schedule",
} as const);

export type McpCampaignOperation = keyof typeof mcpCampaignOperationScopes;

export type McpCampaignOperationAuthority = Readonly<{
  kind: "mcp";
  connectionId: string;
  actorId: string;
  operation: McpCampaignOperation;
  requiredScopes: ReadonlyArray<string>;
}>;

export type CampaignScheduleProposal = Readonly<{
  id: string;
  siteId: SiteId | string;
  campaignId: CampaignId;
  /** The exact email revision the request was made against. */
  campaignRevisionId: CampaignRevisionId;
  campaignVersion: number;
  localDateTime: string;
  ianaTimeZone: string;
  utcOffsetChoice: string;
  executeAtUtc: string;
  timeZoneDatabaseVersion: string;
  /**
   * The actor that asked. An MCP connection's id carries the `mcp-` prefix,
   * exactly as a blog schedule request does, so a request an app made and a
   * request a person made are told apart afterwards.
   */
  createdBy: string;
  createdAt: string;
}>;

export class CampaignScheduleProposalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CampaignScheduleProposalError";
  }
}

export type CampaignScheduleProposalStore = Readonly<{
  findByRequest(input: {
    siteId: SiteId | string;
    campaignId: CampaignId;
    idempotencyKey: string;
  }): Promise<CampaignScheduleProposal | null>;
  /**
   * Save one request. `authority` is present when an MCP connection asked, in
   * which case the statement admits the connection instead of a membership.
   */
  save(
    proposal: CampaignScheduleProposal,
    idempotencyKey: string,
    authority?: McpCampaignOperationAuthority,
  ): Promise<CampaignScheduleProposal>;
  /**
   * The newest request for this campaign that no person has declined, or
   * `null`. Whether an active schedule already answers it is decided by the
   * application, in one place, for every store.
   */
  findNewestUndeclined(input: {
    siteId: SiteId | string;
    campaignId: CampaignId;
  }): Promise<CampaignScheduleProposal | null>;
  /** The same, for every campaign of one site. */
  listNewestUndeclined(input: {
    siteId: SiteId | string;
  }): Promise<ReadonlyArray<CampaignScheduleProposal>>;
  /**
   * A person's decision to decline one request. There is no MCP variant: an
   * agent may not answer its own request. See ADR-0038 §2.
   */
  decline(input: {
    siteId: SiteId | string;
    proposalId: string;
    idempotencyKey: string;
    declinedBy: string;
    occurredAt: string;
  }): Promise<CampaignScheduleProposal>;
  hasMcpAuthority(input: {
    siteId: SiteId | string;
    connectionId: string;
    actorId: string;
    operation: McpCampaignOperation;
    requiredScopes: ReadonlyArray<string>;
  }): Promise<boolean>;
  /** Whether this membership is an active Owner or Editor of the site. */
  hasHumanAuthority(input: {
    siteId: SiteId | string;
    actorId: string;
  }): Promise<boolean>;
}>;

export type CampaignScheduleProposalApplication = Readonly<{
  commands: Readonly<{
    proposeSchedule(input: {
      actorId: string;
      campaignId: CampaignId;
      resolvedTime: Omit<CampaignBulkResolvedTime, "timeZoneDatabaseVersion">;
      idempotencyKey: string;
      authority?: McpCampaignOperationAuthority;
    }): Promise<CampaignScheduleProposal>;
    decline(input: {
      actorId: string;
      proposalId: string;
      idempotencyKey: string;
    }): Promise<CampaignScheduleProposal>;
  }>;
  queries: Readonly<{
    pending(input: {
      campaignId: CampaignId;
    }): Promise<CampaignScheduleProposal | null>;
    listPending(): Promise<ReadonlyArray<CampaignScheduleProposal>>;
  }>;
}>;

/**
 * Turn the instant and time zone an app named into the resolved civil time a
 * request records. It is the campaign side of what
 * `resolvePostPublicationInstant` does for a blog request, and it uses the
 * same offset and local-time arithmetic the campaign schedule itself uses,
 * so one campaign time rule holds for a request and for the schedule a
 * person makes from it.
 */
export function resolveCampaignScheduleTime(
  sendAt: string,
  reportingTimeZone: string,
): Omit<CampaignBulkResolvedTime, "timeZoneDatabaseVersion"> {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(sendAt)
  ) {
    throw new CampaignScheduleProposalError("schedule_instant_invalid");
  }
  const instant = new Date(sendAt);
  if (!Number.isFinite(instant.getTime())) {
    throw new CampaignScheduleProposalError("schedule_instant_invalid");
  }
  try {
    return campaignScheduleCivilTime(instant, reportingTimeZone);
  } catch {
    throw new CampaignScheduleProposalError("iana_time_zone_invalid");
  }
}

export function createCampaignScheduleProposalApplication({
  siteId,
  store,
  loadCampaign,
  hasActiveSchedule,
  now = () => new Date().toISOString(),
  createId = () => `schedule_request_${crypto.randomUUID()}`,
  timeZoneDatabaseVersion = () =>
    (
      globalThis as typeof globalThis & {
        process?: { versions?: { tz?: string } };
      }
    ).process?.versions?.tz,
}: {
  siteId: SiteId;
  store: CampaignScheduleProposalStore;
  /** The campaign as it stands, or `null` when this site has no such one. */
  loadCampaign(campaignId: CampaignId): Promise<Campaign | null>;
  /**
   * Whether a send is already set for this campaign. A request that a person
   * has already answered with a real schedule is not pending any more, which
   * is the rule ADR-0038 §1 fixed for a blog request.
   */
  hasActiveSchedule(campaignId: CampaignId): Promise<boolean>;
  now?: () => string;
  createId?: () => string;
  timeZoneDatabaseVersion?: () => string | undefined;
}): CampaignScheduleProposalApplication {
  function requireRequestId(value: string) {
    if (!requestIdPattern.test(value)) {
      throw new CampaignScheduleProposalError(
        "schedule_request_idempotency_key_invalid",
      );
    }
  }

  /**
   * Admit the caller. A connection is admitted as itself: it must hold the
   * one permission this command needs and every permission its request
   * evaluated, and the evaluated list may not be empty. A person is admitted
   * as an active Owner or Editor.
   */
  async function requireAuthority(
    actorId: string,
    authority: McpCampaignOperationAuthority | undefined,
  ) {
    if (authority === undefined) {
      if (!(await store.hasHumanAuthority({ siteId, actorId }))) {
        throw new CampaignScheduleProposalError("human_authority_required");
      }
      return;
    }
    const pinned = mcpCampaignOperationScopes[authority.operation];
    if (
      authority.requiredScopes.length === 0 ||
      !authority.requiredScopes.includes(pinned) ||
      !(await store.hasMcpAuthority({
        siteId,
        connectionId: authority.connectionId,
        actorId: authority.actorId,
        operation: authority.operation,
        requiredScopes: authority.requiredScopes,
      }))
    ) {
      throw new CampaignScheduleProposalError(
        "mcp_schedule_authority_required",
      );
    }
  }

  async function pendingFor(campaignId: CampaignId) {
    const proposal = await store.findNewestUndeclined({ siteId, campaignId });
    if (proposal === null) return null;
    return (await hasActiveSchedule(campaignId)) ? null : proposal;
  }

  const commands: CampaignScheduleProposalApplication["commands"] =
    Object.freeze({
      async proposeSchedule(input) {
        await requireAuthority(input.actorId, input.authority);
        requireRequestId(input.idempotencyKey);
        const replay = await store.findByRequest({
          siteId,
          campaignId: input.campaignId,
          idempotencyKey: input.idempotencyKey,
        });
        if (replay !== null) {
          if (
            replay.campaignId !== input.campaignId ||
            replay.localDateTime !== input.resolvedTime.localDateTime ||
            replay.ianaTimeZone !== input.resolvedTime.ianaTimeZone ||
            replay.utcOffsetChoice !== input.resolvedTime.utcOffsetChoice ||
            replay.executeAtUtc !== input.resolvedTime.executeAtUtc ||
            replay.createdBy !== input.actorId
          ) {
            throw new CampaignScheduleProposalError(
              "schedule_request_idempotency_key_reused",
            );
          }
          return replay;
        }
        const tzdbVersion = timeZoneDatabaseVersion();
        if (
          tzdbVersion === undefined ||
          !/^[0-9]{4}[a-z]$/u.test(tzdbVersion)
        ) {
          throw new CampaignScheduleProposalError(
            "time_zone_database_version_unavailable",
          );
        }
        try {
          requireResolvedFutureTime(
            { ...input.resolvedTime, timeZoneDatabaseVersion: tzdbVersion },
            new Date(now()),
          );
        } catch (error) {
          throw new CampaignScheduleProposalError(
            error instanceof Error && /^[a-z][a-z0-9_]+$/u.test(error.message)
              ? error.message
              : "bulk_schedule_time_invalid",
          );
        }
        const campaign = await loadCampaign(input.campaignId);
        if (campaign === null) {
          throw new CampaignScheduleProposalError("campaign_not_found");
        }
        // A campaign whose send is already set has nothing left to ask for. A
        // request recorded now would answer `pending_human_approval` while
        // every screen showed nothing pending, so refuse it by name instead.
        if (await hasActiveSchedule(campaign.id)) {
          throw new CampaignScheduleProposalError(
            "campaign_send_already_scheduled",
          );
        }
        return store.save(
          Object.freeze({
            id: createId(),
            siteId,
            campaignId: campaign.id,
            campaignRevisionId: campaign.currentRevisionId,
            campaignVersion: campaign.version,
            ...input.resolvedTime,
            timeZoneDatabaseVersion: tzdbVersion,
            createdBy: input.actorId,
            createdAt: now(),
          }),
          input.idempotencyKey,
          input.authority,
        );
      },
      async decline(input) {
        if (!(await store.hasHumanAuthority({ siteId, actorId: input.actorId }))) {
          throw new CampaignScheduleProposalError("human_authority_required");
        }
        requireRequestId(input.idempotencyKey);
        return store.decline({
          siteId,
          proposalId: input.proposalId,
          idempotencyKey: input.idempotencyKey,
          declinedBy: input.actorId,
          occurredAt: now(),
        });
      },
    });
  const queries: CampaignScheduleProposalApplication["queries"] =
    Object.freeze({
      async pending({ campaignId }) {
        return pendingFor(campaignId);
      },
      async listPending() {
        const proposals = await store.listNewestUndeclined({ siteId });
        const answered = await Promise.all(
          proposals.map(async (proposal) =>
            (await hasActiveSchedule(proposal.campaignId)) ? null : proposal,
          ),
        );
        return Object.freeze(
          answered.filter(
            (proposal): proposal is CampaignScheduleProposal =>
              proposal !== null,
          ),
        );
      },
    });

  return Object.freeze({ commands, queries });
}

import {
  CampaignScheduleProposalError,
  createCampaignId,
  createCampaignRevisionId,
  mcpCampaignOperationScopes,
  type CampaignScheduleProposal,
  type CampaignScheduleProposalStore,
  type McpCampaignOperationAuthority,
} from "@humber-foundry/application";

import { contentAuthoritySql } from "./d1-blog-post-content-authority";
import type { D1DatabaseBinding } from "./d1-human-access-store";

/**
 * The durable store behind a campaign schedule request.
 *
 * Every rule the application applies is applied here again in SQL. The insert
 * admits a person only as an active Owner or Editor, and admits a connection
 * only as itself, holding the permission pinned to the command and every
 * permission its request evaluated. The decline admits a person only. Neither
 * table can be updated or deleted once written. See ADR-0039.
 */

type ProposalRow = Readonly<{
  id: string;
  site_id: string;
  campaign_id: string;
  campaign_revision_id: string;
  campaign_version: number;
  local_date_time: string;
  iana_time_zone: string;
  utc_offset_choice: string;
  execute_at_utc: string;
  time_zone_database_version: string;
  created_by: string;
  created_at: string;
}>;

const proposalProjection = `
  id, site_id, campaign_id, campaign_revision_id, campaign_version,
  local_date_time, iana_time_zone, utc_offset_choice, execute_at_utc,
  time_zone_database_version, created_by, created_at
`;

function proposalFromRow(row: ProposalRow): CampaignScheduleProposal {
  return Object.freeze({
    id: row.id,
    siteId: row.site_id,
    campaignId: createCampaignId(row.campaign_id),
    campaignRevisionId: createCampaignRevisionId(row.campaign_revision_id),
    campaignVersion: row.campaign_version,
    localDateTime: row.local_date_time,
    ianaTimeZone: row.iana_time_zone,
    utcOffsetChoice: row.utc_offset_choice,
    executeAtUtc: row.execute_at_utc,
    timeZoneDatabaseVersion: row.time_zone_database_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
  });
}

function sameRequest(
  row: ProposalRow,
  proposal: CampaignScheduleProposal,
): boolean {
  return (
    row.site_id === String(proposal.siteId) &&
    row.campaign_id === proposal.campaignId &&
    row.local_date_time === proposal.localDateTime &&
    row.iana_time_zone === proposal.ianaTimeZone &&
    row.utc_offset_choice === proposal.utcOffsetChoice &&
    row.execute_at_utc === proposal.executeAtUtc &&
    row.created_by === proposal.createdBy
  );
}

/**
 * The four authority binds the shared `contentAuthoritySql` fragment reads, or
 * nulls when a person asked. The pinned permission is taken from the command
 * here too, never from the caller's own list.
 */
function campaignAuthorityBinds(
  authority: McpCampaignOperationAuthority | undefined,
): readonly [string | null, string | null, string | null, string | null] {
  return authority === undefined
    ? [null, null, null, null]
    : [
        authority.connectionId,
        authority.actorId,
        JSON.stringify(authority.requiredScopes),
        mcpCampaignOperationScopes[authority.operation],
      ];
}

export function createD1CampaignScheduleProposalStore(
  database: D1DatabaseBinding,
): CampaignScheduleProposalStore {
  const store: CampaignScheduleProposalStore = Object.freeze({
    async findByRequest({ siteId, campaignId, idempotencyKey }) {
      const row = await database
        .prepare(
          `SELECT ${proposalProjection}
           FROM campaign_schedule_proposals
           WHERE site_id = ?1 AND campaign_id = ?2 AND request_id = ?3`,
        )
        .bind(siteId, campaignId, idempotencyKey)
        .first<ProposalRow>();
      return row === null ? null : proposalFromRow(row);
    },
    async save(proposal, idempotencyKey, authority) {
      const replay = await store.findByRequest({
        siteId: proposal.siteId,
        campaignId: proposal.campaignId,
        idempotencyKey,
      });
      if (replay !== null) return replay;
      const inserted = await database
        .prepare(
          `INSERT INTO campaign_schedule_proposals (
             id, site_id, campaign_id, campaign_revision_id, campaign_version,
             local_date_time, iana_time_zone, utc_offset_choice,
             execute_at_utc, time_zone_database_version, created_by,
             request_id, created_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
           WHERE EXISTS (
             SELECT 1 FROM campaigns
             WHERE site_id = ?2 AND id = ?3
               AND current_revision_id = ?4
               AND version = ?5
           )
           AND ${contentAuthoritySql({
             site: "?2",
             actor: "?11",
             connection: "?14",
             mcpActor: "?15",
             scopes: "?16",
             pinnedScope: "?17",
           })}
           ON CONFLICT (site_id, campaign_id, request_id) DO NOTHING`,
        )
        .bind(
          proposal.id,
          proposal.siteId,
          proposal.campaignId,
          proposal.campaignRevisionId,
          proposal.campaignVersion,
          proposal.localDateTime,
          proposal.ianaTimeZone,
          proposal.utcOffsetChoice,
          proposal.executeAtUtc,
          proposal.timeZoneDatabaseVersion,
          proposal.createdBy,
          idempotencyKey,
          proposal.createdAt,
          ...campaignAuthorityBinds(authority),
        )
        .run();
      if ((inserted.meta.changes ?? 0) === 1) return proposal;
      // Nothing was written. Either another request with this key won the
      // race, or the caller is not allowed to ask. Tell those apart, and
      // report the same named reason the application would.
      const concurrent = await database
        .prepare(
          `SELECT ${proposalProjection}
           FROM campaign_schedule_proposals
           WHERE site_id = ?1 AND campaign_id = ?2 AND request_id = ?3`,
        )
        .bind(proposal.siteId, proposal.campaignId, idempotencyKey)
        .first<ProposalRow>();
      if (concurrent !== null) {
        if (sameRequest(concurrent, proposal)) {
          return proposalFromRow(concurrent);
        }
        throw new CampaignScheduleProposalError(
          "schedule_request_idempotency_key_reused",
        );
      }
      const allowed =
        authority === undefined
          ? await store.hasHumanAuthority({
              siteId: proposal.siteId,
              actorId: proposal.createdBy,
            })
          : await store.hasMcpAuthority({
              siteId: proposal.siteId,
              connectionId: authority.connectionId,
              actorId: authority.actorId,
              operation: authority.operation,
              requiredScopes: authority.requiredScopes,
            });
      throw new CampaignScheduleProposalError(
        allowed
          ? "schedule_request_campaign_stale"
          : authority === undefined
            ? "human_authority_required"
            : "mcp_schedule_authority_required",
      );
    },
    async findNewestUndeclined({ siteId, campaignId }) {
      const row = await database
        .prepare(
          `SELECT ${proposalProjection}
           FROM campaign_schedule_proposals AS proposal
           WHERE proposal.site_id = ?1 AND proposal.campaign_id = ?2
             AND NOT EXISTS (
               SELECT 1 FROM campaign_schedule_proposal_declines AS decline
               WHERE decline.proposal_id = proposal.id
             )
           ORDER BY proposal.created_at DESC, proposal.id DESC
           LIMIT 1`,
        )
        .bind(siteId, campaignId)
        .first<ProposalRow>();
      return row === null ? null : proposalFromRow(row);
    },
    async listNewestUndeclined({ siteId }) {
      const rows = await database
        .prepare(
          `SELECT ${proposalProjection}
           FROM campaign_schedule_proposals AS proposal
           WHERE proposal.site_id = ?1
             AND NOT EXISTS (
               SELECT 1 FROM campaign_schedule_proposal_declines AS decline
               WHERE decline.proposal_id = proposal.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM campaign_schedule_proposals AS newer
               WHERE newer.site_id = proposal.site_id
                 AND newer.campaign_id = proposal.campaign_id
                 AND NOT EXISTS (
                   SELECT 1
                   FROM campaign_schedule_proposal_declines AS newer_decline
                   WHERE newer_decline.proposal_id = newer.id
                 )
                 AND (
                   newer.created_at > proposal.created_at
                   OR (
                     newer.created_at = proposal.created_at
                     AND newer.id > proposal.id
                   )
                 )
             )
           ORDER BY proposal.created_at DESC, proposal.id DESC`,
        )
        .bind(siteId)
        .all<ProposalRow>();
      return Object.freeze(rows.results.map(proposalFromRow));
    },
    async decline({
      siteId,
      proposalId,
      idempotencyKey,
      declinedBy,
      occurredAt,
    }) {
      const row = await database
        .prepare(
          `SELECT ${proposalProjection}
           FROM campaign_schedule_proposals
           WHERE id = ?1 AND site_id = ?2`,
        )
        .bind(proposalId, siteId)
        .first<ProposalRow>();
      if (row === null) {
        throw new CampaignScheduleProposalError(
          "schedule_request_not_found",
        );
      }
      const declined = await database
        .prepare(
          `INSERT INTO campaign_schedule_proposal_declines (
             proposal_id, site_id, request_id, declined_by, declined_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5
           WHERE EXISTS (
             SELECT 1 FROM human_memberships
             WHERE site_id = ?2 AND id = ?4
               AND status = 'active' AND role IN ('owner', 'editor')
           )
           ON CONFLICT (proposal_id) DO NOTHING`,
        )
        .bind(proposalId, siteId, idempotencyKey, declinedBy, occurredAt)
        .run();
      if ((declined.meta.changes ?? 0) === 1) return proposalFromRow(row);
      // Declining twice is a no-op that answers the same request. Anything
      // else means this person may not decline.
      const already = await database
        .prepare(
          `SELECT proposal_id FROM campaign_schedule_proposal_declines
           WHERE proposal_id = ?1`,
        )
        .bind(proposalId)
        .first<{ proposal_id: string }>();
      if (already !== null) return proposalFromRow(row);
      throw new CampaignScheduleProposalError("human_authority_required");
    },
    async hasMcpAuthority({
      siteId,
      connectionId,
      actorId,
      operation,
      requiredScopes,
    }) {
      return (
        (await database
          .prepare(
            `SELECT connection.id
             FROM mcp_connections AS connection
             JOIN mcp_connection_scopes AS pinned
               ON pinned.connection_id = connection.id
              AND pinned.scope = ?5
             WHERE connection.id = ?1
               AND connection.actor_id = ?2
               AND connection.site_id = ?3
               AND connection.status = 'active'
               AND json_array_length(?4) > 0
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(?4) AS required
                 WHERE NOT EXISTS (
                   SELECT 1
                   FROM mcp_connection_scopes AS granted
                   WHERE granted.connection_id = connection.id
                     AND granted.scope = required.value
                 )
               )
             LIMIT 1`,
          )
          .bind(
            connectionId,
            actorId,
            siteId,
            JSON.stringify(requiredScopes),
            // The one permission this command needs, taken from the command
            // rather than from the caller's list. See ADR-0039.
            mcpCampaignOperationScopes[operation],
          )
          .first<{ id: string }>()) !== null
      );
    },
    async hasHumanAuthority({ siteId, actorId }) {
      return (
        (await database
          .prepare(
            `SELECT id FROM human_memberships
             WHERE site_id = ?1 AND id = ?2
               AND status = 'active' AND role IN ('owner', 'editor')
             LIMIT 1`,
          )
          .bind(siteId, actorId)
          .first<{ id: string }>()) !== null
      );
    },
  });
  return store;
}

import {
  createCampaignId,
  createCampaignRevisionId,
  type Campaign,
  type CampaignLifecycleState,
  type CampaignRevision,
  type CampaignStore,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type CampaignRow = {
  id: string;
  site_id: string;
  lifecycle_state: CampaignLifecycleState;
  current_revision_id: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  revision_json: string;
};

function toCampaign(row: CampaignRow): Campaign {
  return Object.freeze({
    id: createCampaignId(row.id),
    siteId: row.site_id as SiteId,
    lifecycleState: row.lifecycle_state,
    currentRevisionId: createCampaignRevisionId(row.current_revision_id),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const campaignProjection = `
  SELECT id, site_id, lifecycle_state, current_revision_id,
    version, created_at, updated_at
  FROM campaigns
`;

function revisionInsert(
  database: D1DatabaseBinding,
  revision: CampaignRevision,
) {
  return database
    .prepare(
      `INSERT INTO campaign_revisions (
         id, site_id, campaign_id, revision_number, revision_json, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      revision.id,
      revision.siteId,
      revision.campaignId,
      revision.revisionNumber,
      JSON.stringify(revision),
      revision.createdAt,
    );
}

function auditInsert(
  database: D1DatabaseBinding,
  event: import("@foundry/application").CampaignAuditEvent,
) {
  return database
    .prepare(
      `INSERT INTO campaign_audit_events (
         id, site_id, actor_id, target_id, request_id, action, outcome,
         campaign_revision_id, reason, before_state, after_state, occurred_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      event.id,
      event.siteId,
      event.actorId,
      event.targetId,
      event.requestId,
      event.action,
      event.outcome,
      event.revisionId,
      event.reason,
      event.beforeState,
      event.afterState,
      event.occurredAt,
    );
}

export function createD1CampaignStore(
  database: D1DatabaseBinding,
): CampaignStore {
  return {
    async create({ campaign, revision, audit }) {
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO campaigns (
               id, site_id, lifecycle_state, current_revision_id,
               version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(
            campaign.id,
            campaign.siteId,
            campaign.lifecycleState,
            campaign.currentRevisionId,
            campaign.version,
            campaign.createdAt,
            campaign.updatedAt,
          ),
        revisionInsert(database, revision),
        auditInsert(database, audit),
      ]);
      return (results[0]?.meta.changes ?? 0) === 1 &&
        (results[1]?.meta.changes ?? 0) === 1 &&
        (results[2]?.meta.changes ?? 0) === 1;
    },
    async findCampaign({ siteId, campaignId }) {
      const row = await database
        .prepare(`${campaignProjection} WHERE site_id = ?1 AND id = ?2`)
        .bind(siteId, campaignId)
        .first<CampaignRow>();
      return row === null ? null : toCampaign(row);
    },
    async findRevision({ siteId, campaignId, revisionNumber }) {
      const row = await database
        .prepare(
          `SELECT revision_json
           FROM campaign_revisions
           WHERE site_id = ?1 AND campaign_id = ?2 AND revision_number = ?3`,
        )
        .bind(siteId, campaignId, revisionNumber)
        .first<RevisionRow>();
      return row === null
        ? null
        : Object.freeze(JSON.parse(row.revision_json) as CampaignRevision);
    },
    async listCampaigns(siteId) {
      const rows = await database
        .prepare(
          `${campaignProjection}
           WHERE site_id = ?1 ORDER BY updated_at DESC, id`,
        )
        .bind(siteId)
        .all<CampaignRow>();
      return rows.results.map(toCampaign);
    },
    async appendRevision({ expectedVersion, campaign, revision, audit }) {
      const results = await database.batch([
        database
          .prepare(
            `INSERT INTO campaign_revisions (
               id, site_id, campaign_id, revision_number,
               revision_json, created_at
             )
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
             WHERE EXISTS (
               SELECT 1 FROM campaigns
               WHERE site_id = ?2 AND id = ?3 AND version = ?7
             )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            revision.id,
            revision.siteId,
            revision.campaignId,
            revision.revisionNumber,
            JSON.stringify(revision),
            revision.createdAt,
            expectedVersion,
          ),
        database
          .prepare(
            `UPDATE campaigns
             SET lifecycle_state = ?1, current_revision_id = ?2,
               version = ?3, updated_at = ?4
             WHERE site_id = ?5 AND id = ?6 AND version = ?7
               AND EXISTS (
                 SELECT 1 FROM campaign_revisions WHERE id = ?2
               )`,
          )
          .bind(
            campaign.lifecycleState,
            campaign.currentRevisionId,
            campaign.version,
            campaign.updatedAt,
            campaign.siteId,
            campaign.id,
            expectedVersion,
          ),
        auditInsert(database, audit),
      ]);
      return (results[0]?.meta.changes ?? 0) === 1 &&
        (results[1]?.meta.changes ?? 0) === 1 &&
        (results[2]?.meta.changes ?? 0) === 1;
    },
    async recordAudit(event) {
      await database
        .prepare(
          `INSERT INTO campaign_audit_events (
             id, site_id, actor_id, target_id, request_id, action, outcome,
             campaign_revision_id, reason, before_state, after_state, occurred_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        )
        .bind(
          event.id,
          event.siteId,
          event.actorId,
          event.targetId,
          event.requestId,
          event.action,
          event.outcome,
          event.revisionId,
          event.reason,
          event.beforeState,
          event.afterState,
          event.occurredAt,
        )
        .run();
    },
  };
}

import {
  createCampaignId,
  createCampaignRevisionId,
  type Campaign,
  type CampaignArtifact,
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
  test_delivery_id: string | null;
  bulk_authorization_id: string | null;
  active_schedule_id: string | null;
  provider_cancellation_required: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  revision_json: string;
};

type ArtifactRow = {
  channel: CampaignArtifact["channel"];
  bytes: string;
  fingerprint: string;
  campaign_fingerprint: string;
  schema_version: "1.3.0";
  renderer_version: string;
};

function toCampaign(row: CampaignRow): Campaign {
  return Object.freeze({
    id: createCampaignId(row.id),
    siteId: row.site_id as SiteId,
    lifecycleState: row.lifecycle_state,
    currentRevisionId: createCampaignRevisionId(row.current_revision_id),
    testDeliveryId: row.test_delivery_id,
    bulkAuthorizationId: row.bulk_authorization_id,
    activeScheduleId: row.active_schedule_id,
    providerCancellationRequired:
      row.provider_cancellation_required === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const campaignProjection = `
  SELECT id, site_id, lifecycle_state, current_revision_id,
    test_delivery_id, bulk_authorization_id, active_schedule_id,
    provider_cancellation_required, version, created_at, updated_at
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
  campaignRevisionId?: string,
) {
  return database
    .prepare(
      `INSERT INTO campaign_audit_events (
         id, site_id, actor_id, action, outcome, reason, occurred_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE ?8 IS NULL OR EXISTS (
         SELECT 1 FROM campaign_revisions
         WHERE id = ?8 AND site_id = ?2
       )`,
    )
    .bind(
      event.id,
      event.siteId,
      event.actorId,
      event.action,
      event.outcome,
      event.reason,
      event.occurredAt,
      campaignRevisionId ?? null,
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
               test_delivery_id, bulk_authorization_id, active_schedule_id,
               provider_cancellation_required, version, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
          )
          .bind(
            campaign.id,
            campaign.siteId,
            campaign.lifecycleState,
            campaign.currentRevisionId,
            campaign.testDeliveryId,
            campaign.bulkAuthorizationId,
            campaign.activeScheduleId,
            campaign.providerCancellationRequired ? 1 : 0,
            campaign.version,
            campaign.createdAt,
            campaign.updatedAt,
          ),
        revisionInsert(database, revision),
        auditInsert(database, audit, revision.id),
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
               test_delivery_id = ?3, bulk_authorization_id = ?4,
               active_schedule_id = ?5,
               provider_cancellation_required = ?6,
               version = ?7, updated_at = ?8
             WHERE site_id = ?9 AND id = ?10 AND version = ?11
               AND EXISTS (
                 SELECT 1 FROM campaign_revisions WHERE id = ?2
               )`,
          )
          .bind(
            campaign.lifecycleState,
            campaign.currentRevisionId,
            campaign.testDeliveryId,
            campaign.bulkAuthorizationId,
            campaign.activeScheduleId,
            campaign.providerCancellationRequired ? 1 : 0,
            campaign.version,
            campaign.updatedAt,
            campaign.siteId,
            campaign.id,
            expectedVersion,
          ),
        auditInsert(database, audit, revision.id),
      ]);
      return (results[0]?.meta.changes ?? 0) === 1 &&
        (results[1]?.meta.changes ?? 0) === 1 &&
        (results[2]?.meta.changes ?? 0) === 1;
    },
    async saveRenderedArtifacts(input) {
      const statements = [input.html, input.text].map((artifact) =>
        database
          .prepare(
            `INSERT INTO campaign_rendered_artifacts (
               campaign_revision_id, channel, bytes, fingerprint,
               campaign_fingerprint, schema_version, renderer_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            input.campaignRevisionId,
            artifact.channel,
            artifact.bytes,
            artifact.fingerprint,
            input.campaignFingerprint,
            artifact.schemaVersion,
            artifact.rendererVersion,
          ),
      );
      await database.batch(statements);
      const stored = await database
        .prepare(
          `SELECT channel, bytes, fingerprint, campaign_fingerprint,
             schema_version, renderer_version
           FROM campaign_rendered_artifacts
           WHERE campaign_revision_id = ?1 ORDER BY channel`,
        )
        .bind(input.campaignRevisionId)
        .all<ArtifactRow>();
      const expected = [input.html, input.text].sort((left, right) =>
        left.channel.localeCompare(right.channel),
      );
      if (
        stored.results.length !== 2 ||
        stored.results.some((row, index) => {
          const artifact = expected[index]!;
          return row.channel !== artifact.channel ||
            row.bytes !== artifact.bytes ||
            row.fingerprint !== artifact.fingerprint ||
            row.campaign_fingerprint !== input.campaignFingerprint ||
            row.schema_version !== artifact.schemaVersion ||
            row.renderer_version !== artifact.rendererVersion;
        })
      ) {
        throw new Error("campaign_artifact_immutable");
      }
    },
    async recordAudit(event) {
      await database
        .prepare(
          `INSERT INTO campaign_audit_events (
             id, site_id, actor_id, action, outcome, reason, occurred_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          event.id,
          event.siteId,
          event.actorId,
          event.action,
          event.outcome,
          event.reason,
          event.occurredAt,
        )
        .run();
    },
  };
}

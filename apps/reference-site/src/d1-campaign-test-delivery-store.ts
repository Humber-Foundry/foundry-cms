import {
  createCampaignId,
  createCampaignRevisionId,
  type CampaignTestDeliveryOperation,
  type CampaignTestDeliveryStore,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type TestDeliveryRow = Readonly<{
  execution_id: string;
  site_id: string;
  actor_id: string;
  request_id: string;
  campaign_id: string;
  campaign_revision_id: string;
  binding_json: string;
  recipient_ids_json: string;
  state: CampaignTestDeliveryOperation["state"];
  attempt_number: number;
  attempt_lease_until: string | null;
  provider_campaign_id: string | null;
  failure_code: string | null;
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
}>;

const projection = `
  SELECT execution_id, site_id, actor_id, request_id, campaign_id,
    campaign_revision_id, binding_json, recipient_ids_json, state,
    attempt_number, attempt_lease_until,
    provider_campaign_id, failure_code, evidence_json, created_at, updated_at
  FROM campaign_test_deliveries
`;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function toOperation(row: TestDeliveryRow): CampaignTestDeliveryOperation {
  return Object.freeze({
    executionId: row.execution_id,
    siteId: row.site_id as SiteId,
    actorId: row.actor_id,
    requestId: row.request_id,
    campaignId: createCampaignId(row.campaign_id),
    campaignRevisionId: createCampaignRevisionId(row.campaign_revision_id),
    binding: deepFreeze(
      JSON.parse(row.binding_json) as CampaignTestDeliveryOperation["binding"],
    ),
    recipientIds: Object.freeze(
      JSON.parse(row.recipient_ids_json) as ReadonlyArray<string>,
    ),
    state: row.state,
    attemptNumber: row.attempt_number,
    attemptLeaseUntil: row.attempt_lease_until,
    providerCampaignId: row.provider_campaign_id,
    failureCode: row.failure_code,
    evidence:
      row.evidence_json === null
        ? null
        : deepFreeze(
            JSON.parse(
              row.evidence_json,
            ) as NonNullable<CampaignTestDeliveryOperation["evidence"]>,
          ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function byRequest(
  database: D1DatabaseBinding,
  input: { siteId: SiteId; actorId: string; requestId: string },
) {
  const row = await database
    .prepare(
      `${projection}
       WHERE site_id = ?1 AND actor_id = ?2 AND request_id = ?3`,
    )
    .bind(input.siteId, input.actorId, input.requestId)
    .first<TestDeliveryRow>();
  return row === null ? null : toOperation(row);
}

export function createD1CampaignTestDeliveryStore(
  database: D1DatabaseBinding,
): CampaignTestDeliveryStore {
  const store: CampaignTestDeliveryStore = {
    findByRequest(input) {
      return byRequest(database, input);
    },
    async claim(operation) {
      await database
        .prepare(
          `INSERT INTO campaign_test_deliveries (
             execution_id, site_id, actor_id, request_id, campaign_id,
             campaign_revision_id, binding_json, recipient_ids_json, state,
             attempt_number, attempt_lease_until,
             provider_campaign_id, failure_code, evidence_json,
             created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
             ?12, ?13, ?14, ?15, ?16
           )
           ON CONFLICT (site_id, actor_id, request_id) DO NOTHING`,
        )
        .bind(
          operation.executionId,
          operation.siteId,
          operation.actorId,
          operation.requestId,
          operation.campaignId,
          operation.campaignRevisionId,
          JSON.stringify(operation.binding),
          JSON.stringify(operation.recipientIds),
          operation.state,
          operation.attemptNumber,
          operation.attemptLeaseUntil,
          operation.providerCampaignId,
          operation.failureCode,
          operation.evidence === null
            ? null
            : JSON.stringify(operation.evidence),
          operation.createdAt,
          operation.updatedAt,
        )
        .run();
      const claimed = await byRequest(database, operation);
      if (claimed === null) throw new Error("campaign_test_delivery_missing");
      return claimed;
    },
    async beginAttempt({ operation, now, leaseUntil }) {
      const result = await database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET state = 'attempting', attempt_number = attempt_number + 1,
             attempt_lease_until = ?1,
             updated_at = ?2
           WHERE execution_id = ?3 AND site_id = ?4 AND updated_at = ?5
             AND state IN ('pending', 'ambiguous')`,
        )
        .bind(
          leaseUntil,
          now,
          operation.executionId,
          operation.siteId,
          operation.updatedAt,
        )
        .run();
      if ((result.meta.changes ?? 0) !== 1) return null;
      return byRequest(database, operation);
    },
    async record(operation) {
      const result = await database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET state = ?1, attempt_lease_until = ?2,
             provider_campaign_id = ?3, failure_code = ?4,
             evidence_json = ?5, updated_at = ?6
           WHERE execution_id = ?7 AND site_id = ?8
             AND attempt_number = ?9
             AND state IN ('pending', 'attempting', 'ambiguous')`,
        )
        .bind(
          operation.state,
          operation.attemptLeaseUntil,
          operation.providerCampaignId,
          operation.failureCode,
          operation.evidence === null
            ? null
            : JSON.stringify(operation.evidence),
          operation.updatedAt,
          operation.executionId,
          operation.siteId,
          operation.attemptNumber,
        )
        .run();
      if ((result.meta.changes ?? 0) !== 1) {
        throw new Error("campaign_test_delivery_state_conflict");
      }
      const recorded = await byRequest(database, operation);
      if (recorded === null) throw new Error("campaign_test_delivery_missing");
      return recorded;
    },
    async findLatestAccepted({ siteId, campaignId }) {
      const row = await database
        .prepare(
          `${projection}
           WHERE site_id = ?1 AND campaign_id = ?2 AND state = 'accepted'
           ORDER BY updated_at DESC, execution_id DESC LIMIT 1`,
        )
        .bind(siteId, campaignId)
        .first<TestDeliveryRow>();
      return row === null ? null : toOperation(row);
    },
  };
  return Object.freeze(store);
}

import {
  CampaignValidationError,
  campaignTestRateLimitWindowMs,
  createCampaignId,
  createCampaignRevisionId,
  maximumCampaignTestsPerRevisionWindow,
  maximumProviderTestRecipientsPerDay,
  type CampaignTestReceiptConfirmation,
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
  provider_message_id: string | null;
  foundry_send_proof: string | null;
  failure_code: CampaignTestDeliveryOperation["failureCode"];
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
}>;

type TestReceiptConfirmationRow = Readonly<{
  execution_id: string;
  site_id: string;
  owner_actor_id: string;
  request_id: string;
  confirmed_at: string;
}>;

const projection = `
  SELECT execution_id, site_id, actor_id, request_id, campaign_id,
    campaign_revision_id, binding_json, recipient_ids_json, state,
    attempt_number, attempt_lease_until,
    provider_campaign_id, provider_message_id, foundry_send_proof,
    failure_code, evidence_json,
    created_at, updated_at
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
  const deliveryEvidence =
    row.evidence_json === null
      ? null
      : deepFreeze(
          JSON.parse(
            row.evidence_json,
          ) as NonNullable<CampaignTestDeliveryOperation["evidence"]>,
        );
  if (
    row.state === "accepted" &&
    (row.foundry_send_proof === null ||
      row.provider_campaign_id === null ||
      row.provider_message_id === null ||
      deliveryEvidence === null ||
      deliveryEvidence.providerCampaignId !== row.provider_campaign_id ||
      deliveryEvidence.providerMessageId !== row.provider_message_id)
  ) {
    throw new Error("campaign_test_delivery_evidence_invalid");
  }
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
    providerMessageId: row.provider_message_id,
    foundrySendProof: row.foundry_send_proof,
    failureCode: row.failure_code,
    evidence: deliveryEvidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toConfirmation(
  row: TestReceiptConfirmationRow,
): CampaignTestReceiptConfirmation {
  return Object.freeze({
    executionId: row.execution_id,
    siteId: row.site_id as SiteId,
    ownerActorId: row.owner_actor_id,
    requestId: row.request_id,
    confirmedAt: row.confirmed_at,
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
    async findByExecution({ siteId, executionId }) {
      const row = await database
        .prepare(
          `${projection}
           WHERE site_id = ?1 AND execution_id = ?2`,
        )
        .bind(siteId, executionId)
        .first<TestDeliveryRow>();
      return row === null ? null : toOperation(row);
    },
    async claim(operation) {
      await database
        .prepare(
          `INSERT INTO campaign_test_deliveries (
             execution_id, site_id, actor_id, request_id, campaign_id,
             campaign_revision_id, binding_json, recipient_ids_json, state,
             attempt_number, attempt_lease_until,
             provider_campaign_id, provider_message_id,
             foundry_send_proof, failure_code,
             evidence_json,
             created_at, updated_at
           ) SELECT
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
             ?12, ?13, ?14, ?15, ?16, ?17, ?18
           WHERE NOT EXISTS (
             SELECT 1 FROM campaign_test_deliveries
             WHERE site_id = ?2 AND campaign_revision_id = ?6
               AND state IN ('pending', 'attempting', 'ambiguous')
           )
             AND (
               SELECT COUNT(*) FROM campaign_test_deliveries
               WHERE site_id = ?2 AND campaign_revision_id = ?6
                 AND created_at >= ?19
             ) < ${maximumCampaignTestsPerRevisionWindow}
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
          operation.providerMessageId,
          operation.foundrySendProof,
          operation.failureCode,
          operation.evidence === null
            ? null
            : JSON.stringify(operation.evidence),
          operation.createdAt,
          operation.updatedAt,
          new Date(
            new Date(operation.createdAt).getTime() -
              campaignTestRateLimitWindowMs,
          ).toISOString(),
        )
        .run();
      const claimed = await byRequest(database, operation);
      if (claimed === null) {
        const unresolved = await database
          .prepare(
            `SELECT execution_id FROM campaign_test_deliveries
             WHERE site_id = ?1 AND campaign_revision_id = ?2
               AND state IN ('pending', 'attempting', 'ambiguous')
             LIMIT 1`,
          )
          .bind(operation.siteId, operation.campaignRevisionId)
          .first();
        throw new CampaignValidationError(
          unresolved === null
            ? "test_delivery_rate_limited"
            : "test_delivery_in_progress",
        );
      }
      return claimed;
    },
    async beginAttempt({ operation, now, leaseUntil }) {
      const result = await database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET state = 'attempting', attempt_number = attempt_number + 1,
             attempt_lease_until = ?1,
             failure_code = NULL,
             updated_at = ?2
           WHERE execution_id = ?3 AND site_id = ?4 AND updated_at = ?5
             AND (
               state = 'pending' OR
               (state = 'ambiguous' AND (
                 attempt_lease_until IS NULL OR attempt_lease_until <= ?2
               )) OR
               (state = 'attempting'
                 AND attempt_lease_until <= ?2
                 AND provider_campaign_id IS NULL
                 AND foundry_send_proof IS NULL)
             )`,
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
    async renewAttemptLease({ operation, now, leaseUntil }) {
      const result = await database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET attempt_lease_until = ?1, updated_at = ?2
           WHERE execution_id = ?3 AND site_id = ?4
             AND attempt_number = ?5 AND updated_at = ?6
             AND state = 'attempting'
             AND attempt_lease_until > ?2`,
        )
        .bind(
          leaseUntil,
          now,
          operation.executionId,
          operation.siteId,
          operation.attemptNumber,
          operation.updatedAt,
        )
        .run();
      if ((result.meta.changes ?? 0) !== 1) return null;
      return byRequest(database, operation);
    },
    async record(operation) {
      if (
        operation.state === "accepted" &&
        (operation.foundrySendProof === null ||
          operation.providerCampaignId === null ||
          operation.providerMessageId === null ||
          operation.evidence === null ||
          operation.evidence.providerCampaignId !==
            operation.providerCampaignId ||
          operation.evidence.providerMessageId !==
            operation.providerMessageId)
      ) {
        throw new Error("campaign_test_delivery_evidence_invalid");
      }
      const result = await database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET state = ?1, attempt_lease_until = ?2,
             provider_campaign_id = ?3, provider_message_id = ?4,
             foundry_send_proof = ?5,
             failure_code = ?6, evidence_json = ?7, updated_at = ?8
           WHERE execution_id = ?9 AND site_id = ?10
             AND attempt_number = ?11
             AND state IN ('pending', 'attempting', 'ambiguous')`,
        )
        .bind(
          operation.state,
          operation.attemptLeaseUntil,
          operation.providerCampaignId,
          operation.providerMessageId,
          operation.foundrySendProof,
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
             AND provider_campaign_id IS NOT NULL
             AND provider_message_id IS NOT NULL
             AND foundry_send_proof IS NOT NULL
             AND evidence_json IS NOT NULL
           ORDER BY updated_at DESC, execution_id DESC LIMIT 1`,
        )
        .bind(siteId, campaignId)
        .first<TestDeliveryRow>();
      return row === null ? null : toOperation(row);
    },
    async findReceiptConfirmation({ siteId, executionId }) {
      const row = await database
        .prepare(
          `SELECT execution_id, site_id, owner_actor_id, request_id,
             confirmed_at
           FROM campaign_test_receipt_confirmations
           WHERE site_id = ?1 AND execution_id = ?2`,
        )
        .bind(siteId, executionId)
        .first<TestReceiptConfirmationRow>();
      return row === null ? null : toConfirmation(row);
    },
    async reserveDailyRecipientBudget(input) {
      if (
        input.recipientCount < 1 ||
        input.recipientCount > 5 ||
        !/^[a-f0-9]{64}$/u.test(input.accountScopeFingerprint) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(input.budgetDay)
      ) {
        return false;
      }
      await database
        .prepare(
          `INSERT INTO campaign_test_recipient_budget (
             account_scope_fingerprint, budget_day, execution_id,
             attempt_number, recipient_count, reserved_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE (
             SELECT COALESCE(SUM(recipient_count), 0)
             FROM campaign_test_recipient_budget
             WHERE account_scope_fingerprint = ?1 AND budget_day = ?2
           ) + ?5 <= ${maximumProviderTestRecipientsPerDay}
           ON CONFLICT (
             account_scope_fingerprint, budget_day, execution_id,
             attempt_number
           ) DO NOTHING`,
        )
        .bind(
          input.accountScopeFingerprint,
          input.budgetDay,
          input.executionId,
          input.attemptNumber,
          input.recipientCount,
          input.reservedAt,
        )
        .run();
      const reservation = await database
        .prepare(
          `SELECT recipient_count FROM campaign_test_recipient_budget
           WHERE account_scope_fingerprint = ?1 AND budget_day = ?2
             AND execution_id = ?3 AND attempt_number = ?4`,
        )
        .bind(
          input.accountScopeFingerprint,
          input.budgetDay,
          input.executionId,
          input.attemptNumber,
        )
        .first<{ recipient_count: number }>();
      return reservation?.recipient_count === input.recipientCount;
    },
    async cancelForCampaignEdit(input) {
      const activeAttempt = await database
        .prepare(
          `SELECT execution_id
           FROM campaign_test_deliveries
           WHERE site_id = ?1 AND campaign_id = ?2
             AND state = 'attempting'
             AND attempt_lease_until > ?3
           LIMIT 1`,
        )
        .bind(input.siteId, input.campaignId, input.cancelledAt)
        .first();
      if (activeAttempt !== null) return false;
      await database
        .prepare(
          `UPDATE campaign_test_deliveries
           SET state = 'cancelled', attempt_lease_until = NULL,
             failure_code = 'campaign_revision_changed', updated_at = ?1
           WHERE site_id = ?2 AND campaign_id = ?3
             AND campaign_revision_id != ?4
             AND (
               state IN ('pending', 'ambiguous') OR
               (state = 'attempting' AND (
                 attempt_lease_until IS NULL OR attempt_lease_until <= ?1
               ))
             )`,
        )
        .bind(
          input.cancelledAt,
          input.siteId,
          input.campaignId,
          input.retainedRevisionId,
        )
        .run();
      return true;
    },
  };
  return Object.freeze(store);
}

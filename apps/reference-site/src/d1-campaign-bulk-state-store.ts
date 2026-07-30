import {
  CampaignBulkDeliveryError,
  createCampaignId,
  createCampaignRevisionId,
  sha256CanonicalJson,
  type CampaignBulkAuthorization,
  type CampaignBulkSchedule,
  type CampaignBulkSendOperation,
  type CampaignBulkStateStore,
  type VerifiedCampaignDeliveryEvent,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type AuthorizationRow = Readonly<{
  id: string;
  site_id: string;
  campaign_id: string;
  campaign_revision_id: string;
  campaign_fingerprint: string;
  test_execution_id: string;
  test_provider_receipt_hash: string;
  test_html_fingerprint: string;
  test_text_fingerprint: string;
  test_sender_fingerprint: string;
  test_provider_configuration_fingerprint: string;
  authorization_fingerprint: string;
  owner_actor_id: string;
  state: CampaignBulkAuthorization["state"];
  request_id: string;
  input_hash: string;
  authorized_at: string;
  invalidated_at: string | null;
}>;

type ScheduleRow = Readonly<{
  id: string;
  site_id: string;
  campaign_id: string;
  authorization_id: string;
  local_date_time: string;
  iana_time_zone: string;
  utc_offset_choice: string;
  execute_at_utc: string;
  time_zone_database_version: string;
  activated_by: string;
  state: CampaignBulkSchedule["state"];
  request_id: string;
  input_hash: string;
  created_at: string;
  updated_at: string;
}>;

type OperationRow = Readonly<{
  id: string;
  site_id: string;
  campaign_id: string;
  campaign_revision_id: string;
  authorization_id: string;
  schedule_id: string | null;
  scheduled_instant: string | null;
  stable_send_key: string;
  state: CampaignBulkSendOperation["state"];
  attempt: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  audience_snapshot_json: string | null;
  send_artifact_json: string | null;
  send_artifact_hash: string | null;
  send_artifact_commit_sha: string | null;
  provider_campaign_id: string | null;
  provider_message_id: string | null;
  provider_send_proof: string | null;
  provider_verification_json: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}>;

const authorizationProjection = `
  SELECT id, site_id, campaign_id, campaign_revision_id,
    campaign_fingerprint, test_execution_id, test_provider_receipt_hash,
    test_html_fingerprint, test_text_fingerprint, test_sender_fingerprint,
    test_provider_configuration_fingerprint,
    authorization_fingerprint, owner_actor_id, state, request_id, input_hash,
    authorized_at, invalidated_at
  FROM campaign_bulk_authorizations
`;

const scheduleProjection = `
  SELECT id, site_id, campaign_id, authorization_id, local_date_time,
    iana_time_zone, utc_offset_choice, execute_at_utc,
    time_zone_database_version, activated_by, state, request_id, input_hash,
    created_at, updated_at
  FROM campaign_bulk_schedules
`;

const operationProjection = `
  SELECT id, site_id, campaign_id, campaign_revision_id, authorization_id,
    schedule_id, scheduled_instant, stable_send_key, state, attempt,
    lease_token, lease_expires_at, audience_snapshot_json, provider_campaign_id,
    send_artifact_json, send_artifact_hash, send_artifact_commit_sha,
    provider_message_id, provider_send_proof, provider_verification_json,
    detail, created_at, updated_at
  FROM campaign_bulk_send_operations
`;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function toAuthorization(row: AuthorizationRow): CampaignBulkAuthorization {
  return Object.freeze({
    id: row.id,
    siteId: row.site_id as SiteId,
    campaignId: createCampaignId(row.campaign_id),
    campaignRevisionId: createCampaignRevisionId(row.campaign_revision_id),
    campaignFingerprint: row.campaign_fingerprint,
    testExecutionId: row.test_execution_id,
    testProviderReceiptHash: row.test_provider_receipt_hash,
    testHtmlFingerprint: row.test_html_fingerprint,
    testTextFingerprint: row.test_text_fingerprint,
    testSenderFingerprint: row.test_sender_fingerprint,
    testProviderConfigurationFingerprint:
      row.test_provider_configuration_fingerprint,
    authorizationFingerprint: row.authorization_fingerprint,
    ownerActorId: row.owner_actor_id,
    state: row.state,
    authorizedAt: row.authorized_at,
    invalidatedAt: row.invalidated_at,
  });
}

function toSchedule(row: ScheduleRow): CampaignBulkSchedule {
  return Object.freeze({
    id: row.id,
    siteId: row.site_id as SiteId,
    campaignId: createCampaignId(row.campaign_id),
    authorizationId: row.authorization_id,
    localDateTime: row.local_date_time,
    ianaTimeZone: row.iana_time_zone,
    utcOffsetChoice: row.utc_offset_choice,
    executeAtUtc: row.execute_at_utc,
    timeZoneDatabaseVersion: row.time_zone_database_version,
    activatedBy: row.activated_by,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toOperation(row: OperationRow): CampaignBulkSendOperation {
  return Object.freeze({
    id: row.id,
    siteId: row.site_id as SiteId,
    campaignId: createCampaignId(row.campaign_id),
    campaignRevisionId: createCampaignRevisionId(row.campaign_revision_id),
    authorizationId: row.authorization_id,
    scheduleId: row.schedule_id,
    scheduledInstant: row.scheduled_instant,
    stableSendKey: row.stable_send_key,
    state: row.state,
    attempt: row.attempt,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    audienceSnapshot:
      row.audience_snapshot_json === null
        ? null
        : deepFreeze(JSON.parse(row.audience_snapshot_json)),
    sendArtifact:
      row.send_artifact_json === null
        ? null
        : deepFreeze(JSON.parse(row.send_artifact_json)),
    sendArtifactHash: row.send_artifact_hash,
    sendArtifactCommitSha: row.send_artifact_commit_sha,
    providerCampaignId: row.provider_campaign_id,
    providerMessageId: row.provider_message_id,
    providerSendProof: row.provider_send_proof,
    providerVerification:
      row.provider_verification_json === null
        ? null
        : deepFreeze(JSON.parse(row.provider_verification_json)),
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function findAuthorization(database: D1DatabaseBinding, id: string) {
  const row = await database
    .prepare(`${authorizationProjection} WHERE id = ?1`)
    .bind(id)
    .first<AuthorizationRow>();
  return row === null ? null : toAuthorization(row);
}

async function findSchedule(database: D1DatabaseBinding, id: string) {
  const row = await database
    .prepare(`${scheduleProjection} WHERE id = ?1`)
    .bind(id)
    .first<ScheduleRow>();
  return row === null ? null : toSchedule(row);
}

async function findOperation(
  database: D1DatabaseBinding,
  siteId: SiteId,
  id: string,
) {
  const row = await database
    .prepare(`${operationProjection} WHERE site_id = ?1 AND id = ?2`)
    .bind(siteId, id)
    .first<OperationRow>();
  return row === null ? null : toOperation(row);
}

function changes(result: Readonly<{ meta: Readonly<{ changes?: number }> }>) {
  return result.meta.changes ?? 0;
}

/**
 * Durable guards raise `RAISE(ABORT, '<token>')`. Each token maps to the same
 * stable domain reason the application uses for that condition so a caller
 * that lost a race sees the reason rather than an unexplained failure.
 */
const abortReasons: Readonly<Record<string, string>> = Object.freeze({
  campaign_bulk_owner_evidence_required: "bulk_test_stale",
  campaign_bulk_authorization_stale: "bulk_authorization_stale",
  campaign_bulk_send_already_exists: "bulk_send_already_exists",
  campaign_bulk_send_transition_invalid: "bulk_send_state_changed",
  campaign_bulk_schedule_transition_invalid: "bulk_schedule_state_changed",
  campaign_bulk_provider_evidence_incomplete: "bulk_provider_evidence_invalid",
});

/**
 * Every uniqueness guard on these tables states that an equivalent durable
 * record already exists, so the losing writer of a race reports the existing
 * record rather than an unexplained failure.
 */
const uniqueReasons: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["campaign_bulk_authorizations", "bulk_authorization_exists"],
  ["campaign_bulk_schedules", "bulk_schedule_already_exists"],
  ["campaign_bulk_send_operations", "bulk_send_already_exists"],
] as const);

/**
 * Translate a durable-guard rejection into its stable domain reason.
 *
 * Immutability and foreign-key aborts are deliberately not translated: they
 * mean this code tried to rewrite history or write an unanchored row, which is
 * an internal defect rather than a caller condition, and must not be reported
 * as a client-correctable outcome.
 */
async function guarded<T>(execute: () => Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof CampaignBulkDeliveryError) throw error;
    const message = error instanceof Error ? error.message : "";
    for (const [token, reason] of Object.entries(abortReasons)) {
      if (message.includes(token)) {
        throw new CampaignBulkDeliveryError(reason);
      }
    }
    if (message.includes("UNIQUE constraint failed")) {
      for (const [table, reason] of uniqueReasons) {
        if (message.includes(`${table}.`)) {
          throw new CampaignBulkDeliveryError(reason);
        }
      }
    }
    throw error;
  }
}

/**
 * Route the writing operations through the durable-guard translation. Only a
 * write can trip a trigger or a unique index, so the reads are left alone
 * rather than wrapped in a translation that can never fire.
 */
function withGuardedRejections(
  store: CampaignBulkStateStore,
): CampaignBulkStateStore {
  return Object.freeze({
    ...store,
    recordAudit: (input) => guarded(() => store.recordAudit(input)),
    saveAuthorization: (input) => guarded(() => store.saveAuthorization(input)),
    activateSchedule: (input) => guarded(() => store.activateSchedule(input)),
    cancelSchedule: (input) => guarded(() => store.cancelSchedule(input)),
    createSendOperation: (input) =>
      guarded(() => store.createSendOperation(input)),
    claimDueSchedule: (input) => guarded(() => store.claimDueSchedule(input)),
    claimOperation: (input) => guarded(() => store.claimOperation(input)),
    saveAudienceSnapshot: (input) =>
      guarded(() => store.saveAudienceSnapshot(input)),
    recordArtifactPublication: (input) =>
      guarded(() => store.recordArtifactPublication(input)),
    releaseLease: (input) => guarded(() => store.releaseLease(input)),
    beginProviderAttempt: (input) =>
      guarded(() => store.beginProviderAttempt(input)),
    recordProviderOutcome: (input) =>
      guarded(() => store.recordProviderOutcome(input)),
    recordEvent: (input) => guarded(() => store.recordEvent(input)),
    confirmProviderAcceptance: (input) =>
      guarded(() => store.confirmProviderAcceptance(input)),
  } satisfies CampaignBulkStateStore);
}

export function createD1CampaignBulkStateStore(
  database: D1DatabaseBinding,
): CampaignBulkStateStore {
  return withGuardedRejections({
    async recordAudit(event) {
      await database
        .prepare(
          `INSERT INTO campaign_bulk_audit_events (
           id, site_id, actor_id, action, target_id, request_id,
           outcome, reason, occurred_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          event.id,
          event.siteId,
          event.actorId,
          event.action,
          event.targetId,
          event.requestId,
          event.outcome,
          event.reason,
          event.occurredAt,
        )
        .run();
    },
    async findAuthorizationByRequest({ siteId, ownerActorId, requestId }) {
      const row = await database
        .prepare(
          `${authorizationProjection}
         WHERE site_id = ?1 AND owner_actor_id = ?2 AND request_id = ?3`,
        )
        .bind(siteId, ownerActorId, requestId)
        .first<AuthorizationRow>();
      return row === null
        ? null
        : Object.freeze({
            inputHash: row.input_hash,
            value: toAuthorization(row),
          });
    },
    async findAuthorization({ siteId, authorizationId }) {
      const value = await findAuthorization(database, authorizationId);
      return value?.siteId === siteId ? value : null;
    },
    async saveAuthorization({ requestId, inputHash, authorization: value }) {
      const result = await database
        .prepare(
          `INSERT INTO campaign_bulk_authorizations (
           id, site_id, campaign_id, campaign_revision_id,
           campaign_fingerprint, test_execution_id,
           test_provider_receipt_hash, test_html_fingerprint,
           test_text_fingerprint, test_sender_fingerprint,
           test_provider_configuration_fingerprint,
           authorization_fingerprint,
           owner_actor_id, state, request_id, input_hash, authorized_at,
           invalidated_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
           ?13, 'active', ?14, ?15, ?16, NULL
         )
         ON CONFLICT (site_id, owner_actor_id, request_id) DO NOTHING`,
        )
        .bind(
          value.id,
          value.siteId,
          value.campaignId,
          value.campaignRevisionId,
          value.campaignFingerprint,
          value.testExecutionId,
          value.testProviderReceiptHash,
          value.testHtmlFingerprint,
          value.testTextFingerprint,
          value.testSenderFingerprint,
          value.testProviderConfigurationFingerprint,
          value.authorizationFingerprint,
          value.ownerActorId,
          requestId,
          inputHash,
          value.authorizedAt,
        )
        .run();
      const row = await database
        .prepare(
          `${authorizationProjection}
         WHERE site_id = ?1 AND owner_actor_id = ?2 AND request_id = ?3`,
        )
        .bind(value.siteId, value.ownerActorId, requestId)
        .first<AuthorizationRow>();
      if (row === null) {
        throw new CampaignBulkDeliveryError("bulk_authorization_not_saved");
      }
      if (row.input_hash !== inputHash) {
        throw new CampaignBulkDeliveryError("bulk_idempotency_key_reused");
      }
      return Object.freeze({
        value: toAuthorization(row),
        replayed: changes(result) === 0,
      });
    },
    async activateSchedule({ requestId, inputHash, schedule: value }) {
      const prior = await database
        .prepare(
          `${scheduleProjection}
         WHERE site_id = ?1 AND activated_by = ?2 AND request_id = ?3`,
        )
        .bind(value.siteId, value.activatedBy, requestId)
        .first<ScheduleRow>();
      if (prior !== null) {
        if (prior.input_hash !== inputHash) {
          throw new CampaignBulkDeliveryError("bulk_idempotency_key_reused");
        }
        return Object.freeze({ value: toSchedule(prior), replayed: true });
      }
      const competing = await database
        .prepare(
          `SELECT id FROM campaign_bulk_send_operations
           WHERE site_id = ?1 AND campaign_id = ?2
           LIMIT 1`,
        )
        .bind(value.siteId, value.campaignId)
        .first<{ id: string }>();
      if (competing !== null) {
        throw new CampaignBulkDeliveryError("bulk_send_already_exists");
      }
      const results = await database.batch([
        database
          .prepare(
            `UPDATE campaign_bulk_schedules
           SET state = 'cancelled', updated_at = ?1
           WHERE site_id = ?2 AND campaign_id = ?3 AND state = 'active'`,
          )
          .bind(value.createdAt, value.siteId, value.campaignId),
        database
          .prepare(
            `INSERT INTO campaign_bulk_schedules (
             id, site_id, campaign_id, authorization_id, local_date_time,
             iana_time_zone, utc_offset_choice, execute_at_utc,
             time_zone_database_version, activated_by, state,
             request_id, input_hash, created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active',
             ?11, ?12, ?13, ?14
           )`,
          )
          .bind(
            value.id,
            value.siteId,
            value.campaignId,
            value.authorizationId,
            value.localDateTime,
            value.ianaTimeZone,
            value.utcOffsetChoice,
            value.executeAtUtc,
            value.timeZoneDatabaseVersion,
            value.activatedBy,
            requestId,
            inputHash,
            value.createdAt,
            value.updatedAt,
          ),
      ]);
      if (changes(results[1]!) !== 1) {
        throw new CampaignBulkDeliveryError("bulk_schedule_not_saved");
      }
      return Object.freeze({ value, replayed: false });
    },
    async cancelSchedule({ ownerActorId, scheduleId, now }) {
      const result = await database
        .prepare(
          `UPDATE campaign_bulk_schedules
         SET state = 'cancelled', updated_at = ?1
         WHERE id = ?2 AND activated_by = ?3 AND state = 'active'
           AND EXISTS (
             SELECT 1
             FROM campaign_bulk_authorizations AS authorization
             JOIN campaigns AS campaign
               ON campaign.site_id = authorization.site_id
              AND campaign.id = authorization.campaign_id
              AND campaign.current_revision_id =
                  authorization.campaign_revision_id
             JOIN human_memberships AS membership
               ON membership.site_id = authorization.site_id
              AND membership.id = authorization.owner_actor_id
              AND membership.role = 'owner'
              AND membership.status = 'active'
             WHERE authorization.id =
                 campaign_bulk_schedules.authorization_id
               AND authorization.state = 'active'
           )`,
        )
        .bind(now, scheduleId, ownerActorId)
        .run();
      if (changes(result) !== 1) {
        throw new CampaignBulkDeliveryError("bulk_schedule_not_cancellable");
      }
      return (await findSchedule(database, scheduleId))!;
    },
    async createSendOperation({ requestId, inputHash, operation: value }) {
      const prior = await database
        .prepare(
          `${operationProjection}
         WHERE site_id = ?1 AND request_actor_id = (
           SELECT owner_actor_id FROM campaign_bulk_authorizations
           WHERE id = ?2
         ) AND request_id = ?3`,
        )
        .bind(value.siteId, value.authorizationId, requestId)
        .first<OperationRow>();
      if (prior !== null) {
        const receipt = await database
          .prepare(
            `SELECT input_hash FROM campaign_bulk_send_operations
           WHERE id = ?1`,
          )
          .bind(prior.id)
          .first<{ input_hash: string }>();
        if (receipt?.input_hash !== inputHash) {
          throw new CampaignBulkDeliveryError("bulk_idempotency_key_reused");
        }
        return Object.freeze({ value: toOperation(prior), replayed: true });
      }
      const result = await database
        .prepare(
          `INSERT INTO campaign_bulk_send_operations (
           id, site_id, campaign_id, campaign_revision_id, authorization_id,
           schedule_id, scheduled_instant, stable_send_key, state, attempt,
           lease_token, lease_expires_at, audience_snapshot_json,
           send_artifact_json, send_artifact_hash, send_artifact_commit_sha,
           provider_campaign_id, provider_message_id, provider_send_proof,
           provider_verification_json, detail,
           request_actor_id, request_id, input_hash,
           created_at, updated_at
         ) SELECT
           ?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, 'preparing', 0,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           authorization.owner_actor_id, ?7, ?8, ?9, ?10
         FROM campaign_bulk_authorizations AS authorization
         WHERE authorization.id = ?5`,
        )
        .bind(
          value.id,
          value.siteId,
          value.campaignId,
          value.campaignRevisionId,
          value.authorizationId,
          value.stableSendKey,
          requestId,
          inputHash,
          value.createdAt,
          value.updatedAt,
        )
        .run();
      // Inserting a send operation fires the durable guard that cancels a
      // competing active schedule, and D1 counts a trigger's writes in the
      // statement's change count. Confirm the durable row instead of a count
      // this insert cannot predict.
      const saved =
        changes(result) === 0
          ? null
          : await findOperation(database, value.siteId, value.id);
      if (saved === null) {
        throw new CampaignBulkDeliveryError("bulk_send_not_saved");
      }
      return Object.freeze({ value: saved, replayed: false });
    },
    async claimDueSchedule({
      now,
      latenessCutoff,
      leaseToken,
      leaseExpiresAt,
      createOperationId,
    }) {
      for (let scanned = 0; scanned < 100; scanned += 1) {
        const due = await database
          .prepare(
            `${scheduleProjection}
         WHERE state = 'active' AND execute_at_utc <= ?1
         ORDER BY execute_at_utc, id LIMIT 1`,
          )
          .bind(now)
          .first<ScheduleRow>();
        if (due === null) return null;
        if (due.execute_at_utc < latenessCutoff) {
          await database
            .prepare(
              `UPDATE campaign_bulk_schedules
             SET state = 'missed', updated_at = ?1
             WHERE id = ?2 AND state = 'active'`,
            )
            .bind(now, due.id)
            .run();
          continue;
        }
        const authorityRow = await database
          .prepare(
            `${authorizationProjection}
           WHERE id = ?1`,
          )
          .bind(due.authorization_id)
          .first<AuthorizationRow>();
        const competing = await database
          .prepare(
            `SELECT id FROM campaign_bulk_send_operations
           WHERE site_id = ?1 AND campaign_id = ?2
           LIMIT 1`,
          )
          .bind(due.site_id, due.campaign_id)
          .first<{ id: string }>();
        if (authorityRow === null || competing !== null) {
          await database
            .prepare(
              `UPDATE campaign_bulk_schedules
             SET state = 'blocked', updated_at = ?1
             WHERE id = ?2 AND state = 'active'`,
            )
            .bind(now, due.id)
            .run();
          continue;
        }
        const id = createOperationId();
        const stableSendKey = await sha256CanonicalJson({
          version: "foundry.campaign-bulk-send.v1",
          siteId: due.site_id,
          operationId: id,
          scheduleId: due.id,
          scheduledInstant: due.execute_at_utc,
        });
        const results = await database.batch([
          database
            .prepare(
              `UPDATE campaign_bulk_schedules
           SET state = 'claimed', updated_at = ?1
           WHERE id = ?2 AND state = 'active'
             AND EXISTS (
               SELECT 1
               FROM campaign_bulk_authorizations AS authorization
               JOIN campaigns AS campaign
                 ON campaign.site_id = authorization.site_id
                AND campaign.id = authorization.campaign_id
                AND campaign.current_revision_id =
                    authorization.campaign_revision_id
               JOIN human_memberships AS membership
                 ON membership.site_id = authorization.site_id
                AND membership.id = authorization.owner_actor_id
                AND membership.role = 'owner'
                AND membership.status = 'active'
               WHERE authorization.id = ?3
                 AND authorization.state = 'active'
             )`,
            )
            .bind(now, due.id, due.authorization_id),
          database
            .prepare(
              `INSERT INTO campaign_bulk_send_operations (
             id, site_id, campaign_id, campaign_revision_id,
             authorization_id, schedule_id, scheduled_instant,
             stable_send_key, state, attempt, lease_token, lease_expires_at,
             audience_snapshot_json, provider_campaign_id,
             send_artifact_json, send_artifact_hash, send_artifact_commit_sha,
             provider_message_id, provider_send_proof,
             provider_verification_json, detail,
             request_actor_id, request_id, input_hash, created_at, updated_at
           )
           SELECT
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'preparing', 1, ?9, ?10,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, ?11, ?11
           WHERE EXISTS (
             SELECT 1 FROM campaign_bulk_schedules
             WHERE id = ?6 AND state = 'claimed' AND updated_at = ?11
           )
           ON CONFLICT (schedule_id, scheduled_instant) DO NOTHING`,
            )
            .bind(
              id,
              due.site_id,
              due.campaign_id,
              authorityRow.campaign_revision_id,
              due.authorization_id,
              due.id,
              due.execute_at_utc,
              stableSendKey,
              leaseToken,
              leaseExpiresAt,
              now,
            ),
        ]);
        if (changes(results[0]!) !== 1 || changes(results[1]!) !== 1) {
          await database
            .prepare(
              `UPDATE campaign_bulk_schedules
             SET state = 'blocked', updated_at = ?1
             WHERE id = ?2 AND state IN ('active', 'claimed')
               AND NOT EXISTS (
                 SELECT 1 FROM campaign_bulk_send_operations
                 WHERE schedule_id = ?2
               )`,
            )
            .bind(now, due.id)
            .run();
          continue;
        }
        return findOperation(database, due.site_id as SiteId, id);
      }
      return null;
    },
    findOperation({ siteId, operationId }) {
      return findOperation(database, siteId, operationId);
    },
    async listReconciliationCandidates({
      siteId,
      now,
      sentReportingCutoff,
      limit,
    }) {
      const rows = await database
        .prepare(
          `${operationProjection}
         WHERE site_id = ?1
           AND (
             state IN ('ambiguous', 'provider_queued')
             OR (
               state IN ('preparing', 'attempting')
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?2)
             )
             OR (state = 'sent' AND updated_at > ?4)
           )
         ORDER BY updated_at, id LIMIT ?3`,
        )
        .bind(
          siteId,
          now,
          Math.max(1, Math.min(limit, 100)),
          sentReportingCutoff,
        )
        .all<OperationRow>();
      return rows.results.map(toOperation);
    },
    async claimOperation({
      siteId,
      operationId,
      expectedCampaignRevisionId,
      expectedOwnerActorId,
      now,
      heldLeaseToken,
      leaseToken,
      leaseExpiresAt,
    }) {
      const result = await database
        .prepare(
          `UPDATE campaign_bulk_send_operations
         SET attempt = attempt + 1,
           state = CASE WHEN state IN ('failed', 'blocked')
                        THEN 'preparing' ELSE state END,
           lease_token = ?1,
           lease_expires_at = ?2, updated_at = ?3
         WHERE site_id = ?4 AND id = ?5
           AND campaign_revision_id = ?6
           AND state IN (
             'preparing', 'attempting', 'ambiguous', 'failed', 'blocked'
           )
           AND (
             lease_expires_at IS NULL
             OR lease_expires_at <= ?3
             OR (?8 IS NOT NULL AND lease_token = ?8)
           )
           AND EXISTS (
             SELECT 1
             FROM campaign_bulk_authorizations AS authorization
             JOIN campaigns AS campaign
               ON campaign.site_id = authorization.site_id
              AND campaign.id = authorization.campaign_id
              AND campaign.current_revision_id =
                  authorization.campaign_revision_id
             JOIN human_memberships AS membership
               ON membership.site_id = authorization.site_id
              AND membership.id = authorization.owner_actor_id
              AND membership.role = 'owner'
              AND membership.status = 'active'
             WHERE authorization.id =
                 campaign_bulk_send_operations.authorization_id
               AND authorization.state = 'active'
               AND authorization.owner_actor_id = ?7
           )`,
        )
        .bind(
          leaseToken,
          leaseExpiresAt,
          now,
          siteId,
          operationId,
          expectedCampaignRevisionId,
          expectedOwnerActorId,
          heldLeaseToken,
        )
        .run();
      return changes(result) === 1
        ? findOperation(database, siteId, operationId)
        : null;
    },
    async saveAudienceSnapshot({
      operation: value,
      snapshot,
      sendArtifact,
      sendArtifactHash,
      now,
    }) {
      const result = await database
        .prepare(
          // A replacement artifact needs its own commit, so the recorded
          // commit is cleared whenever the artifact hash changes. The
          // superseded commit stays in Git history untouched.
          `UPDATE campaign_bulk_send_operations
         SET audience_snapshot_json = ?1,
           send_artifact_json = ?2,
           send_artifact_hash = ?3,
           send_artifact_commit_sha =
             CASE WHEN send_artifact_hash IS ?3
                  THEN send_artifact_commit_sha ELSE NULL END,
           updated_at = ?4
         WHERE id = ?5 AND site_id = ?6 AND lease_token = ?7
           AND lease_expires_at > ?4
           AND state = 'preparing'
           AND (
             provider_send_proof IS NULL
             OR (
               json_extract(audience_snapshot_json, '$.fingerprint') = ?8
               AND send_artifact_hash IS ?3
             )
           )`,
        )
        .bind(
          JSON.stringify(snapshot),
          JSON.stringify(sendArtifact),
          sendArtifactHash,
          now,
          value.id,
          value.siteId,
          value.leaseToken,
          snapshot.fingerprint,
        )
        .run();
      return changes(result) === 1
        ? findOperation(database, value.siteId, value.id)
        : null;
    },
    async recordArtifactPublication({ operation: value, outcome, now }) {
      const result = await database
        .prepare(
          `UPDATE campaign_bulk_send_operations
         SET send_artifact_commit_sha =
               CASE WHEN ?1 = 'committed' THEN ?2
                    ELSE send_artifact_commit_sha END,
           state = CASE WHEN ?1 = 'failed' THEN 'blocked' ELSE state END,
           detail = ?3,
           lease_token = CASE WHEN ?1 = 'committed' THEN lease_token
                              ELSE NULL END,
           lease_expires_at =
             CASE WHEN ?1 = 'committed' THEN lease_expires_at
                  ELSE NULL END,
           updated_at = ?4
         WHERE id = ?5 AND site_id = ?6 AND lease_token = ?7
           AND state = 'preparing'
           AND send_artifact_hash IS NOT NULL`,
        )
        .bind(
          outcome.outcome,
          outcome.outcome === "committed" ? outcome.commitSha : null,
          "code" in outcome ? outcome.code : null,
          now,
          value.id,
          value.siteId,
          value.leaseToken,
        )
        .run();
      if (changes(result) !== 1) {
        throw new CampaignBulkDeliveryError("bulk_execution_lease_lost");
      }
      return (await findOperation(database, value.siteId, value.id))!;
    },
    async releaseLease({ operation: value, now }) {
      await database
        .prepare(
          `UPDATE campaign_bulk_send_operations
         SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?1
         WHERE id = ?2 AND site_id = ?3 AND lease_token = ?4
           AND provider_send_proof IS NULL`,
        )
        .bind(now, value.id, value.siteId, value.leaseToken)
        .run();
    },
    async beginProviderAttempt({
      operation: value,
      activeSubscriberIds,
      providerCampaignId,
      providerSendProof,
      now,
    }) {
      const idsJson = JSON.stringify(activeSubscriberIds);
      const result = await database
        .prepare(
          // The correlation key is written before the first provider write so
          // a delivery event that arrives while that write is still in flight
          // already correlates to this operation.
          `UPDATE campaign_bulk_send_operations
         SET state = 'attempting', provider_send_proof = ?1,
           provider_campaign_id = COALESCE(provider_campaign_id, ?7),
           updated_at = ?2
         WHERE id = ?3 AND site_id = ?4 AND lease_token = ?5
           AND lease_expires_at > ?2
           AND audience_snapshot_json IS NOT NULL
           AND send_artifact_json IS NOT NULL
           AND send_artifact_hash IS NOT NULL
           AND send_artifact_commit_sha IS NOT NULL
           AND state IN ('preparing', 'attempting', 'ambiguous')
           AND (
             provider_campaign_id IS NULL
             OR provider_campaign_id = ?7
           )
           AND (
             provider_send_proof IS NULL
             OR provider_send_proof = ?1
           )
           AND json_array_length(
             json_extract(audience_snapshot_json, '$.subscriberIds')
           ) = json_array_length(?6)
           AND NOT EXISTS (
             SELECT 1 FROM json_each(?6) AS requested
             LEFT JOIN subscribers AS subscriber
               ON subscriber.site_id =
                    campaign_bulk_send_operations.site_id
              AND subscriber.id = requested.value
              AND subscriber.state = 'active'
             WHERE subscriber.id IS NULL
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(
               json_extract(audience_snapshot_json, '$.subscriberIds')
             ) AS snap
             WHERE snap.value NOT IN (
               SELECT value FROM json_each(?6)
             )
           )`,
        )
        .bind(
          providerSendProof,
          now,
          value.id,
          value.siteId,
          value.leaseToken,
          idsJson,
          providerCampaignId,
        )
        .run();
      return changes(result) === 1
        ? findOperation(database, value.siteId, value.id)
        : null;
    },
    async recordProviderOutcome({ operation: value, outcome, now }) {
      if (outcome.outcome === "verified") {
        if (
          outcome.providerMessageIds.length === 0 ||
          outcome.providerMessageIds.some(
            (id) => id.trim() === "" || id.length > 512,
          ) ||
          new Set(outcome.providerMessageIds).size !==
            outcome.providerMessageIds.length
        ) {
          throw new CampaignBulkDeliveryError(
            "bulk_provider_evidence_invalid",
          );
        }
        const providerMessageIds = [
          ...new Set(outcome.providerMessageIds),
        ].sort();
        if (
          value.providerVerification !== null &&
          JSON.stringify(value.providerVerification.providerMessageIds) !==
            JSON.stringify(providerMessageIds)
        ) {
          throw new CampaignBulkDeliveryError("bulk_provider_evidence_invalid");
        }
        const providerMessageId =
          providerMessageIds.length === 1
            ? providerMessageIds[0]!
            : value.providerMessageId;
        const providerVerification = JSON.stringify(
          value.providerVerification ?? {
            providerMessageIds,
            verifiedAt: now,
          },
        );
        const result = await database
          .prepare(
            `UPDATE campaign_bulk_send_operations
           SET state = CASE WHEN state = 'attempting' THEN 'ambiguous'
                            ELSE state END,
             provider_campaign_id =
               COALESCE(provider_campaign_id, ?1),
             provider_message_id =
               COALESCE(provider_message_id, ?2),
             provider_verification_json =
               COALESCE(provider_verification_json, ?3),
             detail = NULL, lease_token = NULL, lease_expires_at = NULL,
             updated_at = ?4
           WHERE id = ?5 AND site_id = ?6
             AND state IN ('attempting', 'ambiguous', 'provider_queued')
             AND (
               provider_campaign_id IS NULL
               OR provider_campaign_id = ?1
             )
             AND (
               provider_message_id IS NULL
               OR provider_message_id = ?2
               OR ?2 IS NULL
             )
             AND (
               provider_verification_json IS NULL
               OR provider_verification_json = ?3
             )`,
          )
          .bind(
            outcome.providerCampaignId,
            providerMessageId,
            providerVerification,
            now,
            value.id,
            value.siteId,
          )
          .run();
        if (changes(result) !== 1) {
          throw new CampaignBulkDeliveryError("bulk_provider_evidence_invalid");
        }
        return (await findOperation(database, value.siteId, value.id))!;
      }
      const state: CampaignBulkSendOperation["state"] =
        outcome.outcome === "accepted"
          ? "provider_queued"
          : outcome.outcome === "ambiguous"
            ? "ambiguous"
            : "failed";
      const providerCampaignId =
        "providerCampaignId" in outcome
          ? outcome.providerCampaignId
          : value.providerCampaignId;
      const providerMessageId =
        outcome.outcome === "accepted"
          ? outcome.providerMessageId
          : value.providerMessageId;
      const detail = "code" in outcome ? outcome.code : null;
      const result = await database
        .prepare(
          `UPDATE campaign_bulk_send_operations
           SET state = ?1, provider_campaign_id = ?2,
             provider_message_id = ?3, detail = ?4,
             lease_token = NULL, lease_expires_at = NULL, updated_at = ?5
           WHERE id = ?6 AND site_id = ?7 AND lease_token = ?8
             AND state = 'attempting'`,
        )
        .bind(
          state,
          providerCampaignId,
          providerMessageId,
          detail,
          now,
          value.id,
          value.siteId,
          value.leaseToken,
        )
        .run();
      if (changes(result) !== 1) {
        throw new CampaignBulkDeliveryError("bulk_execution_lease_lost");
      }
      return (await findOperation(database, value.siteId, value.id))!;
    },
    async recordEvent(event: VerifiedCampaignDeliveryEvent) {
      const existing = await database
        .prepare(
          `SELECT payload_fingerprint
         FROM campaign_bulk_delivery_events WHERE event_id = ?1`,
        )
        .bind(event.eventId)
        .first<{ payload_fingerprint: string }>();
      if (existing !== null) {
        return existing.payload_fingerprint === event.payloadFingerprint
          ? "duplicate"
          : "conflict";
      }
      const result = await database
        .prepare(
          `INSERT INTO campaign_bulk_delivery_events (
           event_id, payload_fingerprint, site_id, operation_id,
           provider_campaign_id, provider_message_id,
           provider_send_proof, recipient_identity_key, event_type,
           occurred_at, received_at,
           source
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
         WHERE EXISTS (
           SELECT 1 FROM campaign_bulk_send_operations AS operation
           WHERE operation.id = ?4
             AND operation.site_id = ?3
             AND operation.provider_campaign_id = ?5
             AND (
               (?12 = 'webhook' AND operation.provider_send_proof = ?7)
               OR (?12 = 'poll' AND ?7 IS NULL)
             )
             AND operation.audience_snapshot_json IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM json_each(
                 json_extract(
                   operation.audience_snapshot_json, '$.recipients'
                 )
               ) AS snap
               WHERE json_extract(snap.value, '$.identityKey') = ?8
             )
         )
         ON CONFLICT (event_id) DO NOTHING`,
        )
        .bind(
          event.eventId,
          event.payloadFingerprint,
          event.siteId,
          event.operationId,
          event.providerCampaignId,
          event.providerMessageId,
          event.providerSendProof,
          event.recipientIdentityKey,
          event.type,
          event.occurredAt,
          event.receivedAt,
          event.source,
        )
        .run();
      if (changes(result) === 1) return "recorded";
      const raced = await database
        .prepare(
          `SELECT payload_fingerprint
         FROM campaign_bulk_delivery_events WHERE event_id = ?1`,
        )
        .bind(event.eventId)
        .first<{ payload_fingerprint: string }>();
      if (raced !== null) {
        return raced.payload_fingerprint === event.payloadFingerprint
          ? "duplicate"
          : "conflict";
      }
      throw new CampaignBulkDeliveryError("bulk_delivery_event_unmatched");
    },
    async confirmProviderAcceptance({
      siteId,
      operationId,
      providerCampaignId,
      providerMessageIds,
      now,
    }) {
      const row = await findOperation(database, siteId, operationId);
      if (
        row === null ||
        row.providerCampaignId !== providerCampaignId ||
        row.providerSendProof === null ||
        row.audienceSnapshot === null ||
        row.providerVerification === null ||
        providerMessageIds.length === 0
      ) {
        return null;
      }
      const normalizedProviderMessageIds = [
        ...new Set(providerMessageIds),
      ].sort();
      if (
        JSON.stringify(normalizedProviderMessageIds) !==
        JSON.stringify(row.providerVerification.providerMessageIds)
      ) {
        return null;
      }
      const messageIdsJson = JSON.stringify(normalizedProviderMessageIds);
      const statements = [
        database
          .prepare(
            `UPDATE campaign_bulk_send_operations
           SET state = 'sent', updated_at = ?1,
             lease_token = NULL, lease_expires_at = NULL
           WHERE site_id = ?2 AND id = ?3
             AND provider_campaign_id = ?4
             AND state IN ('provider_queued', 'ambiguous')
             AND provider_verification_json IS NOT NULL
             AND (
               SELECT COUNT(DISTINCT event.recipient_identity_key)
               FROM campaign_bulk_delivery_events AS event
               WHERE event.operation_id = ?3
                 AND event.site_id = ?2
                 AND event.provider_campaign_id = ?4
                 AND event.provider_send_proof =
                     campaign_bulk_send_operations.provider_send_proof
                 AND event.source = 'webhook'
                 AND event.event_type IN (
                   'accepted', 'delivered', 'opened', 'clicked',
                   'unsubscribed', 'complained', 'hard_bounced',
                   'soft_bounced', 'deferred'
                 )
                 AND event.provider_message_id IN (
                   SELECT value FROM json_each(?5)
                 )
             ) = json_array_length(
               json_extract(audience_snapshot_json, '$.recipients')
             )
             AND NOT EXISTS (
               SELECT 1
               FROM json_each(
                 json_extract(audience_snapshot_json, '$.recipients')
               ) AS expected
               WHERE json_extract(expected.value, '$.identityKey') NOT IN (
                 SELECT event.recipient_identity_key
                 FROM campaign_bulk_delivery_events AS event
                 WHERE event.operation_id = ?3
                   AND event.site_id = ?2
                   AND event.provider_campaign_id = ?4
                   AND event.provider_send_proof =
                       campaign_bulk_send_operations.provider_send_proof
                   AND event.source = 'webhook'
                 AND event.event_type IN (
                   'accepted', 'delivered', 'opened', 'clicked',
                   'unsubscribed', 'complained', 'hard_bounced',
                   'soft_bounced', 'deferred'
                 )
                   AND event.provider_message_id IN (
                     SELECT value FROM json_each(?5)
                   )
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?5) AS expected_message
               WHERE expected_message.value NOT IN (
                 SELECT event.provider_message_id
                 FROM campaign_bulk_delivery_events AS event
                 WHERE event.operation_id = ?3
                   AND event.site_id = ?2
                   AND event.provider_campaign_id = ?4
                   AND event.provider_send_proof =
                       campaign_bulk_send_operations.provider_send_proof
                   AND event.source = 'webhook'
                 AND event.event_type IN (
                   'accepted', 'delivered', 'opened', 'clicked',
                   'unsubscribed', 'complained', 'hard_bounced',
                   'soft_bounced', 'deferred'
                 )
               )
             )`,
          )
          .bind(now, siteId, operationId, providerCampaignId, messageIdsJson),
        database
          .prepare(
            `UPDATE campaign_bulk_authorizations
           SET state = 'consumed'
           WHERE id = ?1 AND state = 'active'
             AND EXISTS (
               SELECT 1 FROM campaign_bulk_send_operations
               WHERE id = ?2 AND state = 'sent'
             )`,
          )
          .bind(row.authorizationId, row.id),
      ];
      if (row.scheduleId !== null) {
        statements.push(
          database
            .prepare(
              `UPDATE campaign_bulk_schedules
             SET state = 'completed', updated_at = ?1
             WHERE id = ?2 AND state = 'claimed'
               AND EXISTS (
                 SELECT 1 FROM campaign_bulk_send_operations
                 WHERE id = ?3 AND state = 'sent'
               )`,
            )
            .bind(now, row.scheduleId, row.id),
        );
      }
      const results = await database.batch(statements);
      if (changes(results[0]!) !== 1) {
        return null;
      }
      return (await findOperation(database, siteId, operationId))!;
    },
  });
}

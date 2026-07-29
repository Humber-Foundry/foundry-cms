import {
  createCampaignId,
  createCampaignRevisionId,
  type Campaign,
  type CampaignAuditEvent,
  type CampaignCommandKey,
  type CampaignCommandReceipt,
  type CampaignCommandStoreResult,
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

type ReceiptRow = {
  site_id: string;
  actor_id: string;
  command_name: CampaignCommandKey["commandName"];
  request_id: string;
  input_hash: string;
  outcome: "accepted" | "rejected";
  result_json: string | null;
  reason: string | null;
  completed_at: string;
};

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

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

function toReceipt(row: ReceiptRow): CampaignCommandReceipt {
  const key = {
    siteId: row.site_id as SiteId,
    actorId: row.actor_id,
    commandName: row.command_name,
    requestId: row.request_id,
    inputHash: row.input_hash,
    completedAt: row.completed_at,
  };
  if (row.outcome === "rejected") {
    return Object.freeze({
      ...key,
      outcome: "rejected",
      campaign: null,
      revision: null,
      reason: row.reason ?? "campaign_command_rejected",
    });
  }
  const result = JSON.parse(row.result_json ?? "null") as {
    campaign: Campaign;
    revision: CampaignRevision;
  } | null;
  if (result === null) throw new Error("campaign_receipt_result_invalid");
  return Object.freeze({
    ...key,
    outcome: "accepted",
    campaign: deepFreeze(result.campaign),
    revision: deepFreeze(result.revision),
    reason: null,
  });
}

const campaignProjection = `
  SELECT id, site_id, lifecycle_state, current_revision_id,
    version, created_at, updated_at
  FROM campaigns
`;

const receiptProjection = `
  SELECT site_id, actor_id, command_name, request_id, input_hash,
    outcome, result_json, reason, completed_at
  FROM campaign_command_receipts
`;

function commandPredicate() {
  return `site_id = ?1 AND actor_id = ?2 AND command_name = ?3
    AND request_id = ?4`;
}

function bindCommand(
  database: D1DatabaseBinding,
  sql: string,
  command: Omit<CampaignCommandKey, "inputHash">,
) {
  return database
    .prepare(sql)
    .bind(
      command.siteId,
      command.actorId,
      command.commandName,
      command.requestId,
    );
}

function claimInsert(
  database: D1DatabaseBinding,
  command: CampaignCommandKey,
  completedAt: string,
) {
  return database
    .prepare(
      `INSERT INTO campaign_command_receipts (
         site_id, actor_id, command_name, request_id, input_hash,
         outcome, result_json, reason, completed_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, NULL, ?6)
       ON CONFLICT (site_id, actor_id, command_name, request_id) DO NOTHING`,
    )
    .bind(
      command.siteId,
      command.actorId,
      command.commandName,
      command.requestId,
      command.inputHash,
      completedAt,
    );
}

function pendingCommandExists(alias = "campaign_command_receipts") {
  return `EXISTS (
    SELECT 1 FROM campaign_command_receipts ${alias}
    WHERE ${alias}.site_id = ?1
      AND ${alias}.actor_id = ?2
      AND ${alias}.command_name = ?3
      AND ${alias}.request_id = ?4
      AND ${alias}.input_hash = ?5
      AND ${alias}.outcome = 'pending'
  )`;
}

function auditInsert(
  database: D1DatabaseBinding,
  event: CampaignAuditEvent,
  condition = "1 = 1",
) {
  return database
    .prepare(
      `INSERT INTO campaign_audit_events (
         id, site_id, actor_id, target_id, request_id, input_hash, action,
         outcome, campaign_revision_id, reason, before_state, after_state,
         occurred_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
       WHERE ${condition}`,
    )
    .bind(
      event.id,
      event.siteId,
      event.actorId,
      event.targetId,
      event.requestId,
      event.inputHash,
      event.action,
      event.outcome,
      event.revisionId,
      event.reason,
      event.beforeState,
      event.afterState,
      event.occurredAt,
    );
}

function commandAuditInsert(
  database: D1DatabaseBinding,
  event: CampaignAuditEvent,
  command: CampaignCommandKey,
  domainCondition = "",
  domainValues: ReadonlyArray<unknown> = [],
) {
  return database
    .prepare(
      `INSERT INTO campaign_audit_events (
         id, site_id, actor_id, target_id, request_id, input_hash, action,
         outcome, campaign_revision_id, reason, before_state, after_state,
         occurred_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
       WHERE EXISTS (
         SELECT 1 FROM campaign_command_receipts
         WHERE site_id = ?14 AND actor_id = ?15 AND command_name = ?16
           AND request_id = ?17 AND input_hash = ?18
           AND outcome = 'pending'
       ) ${domainCondition}`,
    )
    .bind(
      event.id,
      event.siteId,
      event.actorId,
      event.targetId,
      event.requestId,
      event.inputHash,
      event.action,
      event.outcome,
      event.revisionId,
      event.reason,
      event.beforeState,
      event.afterState,
      event.occurredAt,
      command.siteId,
      command.actorId,
      command.commandName,
      command.requestId,
      command.inputHash,
      ...domainValues,
    );
}

async function readReceipt(
  database: D1DatabaseBinding,
  command: Omit<CampaignCommandKey, "inputHash">,
) {
  const row = await bindCommand(
    database,
    `${receiptProjection} WHERE ${commandPredicate()}`,
    command,
  ).first<ReceiptRow>();
  return row === null ? null : toReceipt(row);
}

async function commandResult(
  database: D1DatabaseBinding,
  command: CampaignCommandKey,
  replayed: boolean,
): Promise<CampaignCommandStoreResult> {
  const receipt = await readReceipt(database, command);
  if (receipt === null) throw new Error("campaign_receipt_missing");
  return Object.freeze({ receipt, replayed });
}

export function createD1CampaignStore(
  database: D1DatabaseBinding,
): CampaignStore {
  return {
    findCommandReceipt(command) {
      return readReceipt(database, command);
    },
    async create({
      command,
      campaign,
      revision,
      acceptedAudit,
      rejectedAudit,
    }) {
      const resultJson = JSON.stringify({ campaign, revision });
      const pending = pendingCommandExists();
      const results = await database.batch([
        claimInsert(database, command, revision.createdAt),
        database
          .prepare(
            `INSERT INTO campaigns (
               id, site_id, lifecycle_state, current_revision_id,
               version, created_at, updated_at
             )
             SELECT ?6, ?1, ?7, ?8, ?9, ?10, ?11
             WHERE ${pending}
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            campaign.id,
            campaign.lifecycleState,
            campaign.currentRevisionId,
            campaign.version,
            campaign.createdAt,
            campaign.updatedAt,
          ),
        database
          .prepare(
            `INSERT INTO campaign_revisions (
               id, site_id, campaign_id, revision_number,
               revision_json, created_at
             )
             SELECT ?6, ?1, ?7, ?8, ?9, ?10
             WHERE ${pending}
               AND EXISTS (
                 SELECT 1 FROM campaigns
                 WHERE site_id = ?1 AND id = ?7
                   AND current_revision_id = ?6 AND version = ?8
               )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            revision.id,
            revision.campaignId,
            revision.revisionNumber,
            JSON.stringify(revision),
            revision.createdAt,
          ),
        commandAuditInsert(
          database,
          acceptedAudit,
          command,
          `AND EXISTS (
            SELECT 1 FROM campaign_revisions
            WHERE id = ?19 AND site_id = ?20 AND campaign_id = ?21
          )`,
          [revision.id, revision.siteId, revision.campaignId],
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'accepted', result_json = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'
               AND EXISTS (
                 SELECT 1 FROM campaign_revisions
                 WHERE id = ?8 AND site_id = ?1
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            resultJson,
            revision.createdAt,
            revision.id,
          ),
        commandAuditInsert(
          database,
          rejectedAudit,
          command,
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'rejected', reason = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            rejectedAudit.reason,
            rejectedAudit.occurredAt,
          ),
      ]);
      return commandResult(
        database,
        command,
        (results[0]?.meta.changes ?? 0) === 0,
      );
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
        : deepFreeze(JSON.parse(row.revision_json) as CampaignRevision);
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
    async appendRevision({
      command,
      expectedVersion,
      campaign,
      revision,
      acceptedAudit,
      rejectedAudit,
    }) {
      const resultJson = JSON.stringify({ campaign, revision });
      const pending = pendingCommandExists();
      const results = await database.batch([
        claimInsert(database, command, revision.createdAt),
        database
          .prepare(
            `INSERT INTO campaign_revisions (
               id, site_id, campaign_id, revision_number,
               revision_json, created_at
             )
             SELECT ?6, ?1, ?7, ?8, ?9, ?10
             WHERE ${pending}
               AND EXISTS (
                 SELECT 1 FROM campaigns
                 WHERE site_id = ?1 AND id = ?7 AND version = ?11
               )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            revision.id,
            revision.campaignId,
            revision.revisionNumber,
            JSON.stringify(revision),
            revision.createdAt,
            expectedVersion,
          ),
        database
          .prepare(
            `UPDATE campaigns
             SET lifecycle_state = ?6, current_revision_id = ?7,
               version = ?8, updated_at = ?9
             WHERE site_id = ?1 AND id = ?10 AND version = ?11
               AND ${pending}
               AND EXISTS (
                 SELECT 1 FROM campaign_revisions
                 WHERE id = ?7 AND site_id = ?1
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            campaign.lifecycleState,
            campaign.currentRevisionId,
            campaign.version,
            campaign.updatedAt,
            campaign.id,
            expectedVersion,
          ),
        database
          .prepare(
            `UPDATE campaign_test_deliveries
             SET state = 'cancelled', attempt_lease_until = NULL,
               failure_code = 'campaign_revision_changed', updated_at = ?6
             WHERE site_id = ?1 AND campaign_id = ?7
               AND campaign_revision_id != ?8
               AND state IN ('pending', 'attempting', 'ambiguous')
               AND EXISTS (
                 SELECT 1 FROM campaigns
                 WHERE site_id = ?1 AND id = ?7
                   AND current_revision_id = ?8 AND version = ?9
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            revision.createdAt,
            campaign.id,
            revision.id,
            campaign.version,
          ),
        commandAuditInsert(
          database,
          acceptedAudit,
          command,
          `AND EXISTS (
            SELECT 1 FROM campaigns
            WHERE site_id = ?19 AND id = ?20
              AND current_revision_id = ?21 AND version = ?22
          )`,
          [
            campaign.siteId,
            campaign.id,
            revision.id,
            campaign.version,
          ],
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'accepted', result_json = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'
               AND EXISTS (
                 SELECT 1 FROM campaigns
                 WHERE site_id = ?1 AND id = ?8
                   AND current_revision_id = ?9 AND version = ?10
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            resultJson,
            revision.createdAt,
            campaign.id,
            revision.id,
            campaign.version,
          ),
        commandAuditInsert(
          database,
          rejectedAudit,
          command,
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'rejected', reason = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            rejectedAudit.reason,
            rejectedAudit.occurredAt,
          ),
      ]);
      return commandResult(
        database,
        command,
        (results[0]?.meta.changes ?? 0) === 0,
      );
    },
    async rejectCommand({ command, audit }) {
      const results = await database.batch([
        claimInsert(database, command, audit.occurredAt),
        commandAuditInsert(
          database,
          audit,
          command,
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'rejected', reason = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            audit.reason,
            audit.occurredAt,
          ),
      ]);
      return commandResult(
        database,
        command,
        (results[0]?.meta.changes ?? 0) === 0,
      );
    },
    async acceptTestCommand({ command, campaign, revision, audit }) {
      const resultJson = JSON.stringify({ campaign, revision });
      const results = await database.batch([
        claimInsert(database, command, audit.occurredAt),
        commandAuditInsert(
          database,
          audit,
          command,
          `AND EXISTS (
            SELECT 1 FROM campaign_revisions
            WHERE id = ?19 AND site_id = ?20 AND campaign_id = ?21
          )`,
          [revision.id, revision.siteId, revision.campaignId],
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'accepted', result_json = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'
               AND EXISTS (
                 SELECT 1 FROM campaign_revisions
                 WHERE id = ?8 AND site_id = ?1 AND campaign_id = ?9
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            resultJson,
            audit.occurredAt,
            revision.id,
            campaign.id,
          ),
      ]);
      return commandResult(
        database,
        command,
        (results[0]?.meta.changes ?? 0) === 0,
      );
    },
    async acceptTestReceiptConfirmation({
      command,
      campaign,
      revision,
      audit,
      conflictAudit,
      staleAudit,
      confirmation,
    }) {
      const resultJson = JSON.stringify({ campaign, revision });
      const results = await database.batch([
        claimInsert(database, command, audit.occurredAt),
        database
          .prepare(
            `INSERT INTO campaign_test_receipt_confirmations (
               execution_id, site_id, owner_actor_id, request_id, confirmed_at
             )
             SELECT ?6, ?7, ?8, ?9, ?10
             WHERE ${pendingCommandExists()}
               AND ?7 = ?1 AND ?8 = ?2 AND ?9 = ?4
               AND EXISTS (
               SELECT 1 FROM campaign_test_deliveries
                 WHERE execution_id = ?6 AND site_id = ?7
                   AND campaign_id = ?11
                   AND campaign_revision_id = ?12
                   AND state = 'accepted' AND evidence_json IS NOT NULL
               )
               AND EXISTS (
                 SELECT 1 FROM campaigns
                 WHERE site_id = ?7 AND id = ?11
                   AND current_revision_id = ?12 AND version = ?13
               )
             ON CONFLICT DO NOTHING`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            confirmation.executionId,
            confirmation.siteId,
            confirmation.ownerActorId,
            confirmation.requestId,
            confirmation.confirmedAt,
            campaign.id,
            revision.id,
            campaign.version,
          ),
        commandAuditInsert(
          database,
          audit,
          command,
          `AND EXISTS (
            SELECT 1 FROM campaign_test_receipt_confirmations
            WHERE execution_id = ?19 AND site_id = ?20
              AND owner_actor_id = ?21 AND request_id = ?22
          )`,
          [
            confirmation.executionId,
            confirmation.siteId,
            confirmation.ownerActorId,
            confirmation.requestId,
          ],
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'accepted', result_json = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'
               AND EXISTS (
                 SELECT 1 FROM campaign_test_receipt_confirmations
                 WHERE execution_id = ?8 AND site_id = ?1
                   AND owner_actor_id = ?2 AND request_id = ?4
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            resultJson,
            audit.occurredAt,
            confirmation.executionId,
          ),
        commandAuditInsert(
          database,
          staleAudit,
          command,
          `AND NOT EXISTS (
            SELECT 1 FROM campaign_test_receipt_confirmations
            WHERE execution_id = ?19 AND site_id = ?20
          )
          AND NOT EXISTS (
            SELECT 1 FROM campaigns
            WHERE site_id = ?20 AND id = ?21
              AND current_revision_id = ?22 AND version = ?23
          )`,
          [
            confirmation.executionId,
            confirmation.siteId,
            campaign.id,
            revision.id,
            campaign.version,
          ],
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'rejected', reason = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'
               AND NOT EXISTS (
                 SELECT 1 FROM campaign_test_receipt_confirmations
                 WHERE execution_id = ?8 AND site_id = ?1
               )
               AND NOT EXISTS (
                 SELECT 1 FROM campaigns
                 WHERE site_id = ?1 AND id = ?9
                   AND current_revision_id = ?10 AND version = ?11
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            staleAudit.reason,
            staleAudit.occurredAt,
            confirmation.executionId,
            campaign.id,
            revision.id,
            campaign.version,
          ),
        commandAuditInsert(
          database,
          conflictAudit,
          command,
          `AND EXISTS (
            SELECT 1 FROM campaign_test_receipt_confirmations
            WHERE execution_id = ?19 AND site_id = ?20
              AND (owner_actor_id != ?21 OR request_id != ?22)
          )`,
          [
            confirmation.executionId,
            confirmation.siteId,
            confirmation.ownerActorId,
            confirmation.requestId,
          ],
        ),
        database
          .prepare(
            `UPDATE campaign_command_receipts
             SET outcome = 'rejected', reason = ?6, completed_at = ?7
             WHERE ${commandPredicate()} AND input_hash = ?5
               AND outcome = 'pending'
               AND EXISTS (
                 SELECT 1 FROM campaign_test_receipt_confirmations
                 WHERE execution_id = ?8 AND site_id = ?1
                   AND (owner_actor_id != ?2 OR request_id != ?4)
               )`,
          )
          .bind(
            command.siteId,
            command.actorId,
            command.commandName,
            command.requestId,
            command.inputHash,
            conflictAudit.reason,
            conflictAudit.occurredAt,
            confirmation.executionId,
          ),
      ]);
      return commandResult(
        database,
        command,
        (results[0]?.meta.changes ?? 0) === 0,
      );
    },
    async recordAudit(event) {
      await auditInsert(database, event).run();
    },
  };
}

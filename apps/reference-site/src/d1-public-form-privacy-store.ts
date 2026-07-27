import {
  PublicFormPrivacyError,
  createPublicFormId,
  createPublicFormReceiptId,
  type PublicFormBackupAcceptanceAuditRow,
  type PublicFormBackupClassificationRow,
  type PublicFormBackupDeliveryRow,
  type PublicFormBackupNotificationJobRow,
  type PublicFormBackupOperationAuditRow,
  type PublicFormBackupOutboxRow,
  type PublicFormBackupSnapshot,
  type PublicFormBackupSubmissionRow,
  type PublicFormPrivacyStore,
} from "@foundry/application";

import type { D1DatabaseBinding } from "./d1-human-access-store";

function daysBefore(now: string, days: number) {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

const liveSnapshotTables = {
  submissions: "public_form_submissions",
  classifications: "public_form_classifications",
  deliveries: "public_form_delivery_intents",
  outboxEvents: "public_form_outbox_events",
  notificationJobs: "public_form_notification_jobs",
  acceptanceAuditFacts: "public_form_audit_events",
  auditFacts: "public_form_operation_audit_events",
} as const;

const restoreStageTables = {
  submissions: "public_form_restore_stage_submissions",
  classifications: "public_form_restore_stage_classifications",
  deliveries: "public_form_restore_stage_delivery_intents",
  outboxEvents: "public_form_restore_stage_outbox_events",
  notificationJobs: "public_form_restore_stage_notification_jobs",
  acceptanceAuditFacts: "public_form_restore_stage_acceptance_audit_events",
  auditFacts: "public_form_restore_stage_operation_audit_events",
} as const;

const restoreTargetEmptySql = Object.values(liveSnapshotTables)
  .map((table) => `(SELECT COUNT(*) FROM ${table})`)
  .join(" + ");

type SnapshotTables = {
  [Key in keyof typeof liveSnapshotTables]: string;
};

function readCountResult(
  result: Awaited<ReturnType<D1DatabaseBinding["batch"]>>[number],
) {
  const row = result.results?.[0];
  if (
    result.success !== true ||
    result.results?.length !== 1 ||
    typeof row !== "object" ||
    row === null ||
    !("count" in row) ||
    typeof row.count !== "number" ||
    !Number.isSafeInteger(row.count) ||
    row.count < 0
  ) {
    throw new PublicFormPrivacyError("recovery_target_check_failed");
  }
  return row.count;
}

async function snapshotRows(
  database: D1DatabaseBinding,
  siteId: string,
  createdAt: string,
  tables: SnapshotTables = liveSnapshotTables,
): Promise<PublicFormBackupSnapshot> {
  const results = await database.batch([
    database
      .prepare(
        `SELECT * FROM ${tables.submissions}
         WHERE site_id = ?1 ORDER BY form_id, submission_id`,
      )
      .bind(siteId),
    database
      .prepare(
        `SELECT * FROM ${tables.classifications}
         WHERE site_id = ?1 ORDER BY id`,
      )
      .bind(siteId),
    database
      .prepare(
        `SELECT * FROM ${tables.deliveries}
         WHERE site_id = ?1 ORDER BY id`,
      )
      .bind(siteId),
    database
      .prepare(
        `SELECT outbox.* FROM ${tables.outboxEvents} AS outbox
         JOIN ${tables.deliveries} AS delivery
           ON delivery.id = outbox.delivery_id
         WHERE delivery.site_id = ?1 ORDER BY outbox.id`,
      )
      .bind(siteId),
    database
      .prepare(
        `SELECT job.* FROM ${tables.notificationJobs} AS job
         JOIN ${tables.deliveries} AS delivery
           ON delivery.id = job.delivery_id
         WHERE delivery.site_id = ?1 ORDER BY job.delivery_id`,
      )
      .bind(siteId),
    database
      .prepare(
        `SELECT * FROM ${tables.acceptanceAuditFacts}
         WHERE site_id = ?1 ORDER BY id`,
      )
      .bind(siteId),
    database
      .prepare(
        `SELECT * FROM ${tables.auditFacts}
         WHERE site_id = ?1 ORDER BY id`,
      )
      .bind(siteId),
  ]);
  function resultRows<T>(index: number) {
    return (results[index]?.results ?? []) as ReadonlyArray<T>;
  }
  return {
    version: 1,
    siteId: siteId as PublicFormBackupSnapshot["siteId"],
    createdAt,
    submissions: resultRows<PublicFormBackupSubmissionRow>(0),
    classifications: resultRows<PublicFormBackupClassificationRow>(1),
    deliveries: resultRows<PublicFormBackupDeliveryRow>(2),
    outboxEvents: resultRows<PublicFormBackupOutboxRow>(3),
    notificationJobs: resultRows<PublicFormBackupNotificationJobRow>(4),
    acceptanceAuditFacts:
      resultRows<PublicFormBackupAcceptanceAuditRow>(5),
    auditFacts: resultRows<PublicFormBackupOperationAuditRow>(6),
  };
}

function snapshotInsertStatements(
  database: D1DatabaseBinding,
  snapshot: PublicFormBackupSnapshot,
  tables: SnapshotTables,
) {
  const specifications = snapshotTableSpecifications(snapshot, tables);
  const statements = specifications.flatMap(({ table, columns, rows }) =>
    jsonChunks(rows).map((chunk) =>
      database
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")})
           SELECT ${columns
             .map((column) => `json_extract(value, '$.${column}')`)
             .join(", ")}
           FROM json_each(?1)`,
        )
        .bind(chunk),
    ),
  );
  if (statements.length > maximumRestoreInsertStatements) {
    throw new PublicFormPrivacyError("recovery_backup_too_large");
  }
  return statements;
}

const maximumRestoreJsonBytes = 1_500_000;
const maximumRestoreInsertStatements = 15;

function jsonChunks(rows: ReadonlyArray<unknown>) {
  const chunks: string[] = [];
  let current: unknown[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const rowBytes = new TextEncoder().encode(encoded).byteLength;
    if (rowBytes + 2 > maximumRestoreJsonBytes) {
      throw new PublicFormPrivacyError("recovery_backup_too_large");
    }
    if (
      current.length > 0 &&
      currentBytes + rowBytes + 1 > maximumRestoreJsonBytes
    ) {
      chunks.push(JSON.stringify(current));
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes + (current.length === 1 ? 0 : 1);
  }
  if (current.length > 0) chunks.push(JSON.stringify(current));
  return chunks;
}

const snapshotTableDefinitions = [
  {
    key: "submissions",
    columns: [
      "site_id",
      "form_id",
      "submission_id",
      "schema_version",
      "receipt_id",
      "request_hash",
      "fields_json",
      "accepted_at",
      "payload_deleted_at",
    ],
  },
  {
    key: "classifications",
    columns: [
      "id",
      "site_id",
      "form_id",
      "submission_id",
      "classification",
      "classified_at",
    ],
  },
  {
    key: "deliveries",
    columns: [
      "id",
      "site_id",
      "form_id",
      "submission_id",
      "status",
      "created_at",
    ],
  },
  {
    key: "outboxEvents",
    columns: [
      "id",
      "delivery_id",
      "event_type",
      "status",
      "available_at",
      "created_at",
    ],
  },
  {
    key: "notificationJobs",
    columns: [
      "delivery_id",
      "status",
      "attempts",
      "available_at",
      "first_available_at",
      "lease_token",
      "lease_until",
      "last_error_code",
      "provider_reference",
      "delivered_at",
      "updated_at",
    ],
  },
  {
    key: "auditFacts",
    columns: [
      "id",
      "site_id",
      "delivery_id",
      "actor_membership_id",
      "action",
      "outcome_code",
      "occurred_at",
    ],
  },
  {
    key: "acceptanceAuditFacts",
    columns: ["id", "site_id", "event_type", "subject_id", "occurred_at"],
  },
] as const satisfies ReadonlyArray<{
  key: keyof SnapshotTables;
  columns: ReadonlyArray<string>;
}>;

function snapshotTableSpecifications(
  snapshot: PublicFormBackupSnapshot,
  tables: SnapshotTables,
) {
  return snapshotTableDefinitions.map(({ key, columns }) => ({
    table: tables[key],
    columns,
    rows: snapshot[key],
  }));
}

function snapshotPromotionStatements(database: D1DatabaseBinding) {
  return snapshotTableDefinitions.map(({ key, columns }) => {
    return database.prepare(
      `INSERT INTO ${liveSnapshotTables[key]} (${columns.join(", ")})
       SELECT ${columns.join(", ")} FROM ${restoreStageTables[key]}`,
    );
  });
}

function stageSnapshotStatement(
  database: D1DatabaseBinding,
  integrityHash: string,
) {
  return database
    .prepare(
      `UPDATE public_form_restore_stage_control
       SET generation = generation + 1, integrity_hash = ?1
       WHERE id = 1`,
    )
    .bind(integrityHash);
}

function clearRestoreStageStatement(
  database: D1DatabaseBinding,
  integrityHash: string,
) {
  return database
    .prepare(
      `UPDATE public_form_restore_stage_control
       SET generation = generation + 1, integrity_hash = NULL
       WHERE id = 1 AND integrity_hash = ?1`,
    )
    .bind(integrityHash);
}

export function createD1PublicFormPrivacyStore(
  database: D1DatabaseBinding,
): PublicFormPrivacyStore {
  return {
    async exportSubmission({ siteId, receiptId, actorMembershipId, now }) {
      const row = await database
        .prepare(
          `SELECT submission.form_id, submission.receipt_id,
                  submission.accepted_at, submission.fields_json,
                  submission.payload_deleted_at, classification.classification,
                  delivery.id AS delivery_id
           FROM public_form_submissions AS submission
           JOIN public_form_classifications AS classification
             ON classification.site_id = submission.site_id
            AND classification.form_id = submission.form_id
            AND classification.submission_id = submission.submission_id
           JOIN public_form_delivery_intents AS delivery
             ON delivery.site_id = submission.site_id
            AND delivery.form_id = submission.form_id
            AND delivery.submission_id = submission.submission_id
           WHERE submission.site_id = ?1 AND submission.receipt_id = ?2`,
        )
        .bind(siteId, receiptId)
        .first<{
          form_id: string;
          receipt_id: string;
          accepted_at: string;
          fields_json: string;
          payload_deleted_at: string | null;
          classification: "accepted" | "suspected_spam";
          delivery_id: string;
        }>();
      if (row === null || row.payload_deleted_at !== null) return null;
      await database
        .prepare(
          `INSERT INTO public_form_operation_audit_events (
             site_id, delivery_id, actor_membership_id, action, occurred_at
           ) VALUES (?1, ?2, ?3, 'submission_exported', ?4)`,
        )
        .bind(siteId, row.delivery_id, actorMembershipId, now)
        .run();
      return {
        receiptId: createPublicFormReceiptId(row.receipt_id),
        formId: createPublicFormId(row.form_id),
        acceptedAt: row.accepted_at,
        classification: row.classification,
        fields: JSON.parse(row.fields_json) as Record<string, string>,
      };
    },
    async classifySubmission({
      siteId,
      receiptId,
      classification,
      actorMembershipId,
      now,
    }) {
      const results = await database.batch([
        database
          .prepare(
            `UPDATE public_form_classifications
             SET classification = ?1, classified_at = ?2
             WHERE site_id = ?3
               AND classification <> ?1
               AND EXISTS (
                 SELECT 1 FROM public_form_submissions AS submission
                 WHERE submission.site_id = ?3
                   AND submission.receipt_id = ?4
                   AND submission.payload_deleted_at IS NULL
                   AND submission.form_id = public_form_classifications.form_id
                   AND submission.submission_id = public_form_classifications.submission_id
                   AND NOT EXISTS (
                     SELECT 1
                     FROM public_form_delivery_intents AS active_delivery
                     JOIN public_form_notification_jobs AS active_job
                       ON active_job.delivery_id = active_delivery.id
                     WHERE active_delivery.site_id = ?3
                       AND active_delivery.form_id = submission.form_id
                       AND active_delivery.submission_id = submission.submission_id
                       AND active_job.status = 'processing'
                   )
               )`,
          )
          .bind(classification, now, siteId, receiptId),
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action,
               outcome_code, occurred_at
             )
             SELECT ?1, delivery.id, ?2, 'submission_classified', ?3, ?4
             FROM public_form_delivery_intents AS delivery
             JOIN public_form_submissions AS submission
               ON submission.site_id = delivery.site_id
              AND submission.form_id = delivery.form_id
              AND submission.submission_id = delivery.submission_id
             WHERE delivery.site_id = ?1 AND submission.receipt_id = ?5
               AND changes() > 0`,
          )
          .bind(siteId, actorMembershipId, classification, now, receiptId),
        database
          .prepare(
            `UPDATE public_form_notification_jobs
             SET status = CASE WHEN ?1 = 'suspected_spam' THEN 'held' ELSE 'pending' END,
                 attempts = CASE WHEN ?1 = 'accepted' THEN 0 ELSE attempts END,
                 available_at = ?2,
                 first_available_at = CASE
                   WHEN ?1 = 'accepted' THEN ?2
                   ELSE first_available_at
                 END,
                 last_error_code = CASE
                   WHEN ?1 = 'accepted' THEN NULL
                   ELSE last_error_code
                 END,
                 updated_at = ?2
             WHERE delivery_id = (
               SELECT delivery.id
               FROM public_form_delivery_intents AS delivery
               JOIN public_form_submissions AS submission
                 ON submission.site_id = delivery.site_id
                AND submission.form_id = delivery.form_id
                AND submission.submission_id = delivery.submission_id
               WHERE delivery.site_id = ?3 AND submission.receipt_id = ?4
             )
             AND status IN ('pending', 'retry', 'failed', 'held')
             AND changes() > 0`,
          )
          .bind(classification, now, siteId, receiptId),
      ]);
      return (results[0]?.meta.changes ?? 0) > 0;
    },
    async eraseSubmissionPayload({
      siteId,
      receiptId,
      actorMembershipId,
      reason,
      now,
    }) {
      const results = await database.batch([
        database
          .prepare(
            `UPDATE public_form_notification_jobs
             SET status = 'failed', last_error_code = 'payload_erased',
                 lease_token = NULL, lease_until = NULL, updated_at = ?1
             WHERE status IN ('pending', 'retry', 'held', 'failed')
               AND delivery_id = (
                 SELECT delivery.id
                 FROM public_form_delivery_intents AS delivery
                 JOIN public_form_submissions AS submission
                   ON submission.site_id = delivery.site_id
                  AND submission.form_id = delivery.form_id
                  AND submission.submission_id = delivery.submission_id
                 WHERE delivery.site_id = ?2 AND submission.receipt_id = ?3
               )`,
          )
          .bind(now, siteId, receiptId),
        database
          .prepare(
            `UPDATE public_form_submissions
             SET fields_json = '{}', payload_deleted_at = ?1
             WHERE site_id = ?2 AND receipt_id = ?3
               AND payload_deleted_at IS NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM public_form_delivery_intents AS delivery
                 JOIN public_form_notification_jobs AS job
                   ON job.delivery_id = delivery.id
                 WHERE delivery.site_id = ?2
                   AND delivery.form_id = public_form_submissions.form_id
                   AND delivery.submission_id = public_form_submissions.submission_id
                   AND job.status = 'processing'
               )`,
          )
          .bind(now, siteId, receiptId),
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action,
               outcome_code, occurred_at
             )
             SELECT ?1, delivery.id, ?2, 'submission_payload_erased', ?3, ?4
             FROM public_form_delivery_intents AS delivery
             JOIN public_form_submissions AS submission
               ON submission.site_id = delivery.site_id
              AND submission.form_id = delivery.form_id
              AND submission.submission_id = delivery.submission_id
             WHERE delivery.site_id = ?1 AND submission.receipt_id = ?5
               AND submission.payload_deleted_at = ?4
               AND changes() > 0`,
          )
          .bind(siteId, actorMembershipId, reason, now, receiptId),
      ]);
      return (results[1]?.meta.changes ?? 0) > 0;
    },
    async applyRetention({ siteId, now, policy }) {
      const spamCutoff = daysBefore(now, policy.suspectedSpamDays);
      const acceptedCutoff = daysBefore(now, policy.acceptedDays);
      const auditCutoff = daysBefore(now, policy.auditDays);
      const results = await database.batch([
        database
          .prepare(
            `UPDATE public_form_notification_jobs
             SET status = 'failed', last_error_code = 'payload_expired',
                 lease_token = NULL, lease_until = NULL, updated_at = ?1
             WHERE status IN ('pending', 'retry', 'held', 'failed')
               AND delivery_id IN (
                 SELECT delivery.id
                 FROM public_form_delivery_intents AS delivery
                 JOIN public_form_submissions AS submission
                   ON submission.site_id = delivery.site_id
                  AND submission.form_id = delivery.form_id
                  AND submission.submission_id = delivery.submission_id
                 JOIN public_form_classifications AS classification
                   ON classification.site_id = submission.site_id
                  AND classification.form_id = submission.form_id
                  AND classification.submission_id = submission.submission_id
                 WHERE submission.site_id = ?2
                   AND submission.payload_deleted_at IS NULL
                   AND (
                     (classification.classification = 'suspected_spam'
                       AND submission.accepted_at <= ?3)
                     OR (classification.classification = 'accepted'
                       AND submission.accepted_at <= ?4)
                   )
               )`,
          )
          .bind(now, siteId, spamCutoff, acceptedCutoff),
        database
          .prepare(
            `UPDATE public_form_submissions
             SET fields_json = '{}', payload_deleted_at = ?1
             WHERE site_id = ?2 AND payload_deleted_at IS NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM public_form_delivery_intents AS active_delivery
                 JOIN public_form_notification_jobs AS active_job
                   ON active_job.delivery_id = active_delivery.id
                 WHERE active_delivery.site_id = ?2
                   AND active_delivery.form_id = public_form_submissions.form_id
                   AND active_delivery.submission_id = public_form_submissions.submission_id
                   AND active_job.status = 'processing'
               )
               AND EXISTS (
                 SELECT 1 FROM public_form_classifications AS classification
                 WHERE classification.site_id = public_form_submissions.site_id
                   AND classification.form_id = public_form_submissions.form_id
                   AND classification.submission_id = public_form_submissions.submission_id
                   AND (
                     (classification.classification = 'suspected_spam'
                       AND public_form_submissions.accepted_at <= ?3)
                     OR (classification.classification = 'accepted'
                       AND public_form_submissions.accepted_at <= ?4)
                   )
               )`,
          )
          .bind(now, siteId, spamCutoff, acceptedCutoff),
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action,
               outcome_code, occurred_at
             )
             SELECT submission.site_id, delivery.id, NULL,
                    'submission_retention_expired',
                    classification.classification, ?1
             FROM public_form_submissions AS submission
             JOIN public_form_classifications AS classification
               ON classification.site_id = submission.site_id
              AND classification.form_id = submission.form_id
              AND classification.submission_id = submission.submission_id
             JOIN public_form_delivery_intents AS delivery
               ON delivery.site_id = submission.site_id
              AND delivery.form_id = submission.form_id
              AND delivery.submission_id = submission.submission_id
             WHERE submission.site_id = ?2
               AND submission.payload_deleted_at = ?1
               AND changes() > 0`,
          )
          .bind(now, siteId),
        database
          .prepare(
            `DELETE FROM public_form_operation_audit_events
             WHERE site_id = ?1 AND occurred_at < ?2`,
          )
          .bind(siteId, auditCutoff),
        database
          .prepare(
            `DELETE FROM public_form_audit_events
             WHERE site_id = ?1 AND occurred_at < ?2`,
          )
          .bind(siteId, auditCutoff),
        database
          .prepare(
            `DELETE FROM public_form_restore_verifications
             WHERE site_id = ?1 AND verified_at < ?2`,
          )
          .bind(siteId, auditCutoff),
        database
          .prepare(
            `DELETE FROM public_form_backup_records
             WHERE site_id = ?1 AND created_at < ?2`,
          )
          .bind(siteId, auditCutoff),
      ]);
      return {
        erasedPayloads: results[1]?.meta.changes ?? 0,
        expiredAuditFacts:
          (results[3]?.meta.changes ?? 0) +
          (results[4]?.meta.changes ?? 0) +
          (results[5]?.meta.changes ?? 0) +
          (results[6]?.meta.changes ?? 0),
      };
    },
    async latestRetentionAt({ siteId }) {
      const row = await database
        .prepare(
          `SELECT retention_applied_at
           FROM public_form_maintenance_state WHERE site_id = ?1`,
        )
        .bind(siteId)
        .first<{ retention_applied_at: string }>();
      return row?.retention_applied_at ?? null;
    },
    async recordRetention({ siteId, appliedAt }) {
      await database
        .prepare(
          `INSERT INTO public_form_maintenance_state (
             site_id, retention_applied_at
           ) VALUES (?1, ?2)
           ON CONFLICT (site_id) DO UPDATE
           SET retention_applied_at = excluded.retention_applied_at`,
        )
        .bind(siteId, appliedAt)
        .run();
    },
    async createBackupSnapshot({ siteId, now }) {
      return snapshotRows(database, siteId, now);
    },
    async latestBackupAt({ siteId }) {
      const row = await database
        .prepare(
          `SELECT MAX(created_at) AS created_at
           FROM public_form_backup_records WHERE site_id = ?1`,
        )
        .bind(siteId)
        .first<{ created_at: string | null }>();
      return row?.created_at ?? null;
    },
    async recordBackup(input) {
      await database
        .prepare(
          `INSERT INTO public_form_backup_records (
             backup_id, site_id, object_key, integrity_hash,
             created_at, expires_at, retention_days
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          input.backupId,
          input.siteId,
          input.objectKey,
          input.integrityHash,
          input.createdAt,
          input.expiresAt,
          input.retentionDays,
        )
        .run();
    },
    async restoreBackupSnapshot({ snapshot, verification }) {
      const expectedHash = await sha256(JSON.stringify(snapshot));
      const expectedEvidence = {
        submissions: snapshot.submissions.length,
        auditFacts:
          snapshot.acceptanceAuditFacts.length + snapshot.auditFacts.length,
        integrityHash: expectedHash,
        actorMembershipId: verification.actorMembershipId,
        verifiedAt: verification.verifiedAt,
      };
      const reconcileCommittedRestore = async () => {
        const priorVerification = await database
          .prepare(
            `SELECT actor_membership_id, verified_at
             FROM public_form_restore_verifications
             WHERE site_id = ?1 AND backup_id = ?2 AND target = 'isolated'
               AND submission_count = ?3 AND audit_fact_count = ?4
               AND integrity_hash = ?5
             LIMIT 1`,
          )
          .bind(
            snapshot.siteId,
            verification.backupId,
            expectedEvidence.submissions,
            expectedEvidence.auditFacts,
            expectedHash,
          )
          .first<{
            actor_membership_id: string;
            verified_at: string;
          }>();
        if (priorVerification === null) return null;
        const restored = await snapshotRows(
          database,
          snapshot.siteId,
          snapshot.createdAt,
        );
        if (await sha256(JSON.stringify(restored)) !== expectedHash) {
          return null;
        }
        return {
          ...expectedEvidence,
          actorMembershipId: priorVerification.actor_membership_id,
          verifiedAt: priorVerification.verified_at,
        };
      };
      try {
      const [targetCount] = await database.batch([
        database.prepare(
          `SELECT (${restoreTargetEmptySql}) AS count`,
        ),
      ]);
      if (targetCount === undefined) {
        throw new PublicFormPrivacyError("recovery_target_check_failed");
      }
      if (readCountResult(targetCount) !== 0) {
        const committed = await reconcileCommittedRestore();
        if (committed === null) {
          throw new PublicFormPrivacyError("recovery_target_not_empty");
        }
        return committed;
      }
      await database.batch([
        stageSnapshotStatement(database, expectedHash),
        ...snapshotInsertStatements(database, snapshot, restoreStageTables),
      ]);
      const staged = await snapshotRows(
        database,
        snapshot.siteId,
        snapshot.createdAt,
        restoreStageTables,
      );
      const integrityHash = await sha256(JSON.stringify(staged));
      if (integrityHash !== expectedHash) {
        await database.batch([
          clearRestoreStageStatement(database, expectedHash),
        ]);
        throw new PublicFormPrivacyError("recovery_integrity_mismatch");
      }
      try {
        await database.batch([
          database
            .prepare(
              `INSERT INTO public_form_restore_promotion_guard (id, state)
               VALUES (
                 1,
                 CASE WHEN (${restoreTargetEmptySql}) = 0
                   AND (
                     SELECT integrity_hash
                     FROM public_form_restore_stage_control
                     WHERE id = 1
                   ) = ?1
                   THEN 'empty' ELSE 'occupied' END
               )`,
            )
            .bind(expectedHash),
          ...snapshotPromotionStatements(database),
          database
            .prepare(
              `INSERT INTO public_form_restore_verifications (
                 site_id, backup_id, actor_membership_id, target,
                 submission_count, audit_fact_count, integrity_hash, verified_at
               ) VALUES (?1, ?2, ?3, 'isolated', ?4, ?5, ?6, ?7)`,
            )
            .bind(
              snapshot.siteId,
              verification.backupId,
              verification.actorMembershipId,
              expectedEvidence.submissions,
              expectedEvidence.auditFacts,
              expectedHash,
              verification.verifiedAt,
            ),
          database.prepare(
            "DELETE FROM public_form_restore_promotion_guard WHERE id = 1",
          ),
          clearRestoreStageStatement(database, expectedHash),
        ]);
      } catch (error) {
        const [count] = await database.batch([
          database.prepare(
            `SELECT (${restoreTargetEmptySql}) AS count`,
          ),
        ]);
        if (count === undefined) {
          throw new PublicFormPrivacyError("recovery_target_check_failed");
        }
        if (readCountResult(count) !== 0) {
          const committed = await reconcileCommittedRestore();
          if (committed !== null) return committed;
          throw new PublicFormPrivacyError("recovery_target_not_empty");
        }
        throw new PublicFormPrivacyError("recovery_target_check_failed");
      }
      return expectedEvidence;
      } catch (error) {
        if (error instanceof PublicFormPrivacyError) throw error;
        throw new PublicFormPrivacyError("recovery_target_check_failed");
      }
    },
    async recordRestoreVerification(input) {
      await database
        .prepare(
          `INSERT INTO public_form_restore_verifications (
             site_id, backup_id, actor_membership_id, target,
             submission_count, audit_fact_count, integrity_hash, verified_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
           WHERE NOT EXISTS (
             SELECT 1 FROM public_form_restore_verifications
             WHERE site_id = ?1 AND backup_id = ?2 AND target = ?4
               AND integrity_hash = ?7
           )`,
        )
        .bind(
          input.siteId,
          input.backupId,
          input.evidence.actorMembershipId,
          input.target,
          input.evidence.submissions,
          input.evidence.auditFacts,
          input.evidence.integrityHash,
          input.evidence.verifiedAt,
        )
        .run();
    },
    async clearRestoredSnapshot({ siteId, backupId, evidence }) {
      try {
        const [targetCount] = await database.batch([
          database.prepare(
            `SELECT (${restoreTargetEmptySql}) AS count`,
          ),
        ]);
        if (targetCount === undefined) {
          throw new PublicFormPrivacyError("recovery_target_check_failed");
        }
        if (readCountResult(targetCount) === 0) return;
        const verification = await database
          .prepare(
            `SELECT 1 AS verified
             FROM public_form_restore_verifications
             WHERE site_id = ?1 AND backup_id = ?2 AND target = 'isolated'
               AND submission_count = ?3 AND audit_fact_count = ?4
               AND integrity_hash = ?5
               AND actor_membership_id = ?6 AND verified_at = ?7
             LIMIT 1`,
          )
          .bind(
            siteId,
            backupId,
            evidence.submissions,
            evidence.auditFacts,
            evidence.integrityHash,
            evidence.actorMembershipId,
            evidence.verifiedAt,
          )
          .first<{ verified: number }>();
        if (verification === null) {
          throw new PublicFormPrivacyError("recovery_target_check_failed");
        }
        await database.batch([
          database
            .prepare(
              `INSERT INTO public_form_recovery_cleanup_guard (id)
               SELECT 1
               WHERE EXISTS (
                 SELECT 1 FROM public_form_restore_verifications
                 WHERE site_id = ?1 AND backup_id = ?2
                   AND target = 'isolated'
                   AND submission_count = ?3 AND audit_fact_count = ?4
                   AND integrity_hash = ?5
                   AND actor_membership_id = ?6 AND verified_at = ?7
               )`,
            )
            .bind(
              siteId,
              backupId,
              evidence.submissions,
              evidence.auditFacts,
              evidence.integrityHash,
              evidence.actorMembershipId,
              evidence.verifiedAt,
            ),
          database.prepare("DELETE FROM public_form_notification_jobs"),
          database.prepare("DELETE FROM public_form_outbox_events"),
          database.prepare("DELETE FROM public_form_classifications"),
          database.prepare("DELETE FROM public_form_delivery_intents"),
          database.prepare("DELETE FROM public_form_submissions"),
          database.prepare("DELETE FROM public_form_operation_audit_events"),
          database.prepare("DELETE FROM public_form_audit_events"),
          database.prepare("DELETE FROM public_form_restore_verifications"),
          database.prepare(
            "DELETE FROM public_form_recovery_cleanup_guard WHERE id = 1",
          ),
        ]);
      } catch (error) {
        if (error instanceof PublicFormPrivacyError) throw error;
        throw new PublicFormPrivacyError("recovery_target_check_failed");
      }
    },
  };
}

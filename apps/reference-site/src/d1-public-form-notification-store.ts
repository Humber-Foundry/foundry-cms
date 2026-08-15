import {
  createPublicFormDeliveryId,
  createPublicFormId,
  createPublicFormReceiptId,
  summarizePublicFormSubmission,
  type PublicFormInboxMessage,
  type PublicFormInboxPlan,
  type PublicFormNotificationStore,
} from "@humber-foundry/application";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type ClaimRow = {
  delivery_id: string;
  form_id: string;
  receipt_id: string;
  accepted_at: string;
  fields_json: string;
  lease_token: string;
  attempts: number;
  first_available_at: string;
};

function previewFields(
  fieldsJson: string,
  allowedFieldIds: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const value: unknown = JSON.parse(fieldsJson);
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        allowedFieldIds.has(entry[0]) && typeof entry[1] === "string",
    ),
  );
}

function capacityState(usedPercent: number) {
  if (usedPercent >= 90) return "critical" as const;
  if (usedPercent >= 70) return "warning" as const;
  return "normal" as const;
}

type InboxRow = {
  form_id: string;
  receipt_id: string;
  accepted_at: string;
  fields_json: string;
  payload_deleted_at: string | null;
  first_read_at: string | null;
};

/**
 * Every inbox read walks the same three tables: the submission, the
 * classification that says it was accepted, and the read row that may or may
 * not exist yet. Keeping the walk in one place stops the page query and the
 * unread count from drifting apart.
 *
 * A query built here binds the site id as `?1`. Anything a caller adds in
 * `extraConditions` therefore starts at `?2`.
 */
function acceptedInboxQuery(columns: string, extraConditions = "") {
  return `SELECT ${columns}
     FROM public_form_submissions AS submission
     JOIN public_form_classifications AS classification
       ON classification.site_id = submission.site_id
      AND classification.form_id = submission.form_id
      AND classification.submission_id = submission.submission_id
     LEFT JOIN public_form_submission_reads AS read_state
       ON read_state.site_id = submission.site_id
      AND read_state.form_id = submission.form_id
      AND read_state.submission_id = submission.submission_id
     WHERE submission.site_id = ?1
       AND classification.classification = 'accepted'
       ${extraConditions}`;
}

const unreadInboxCount = acceptedInboxQuery(
  "COUNT(*) AS unread",
  "AND read_state.first_read_at IS NULL",
);

export type D1PublicFormNotificationStoreOptions = Readonly<{
  capacityLimitBytes?: number;
  notificationPreviewFieldIds?: ReadonlyArray<string>;
  inboxPlan?: PublicFormInboxPlan;
}>;

function parseFields(fieldsJson: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(fieldsJson);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createD1PublicFormNotificationStore(
  database: D1DatabaseBinding,
  options: D1PublicFormNotificationStoreOptions = {},
): PublicFormNotificationStore {
  const capacityLimitBytes =
    options.capacityLimitBytes ?? 500 * 1_024 * 1_024;
  const inboxPlan: PublicFormInboxPlan = options.inboxPlan ?? {};
  const allowedPreviewFieldIds = new Set(
    options.notificationPreviewFieldIds ?? [],
  );

  function inboxMessage(row: InboxRow): PublicFormInboxMessage {
    const formId = createPublicFormId(row.form_id);
    return {
      formId,
      receiptId: createPublicFormReceiptId(row.receipt_id),
      acceptedAt: row.accepted_at,
      read: row.first_read_at !== null,
      payloadDeleted: row.payload_deleted_at !== null,
      ...summarizePublicFormSubmission({
        plan: inboxPlan,
        formId,
        fields: parseFields(row.fields_json),
      }),
    };
  }

  return {
    async claimDue({ siteId, now, leaseToken, leaseUntil, limit }) {
      await database.batch([
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action,
               outcome_code, occurred_at
             )
             SELECT ?1, job.delivery_id, NULL, 'delivery_failed',
                    'claim_outcome_unknown', ?2
             FROM public_form_notification_jobs AS job
             JOIN public_form_delivery_intents AS delivery
               ON delivery.id = job.delivery_id
             WHERE delivery.site_id = ?1
               AND job.status = 'processing'
               AND job.lease_until <= ?2`,
          )
          .bind(siteId, now),
        database
          .prepare(
            `UPDATE public_form_notification_jobs
             SET
               status = 'failed',
               lease_token = NULL,
               lease_until = NULL,
               last_error_code = 'claim_outcome_unknown',
               updated_at = ?1
             WHERE status = 'processing'
               AND lease_until <= ?1
               AND EXISTS (
                 SELECT 1 FROM public_form_delivery_intents AS delivery
                 WHERE delivery.id = public_form_notification_jobs.delivery_id
                   AND delivery.site_id = ?2
               )`,
          )
          .bind(now, siteId),
      ]);
      await database
        .prepare(
          `UPDATE public_form_notification_jobs
           SET
             status = 'processing',
             attempts = attempts + 1,
             lease_token = ?1,
             lease_until = ?2,
             updated_at = ?3
           WHERE delivery_id IN (
             SELECT job.delivery_id
             FROM public_form_notification_jobs AS job
             JOIN public_form_delivery_intents AS delivery
               ON delivery.id = job.delivery_id
             WHERE delivery.site_id = ?4
               AND (
                 (job.status IN ('pending', 'retry') AND job.available_at <= ?3)
               )
             ORDER BY job.available_at, job.delivery_id
             LIMIT ?5
           )
           AND (
             (status IN ('pending', 'retry') AND available_at <= ?3)
           )`,
        )
        .bind(leaseToken, leaseUntil, now, siteId, limit)
        .run();
      const rows = await database
        .prepare(
          `SELECT
             delivery.id AS delivery_id,
             delivery.form_id,
             submission.receipt_id,
             submission.accepted_at,
             submission.fields_json,
             job.lease_token,
             job.attempts,
             job.first_available_at
           FROM public_form_notification_jobs AS job
           JOIN public_form_delivery_intents AS delivery
             ON delivery.id = job.delivery_id
           JOIN public_form_submissions AS submission
             ON submission.site_id = delivery.site_id
            AND submission.form_id = delivery.form_id
            AND submission.submission_id = delivery.submission_id
           WHERE delivery.site_id = ?1
             AND job.status = 'processing'
             AND job.lease_token = ?2
           ORDER BY job.available_at, job.delivery_id`,
        )
        .bind(siteId, leaseToken)
        .all<ClaimRow>();
      return rows.results.map((row) => ({
        deliveryId: createPublicFormDeliveryId(row.delivery_id),
        formId: createPublicFormId(row.form_id),
        receiptId: createPublicFormReceiptId(row.receipt_id),
        acceptedAt: row.accepted_at,
        previewFields: previewFields(
          row.fields_json,
          allowedPreviewFieldIds,
        ),
        dashboardPath: `/dash/forms/${encodeURIComponent(row.receipt_id)}`,
        leaseToken: row.lease_token,
        attempt: row.attempts,
        firstAvailableAt: row.first_available_at,
      }));
    },
    async recordOutcome({
      siteId,
      deliveryId,
      leaseToken,
      outcome,
      now,
      nextAttemptAt,
    }) {
      const status =
        outcome.outcome === "sent"
          ? "delivered"
          : outcome.outcome === "retry"
            ? "retry"
            : "failed";
      const result = await database.batch([
        database
          .prepare(
            `UPDATE public_form_notification_jobs
             SET
               status = ?1,
               available_at = COALESCE(?2, available_at),
               lease_token = NULL,
               lease_until = NULL,
               last_error_code = ?3,
               provider_reference = ?4,
               delivered_at = CASE WHEN ?1 = 'delivered' THEN ?5 ELSE NULL END,
               updated_at = ?5
             WHERE delivery_id = ?6
               AND lease_token = ?7
               AND status = 'processing'
               AND EXISTS (
                 SELECT 1 FROM public_form_delivery_intents AS delivery
                 WHERE delivery.id = ?6 AND delivery.site_id = ?8
               )`,
          )
          .bind(
            status,
            nextAttemptAt,
            outcome.outcome === "sent" ? null : outcome.code,
            outcome.outcome === "sent"
              ? (outcome.providerReference ?? null)
              : null,
            now,
            deliveryId,
            leaseToken,
            siteId,
          ),
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action,
               outcome_code, occurred_at
             )
             SELECT ?1, ?2, NULL, ?3, ?4, ?5
             WHERE changes() > 0`,
          )
          .bind(
            siteId,
            deliveryId,
            outcome.outcome === "sent"
              ? "delivery_sent"
              : outcome.outcome === "retry"
                ? "delivery_retry_scheduled"
                : "delivery_failed",
            outcome.outcome === "sent" ? null : outcome.code,
            now,
          ),
      ]);
      return (result[0]?.meta.changes ?? 0) > 0;
    },
    async deliveryHealth({ siteId, now }) {
      const row = await database
        .prepare(
          `SELECT
             SUM(CASE WHEN job.status IN ('pending', 'retry') THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN job.status = 'processing' THEN 1 ELSE 0 END) AS processing,
             SUM(CASE
               WHEN job.status = 'failed'
                AND COALESCE(job.last_error_code, '') NOT IN ('payload_erased', 'payload_expired')
               THEN 1 ELSE 0
             END) AS failed,
             SUM(CASE
               WHEN job.attempts > 1
                AND COALESCE(job.last_error_code, '') NOT IN ('payload_erased', 'payload_expired')
               THEN job.attempts - 1 ELSE 0
             END) AS retries,
             MIN(CASE
               WHEN job.status IN ('pending', 'retry') THEN job.first_available_at
               ELSE NULL
             END) AS oldest,
             (
               SELECT COALESCE(
                 SUM(length(CAST(submission.fields_json AS BLOB)) + 1024),
                 0
               )
               FROM public_form_submissions AS submission
               WHERE submission.site_id = ?1
             ) AS used_bytes
           FROM public_form_notification_jobs AS job
           JOIN public_form_delivery_intents AS delivery
             ON delivery.id = job.delivery_id
           WHERE delivery.site_id = ?1`,
        )
        .bind(siteId)
        .first<{
          pending: number | null;
          processing: number | null;
          failed: number | null;
          retries: number | null;
          oldest: string | null;
          used_bytes: number;
        }>();
      const usedPercent = Math.min(
        100,
        ((row?.used_bytes ?? 0) * 100) / capacityLimitBytes,
      );
      return {
        pending: row?.pending ?? 0,
        processing: row?.processing ?? 0,
        failed: row?.failed ?? 0,
        retries: row?.retries ?? 0,
        oldestPendingAgeSeconds:
          row?.oldest === null || row?.oldest === undefined
            ? null
            : Math.max(
                0,
                Math.floor((Date.parse(now) - Date.parse(row.oldest)) / 1_000),
              ),
        capacity: { usedPercent, state: capacityState(usedPercent) },
      };
    },
    async replayFailed({ siteId, deliveryId, actorMembershipId, now }) {
      const results = await database.batch([
        database
          .prepare(
            `UPDATE public_form_notification_jobs
             SET
               status = 'pending',
               attempts = 0,
               available_at = ?1,
               first_available_at = ?1,
               lease_token = NULL,
               lease_until = NULL,
               last_error_code = NULL,
               updated_at = ?1
             WHERE delivery_id = ?2
               AND status = 'failed'
               AND last_error_code NOT IN ('payload_erased', 'payload_expired')
               AND EXISTS (
                 SELECT 1
                 FROM public_form_delivery_intents AS delivery
                 JOIN public_form_classifications AS classification
                   ON classification.site_id = delivery.site_id
                  AND classification.form_id = delivery.form_id
                  AND classification.submission_id = delivery.submission_id
                 WHERE delivery.id = ?2
                   AND delivery.site_id = ?3
                   AND classification.classification = 'accepted'
               )`,
          )
          .bind(now, deliveryId, siteId),
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action, occurred_at
             )
             SELECT ?1, ?2, ?3, 'delivery_replayed', ?4
             WHERE changes() > 0`,
          )
          .bind(siteId, deliveryId, actorMembershipId, now),
      ]);
      return (results[0]?.meta.changes ?? 0) > 0;
    },
    async listInbox({ siteId, limit, olderThanReceiptId }) {
      const cursor =
        olderThanReceiptId === null
          ? null
          : await database
              .prepare(
                `SELECT accepted_at, submission_id
                 FROM public_form_submissions
                 WHERE site_id = ?1 AND receipt_id = ?2`,
              )
              .bind(siteId, olderThanReceiptId)
              .first<{ accepted_at: string; submission_id: string }>();
      const [rows, unread] = await Promise.all([
        database
          .prepare(
            acceptedInboxQuery(
              `submission.form_id,
               submission.receipt_id,
               submission.accepted_at,
               submission.fields_json,
               submission.payload_deleted_at,
               read_state.first_read_at`,
              `AND (
                 ?2 IS NULL
                 OR submission.accepted_at < ?2
                 OR (
                   submission.accepted_at = ?2
                   AND submission.submission_id < ?3
                 )
               )
               ORDER BY submission.accepted_at DESC,
                        submission.submission_id DESC
               LIMIT ?4`,
            ),
          )
          .bind(
            siteId,
            cursor?.accepted_at ?? null,
            cursor?.submission_id ?? null,
            limit + 1,
          )
          .all<InboxRow>(),
        database
          .prepare(unreadInboxCount)
          .bind(siteId)
          .first<{ unread: number }>(),
      ]);
      const messages = rows.results.slice(0, limit).map(inboxMessage);
      const lastMessage = messages.at(-1);
      return {
        messages,
        olderCursor:
          rows.results.length > limit && lastMessage !== undefined
            ? lastMessage.receiptId
            : null,
        unreadCount: unread?.unread ?? 0,
      };
    },
    async countUnreadInbox({ siteId }) {
      const row = await database
        .prepare(unreadInboxCount)
        .bind(siteId)
        .first<{ unread: number }>();
      return row?.unread ?? 0;
    },
    async listSuspectedSpam({ siteId }) {
      const rows = await database
        .prepare(
          `SELECT submission.form_id, submission.receipt_id, submission.accepted_at
           FROM public_form_submissions AS submission
           JOIN public_form_classifications AS classification
             ON classification.site_id = submission.site_id
            AND classification.form_id = submission.form_id
            AND classification.submission_id = submission.submission_id
           WHERE submission.site_id = ?1
             AND classification.classification = 'suspected_spam'
             AND submission.payload_deleted_at IS NULL
           ORDER BY submission.accepted_at, submission.receipt_id`,
        )
        .bind(siteId)
        .all<{ form_id: string; receipt_id: string; accepted_at: string }>();
      return rows.results.map((row) => ({
        formId: createPublicFormId(row.form_id),
        receiptId: createPublicFormReceiptId(row.receipt_id),
        acceptedAt: row.accepted_at,
      }));
    },
    async listFailed({ siteId }) {
      const rows = await database
        .prepare(
          `SELECT
             delivery.id AS delivery_id,
             delivery.form_id,
             submission.receipt_id,
             job.attempts,
             job.last_error_code,
             job.updated_at
           FROM public_form_notification_jobs AS job
           JOIN public_form_delivery_intents AS delivery
             ON delivery.id = job.delivery_id
           JOIN public_form_submissions AS submission
             ON submission.site_id = delivery.site_id
            AND submission.form_id = delivery.form_id
            AND submission.submission_id = delivery.submission_id
           WHERE delivery.site_id = ?1
             AND job.status = 'failed'
             AND job.last_error_code NOT IN ('payload_erased', 'payload_expired')
           ORDER BY job.updated_at, delivery.id`,
        )
        .bind(siteId)
        .all<{
          delivery_id: string;
          form_id: string;
          receipt_id: string;
          attempts: number;
          last_error_code: string;
          updated_at: string;
        }>();
      return rows.results.map((row) => ({
        deliveryId: createPublicFormDeliveryId(row.delivery_id),
        formId: createPublicFormId(row.form_id),
        receiptId: createPublicFormReceiptId(row.receipt_id),
        attempts: row.attempts,
        errorCode: row.last_error_code,
        updatedAt: row.updated_at,
      }));
    },
    async viewSubmission({
      siteId,
      receiptId,
      actorMembershipId,
      now,
    }) {
      const row = await database
        .prepare(
          `SELECT
             submission.form_id,
             submission.receipt_id,
             submission.accepted_at,
             submission.fields_json,
             submission.payload_deleted_at,
             classification.classification
           FROM public_form_submissions AS submission
           JOIN public_form_classifications AS classification
             ON classification.site_id = submission.site_id
            AND classification.form_id = submission.form_id
            AND classification.submission_id = submission.submission_id
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
        }>();
      if (row === null) {
        return null;
      }
      await database.batch([
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action, occurred_at
             )
             SELECT ?1, delivery.id, ?2, 'submission_viewed', ?3
             FROM public_form_delivery_intents AS delivery
             JOIN public_form_submissions AS submission
               ON submission.site_id = delivery.site_id
              AND submission.form_id = delivery.form_id
              AND submission.submission_id = delivery.submission_id
             WHERE delivery.site_id = ?1 AND submission.receipt_id = ?4`,
          )
          .bind(siteId, actorMembershipId, now, receiptId),
        // Opening a message marks it read for the whole site. The first
        // reader stays on the record; a later reader never replaces them.
        database
          .prepare(
            `INSERT OR IGNORE INTO public_form_submission_reads (
               site_id, form_id, submission_id, first_read_at, first_read_by
             )
             SELECT site_id, form_id, submission_id, ?2, ?3
             FROM public_form_submissions
             WHERE site_id = ?1 AND receipt_id = ?4`,
          )
          .bind(siteId, now, actorMembershipId, receiptId),
      ]);
      return {
        formId: createPublicFormId(row.form_id),
        receiptId: createPublicFormReceiptId(row.receipt_id),
        acceptedAt: row.accepted_at,
        classification: row.classification,
        fields: JSON.parse(row.fields_json) as Record<string, string>,
        payloadDeleted: row.payload_deleted_at !== null,
      };
    },
    async releaseSuspectedSpam({ siteId, receiptId, actorMembershipId, now }) {
      const results = await database.batch([
        database
          .prepare(
            `UPDATE public_form_classifications
             SET classification = 'accepted', classified_at = ?1
             WHERE site_id = ?2
               AND classification = 'suspected_spam'
               AND EXISTS (
                 SELECT 1
                 FROM public_form_submissions AS submission
                 JOIN public_form_delivery_intents AS delivery
                   ON delivery.site_id = submission.site_id
                  AND delivery.form_id = submission.form_id
                  AND delivery.submission_id = submission.submission_id
                 JOIN public_form_notification_jobs AS job
                   ON job.delivery_id = delivery.id
                 WHERE submission.site_id = ?2
                   AND submission.receipt_id = ?3
                   AND submission.payload_deleted_at IS NULL
                   AND job.status = 'held'
                   AND submission.form_id = public_form_classifications.form_id
                   AND submission.submission_id = public_form_classifications.submission_id
               )`,
          )
          .bind(now, siteId, receiptId),
        database
          .prepare(
            `UPDATE public_form_notification_jobs
             SET status = 'pending', available_at = ?1,
                 first_available_at = ?1, updated_at = ?1
             WHERE status = 'held'
               AND delivery_id = (
                 SELECT delivery.id
                 FROM public_form_delivery_intents AS delivery
                 JOIN public_form_submissions AS submission
                   ON submission.site_id = delivery.site_id
                  AND submission.form_id = delivery.form_id
                  AND submission.submission_id = delivery.submission_id
                 WHERE delivery.site_id = ?2 AND submission.receipt_id = ?3
               )
               AND changes() > 0`,
          )
          .bind(now, siteId, receiptId),
        database
          .prepare(
            `INSERT INTO public_form_operation_audit_events (
               site_id, delivery_id, actor_membership_id, action, occurred_at
             )
             SELECT ?1, delivery.id, ?2, 'spam_released', ?3
             FROM public_form_delivery_intents AS delivery
             JOIN public_form_submissions AS submission
               ON submission.site_id = delivery.site_id
              AND submission.form_id = delivery.form_id
              AND submission.submission_id = delivery.submission_id
             WHERE delivery.site_id = ?1
               AND submission.receipt_id = ?4
               AND changes() > 0`,
          )
          .bind(siteId, actorMembershipId, now, receiptId),
      ]);
      return (results[1]?.meta.changes ?? 0) > 0;
    },
  };
}

import "server-only";

import type {
  PublicFormAcceptance,
  PublicFormAcceptanceStore,
} from "@foundry/application";
import { createPublicFormReceiptId } from "@foundry/application";

import type { D1DatabaseBinding } from "./d1-human-access-store";

type ReceiptRow = {
  receipt_id: string;
  request_hash: string;
};

export function createD1PublicFormAcceptanceStore(
  database: D1DatabaseBinding,
): PublicFormAcceptanceStore & {
  findReceipt: NonNullable<PublicFormAcceptanceStore["findReceipt"]>;
} {
  async function findReceipt({
    identity,
    requestHash,
  }: Parameters<
    NonNullable<PublicFormAcceptanceStore["findReceipt"]>
  >[0]) {
    const row = await database
      .prepare(
        `SELECT receipt_id, request_hash
         FROM public_form_submissions
         WHERE site_id = ?1 AND form_id = ?2 AND submission_id = ?3`,
      )
      .bind(
        identity.siteId,
        identity.formId,
        identity.submissionId,
      )
      .first<ReceiptRow>();
    if (row === null) {
      return null;
    }
    if (row.request_hash !== requestHash) {
      return { outcome: "conflict" as const };
    }
    return {
      outcome: "replayed" as const,
      receiptId: createPublicFormReceiptId(row.receipt_id),
    };
  }

  return {
    findReceipt,
    async accept(acceptance: PublicFormAcceptance) {
      const statements = [
        database
          .prepare(
            `INSERT INTO public_form_submissions (
               site_id, form_id, submission_id, schema_version, receipt_id,
               request_hash, fields_json, accepted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (site_id, form_id, submission_id) DO NOTHING`,
          )
          .bind(
            acceptance.identity.siteId,
            acceptance.identity.formId,
            acceptance.identity.submissionId,
            acceptance.schemaVersion,
            acceptance.receiptId,
            acceptance.requestHash,
            JSON.stringify(acceptance.fields),
            acceptance.acceptedAt,
          ),
        database
          .prepare(
            `INSERT INTO public_form_classifications (
               id, site_id, form_id, submission_id, classification,
               classified_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (site_id, form_id, submission_id) DO NOTHING`,
          )
          .bind(
            acceptance.classificationId,
            acceptance.identity.siteId,
            acceptance.identity.formId,
            acceptance.identity.submissionId,
            acceptance.classification,
            acceptance.acceptedAt,
          ),
        database
          .prepare(
            `INSERT INTO public_form_audit_events (
               id, site_id, event_type, subject_id, occurred_at
             ) VALUES (?1, ?2, 'submission_accepted', ?3, ?4)
             ON CONFLICT (site_id, event_type, subject_id) DO NOTHING`,
          )
          .bind(
            acceptance.auditEventId,
            acceptance.identity.siteId,
            `${acceptance.identity.formId}:${acceptance.identity.submissionId}`,
            acceptance.acceptedAt,
          ),
        database
          .prepare(
            `INSERT INTO public_form_delivery_intents (
               id, site_id, form_id, submission_id, status, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (site_id, form_id, submission_id) DO NOTHING`,
          )
          .bind(
            acceptance.deliveryId,
            acceptance.identity.siteId,
            acceptance.identity.formId,
            acceptance.identity.submissionId,
            acceptance.deliveryStatus,
            acceptance.acceptedAt,
          ),
        database
          .prepare(
            `INSERT INTO public_form_outbox_events (
               id, delivery_id, event_type, status, available_at, created_at
             )
             SELECT ?1, delivery.id, ?2, ?3, ?4, ?4
             FROM public_form_delivery_intents AS delivery
             WHERE delivery.site_id = ?5
               AND delivery.form_id = ?6
               AND delivery.submission_id = ?7
             ON CONFLICT (delivery_id) DO NOTHING`,
          )
          .bind(
            acceptance.outboxEventId,
            acceptance.deliveryStatus === "pending"
              ? "deliver_submission"
              : "hold_for_spam_review",
            acceptance.deliveryStatus,
            acceptance.acceptedAt,
            acceptance.identity.siteId,
            acceptance.identity.formId,
            acceptance.identity.submissionId,
          ),
        database
          .prepare(
            `INSERT INTO public_form_notification_jobs (
               delivery_id, status, available_at, first_available_at, updated_at
             )
             SELECT delivery.id, ?1, ?2, ?2, ?2
             FROM public_form_delivery_intents AS delivery
             WHERE delivery.site_id = ?3
               AND delivery.form_id = ?4
               AND delivery.submission_id = ?5
             ON CONFLICT (delivery_id) DO NOTHING`,
          )
          .bind(
            acceptance.deliveryStatus,
            acceptance.acceptedAt,
            acceptance.identity.siteId,
            acceptance.identity.formId,
            acceptance.identity.submissionId,
          ),
      ];
      const results = await database.batch(statements);
      if ((results[0]?.meta.changes ?? 0) > 0) {
        return {
          outcome: "accepted" as const,
          receiptId: acceptance.receiptId,
        };
      }
      return (
        (await findReceipt({
          identity: acceptance.identity,
          requestHash: acceptance.requestHash,
        })) ?? { outcome: "conflict" as const }
      );
    },
  };
}

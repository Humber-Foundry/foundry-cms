import { readFile } from "node:fs/promises";

import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createPublicFormAuditEventId,
  createPublicFormClassificationId,
  createPublicFormDeliveryId,
  createPublicFormId,
  createPublicFormOutboxEventId,
  createPublicFormReceiptId,
  createPublicFormRequestHash,
  createPublicFormSubmissionId,
  defaultPublicFormRetentionPolicy,
  type PublicFormAcceptance,
} from "@foundry/application";
import { createSiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1PublicFormPrivacyStore } from "./d1-public-form-privacy-store";
import { createD1PublicFormNotificationStore } from "./d1-public-form-notification-store";
import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";

let runtime: Miniflare;
let database: Awaited<ReturnType<Miniflare["getD1Database"]>>;

function statements(migration: string) {
  const result: string[] = [];
  let current = "";
  let inTrigger = false;
  for (const line of migration.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    current += ` ${trimmed}`;
    if (trimmed.startsWith("CREATE TRIGGER")) inTrigger = true;
    if (
      (!inTrigger && trimmed.endsWith(";")) ||
      (inTrigger && trimmed === "END;")
    ) {
      result.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }
  return result;
}

const siteId = createSiteId("site_reference");
const accepted: PublicFormAcceptance = {
  identity: {
    siteId,
    formId: createPublicFormId("contact"),
    submissionId: createPublicFormSubmissionId(
      "00000000-0000-4000-8000-000000000048",
    ),
  },
  schemaVersion: "1.0.0",
  receiptId: createPublicFormReceiptId("receipt-48"),
  requestHash: createPublicFormRequestHash("hash-48"),
  fields: { email: "private@example.com", message: "Erase me" },
  classification: "accepted",
  deliveryStatus: "pending",
  classificationId: createPublicFormClassificationId("classification-48"),
  auditEventId: createPublicFormAuditEventId("audit-48"),
  deliveryId: createPublicFormDeliveryId("delivery-48"),
  outboxEventId: createPublicFormOutboxEventId("outbox-48"),
  acceptedAt: "2026-01-01T00:00:00.000Z",
};

function restoreInput(
  snapshot: Parameters<
    ReturnType<typeof createD1PublicFormPrivacyStore>["restoreBackupSnapshot"]
  >[0]["snapshot"],
  backupId = "backup-48",
) {
  return {
    snapshot,
    verification: {
      backupId,
      actorMembershipId: "membership-owner",
      verifiedAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

async function migrate(target = database) {
  for (const name of [
    "0003_public_forms.sql",
    "0004_public_form_notifications.sql",
    "0006_public_form_privacy.sql",
  ]) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of statements(migration)) {
      await target.exec(statement);
    }
  }
}

beforeEach(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["FOUNDRY_DB", "RECOVERY_DB"],
  });
  database = await runtime.getD1Database("FOUNDRY_DB");
  await migrate();
});

afterEach(() => runtime.dispose());

describe("D1 public form privacy store", () => {
  it("audits export and erasure without copying payload into audit facts", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    await expect(
      store.exportSubmission({
        siteId,
        receiptId: accepted.receiptId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ fields: accepted.fields });
    await expect(
      store.eraseSubmissionPayload({
        siteId,
        receiptId: accepted.receiptId,
        actorMembershipId: "membership-owner",
        reason: "authorized_erasure",
        now: "2026-07-27T00:01:00.000Z",
      }),
    ).resolves.toBe(true);
    const submission = await database
      .prepare(
        "SELECT fields_json, payload_deleted_at FROM public_form_submissions WHERE receipt_id = ?1",
      )
      .bind(accepted.receiptId)
      .first<{ fields_json: string; payload_deleted_at: string }>();
    expect(submission).toEqual({
      fields_json: "{}",
      payload_deleted_at: "2026-07-27T00:01:00.000Z",
    });
    const audit = await database
      .prepare(
        "SELECT action, outcome_code FROM public_form_operation_audit_events ORDER BY id",
      )
      .all<{ action: string; outcome_code: string | null }>();
    expect(audit.results).toEqual([
      { action: "submission_exported", outcome_code: null },
      {
        action: "submission_payload_erased",
        outcome_code: "authorized_erasure",
      },
    ]);
    expect(JSON.stringify(audit.results)).not.toContain("private@example.com");
  });

  it("does not report erasure while a delivery lease can still send the payload", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    await createD1PublicFormNotificationStore(database).claimDue({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
      leaseToken: "active-delivery",
      leaseUntil: "2026-07-27T00:04:00.000Z",
      limit: 1,
    });
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    await expect(
      store.eraseSubmissionPayload({
        siteId,
        receiptId: accepted.receiptId,
        actorMembershipId: "membership-owner",
        reason: "authorized_erasure",
        now: "2026-07-27T00:01:00.000Z",
      }),
    ).resolves.toBe(false);
    const row = await database
      .prepare(
        "SELECT fields_json, payload_deleted_at FROM public_form_submissions WHERE receipt_id = ?1",
      )
      .bind(accepted.receiptId)
      .first<{ fields_json: string; payload_deleted_at: string | null }>();
    expect(row?.payload_deleted_at).toBeNull();
    expect(row?.fields_json).toContain("private@example.com");
  });

  it("expires accepted payloads at 180 days while retaining minimal audit facts", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    await database
      .prepare(
        `UPDATE public_form_notification_jobs
         SET status = 'failed', last_error_code = 'rejected'
         WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .run();
    await database
      .prepare(
        `INSERT INTO public_form_restore_verifications (
           site_id, backup_id, actor_membership_id, target, submission_count,
           audit_fact_count, integrity_hash, verified_at
         ) VALUES (?1, 'old-backup', 'membership-owner', 'isolated', 1, 1,
                   'sha256:old', '2025-01-01T00:00:00.000Z')`,
      )
      .bind(siteId)
      .run();
    await database
      .prepare(
        `INSERT INTO public_form_backup_records (
           backup_id, site_id, object_key, integrity_hash, created_at,
           expires_at, retention_days
         ) VALUES ('old-backup', ?1, 'forms/old.enc', 'sha256:old',
                   '2025-01-01T00:00:00.000Z',
                   '2025-01-31T00:00:00.000Z', 30)`,
      )
      .bind(siteId)
      .run();
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    await expect(
      store.applyRetention({
        siteId,
        now: "2026-07-01T00:00:01.000Z",
        policy: defaultPublicFormRetentionPolicy,
      }),
    ).resolves.toEqual({ erasedPayloads: 1, expiredAuditFacts: 2 });
    const row = await database
      .prepare(
        "SELECT fields_json FROM public_form_submissions WHERE receipt_id = ?1",
      )
      .bind(accepted.receiptId)
      .first<{ fields_json: string }>();
    expect(row?.fields_json).toBe("{}");
    const expiredJob = await database
      .prepare(
        `SELECT status, last_error_code FROM public_form_notification_jobs
         WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .first<{ status: string; last_error_code: string }>();
    expect(expiredJob).toEqual({
      status: "failed",
      last_error_code: "payload_expired",
    });
    await expect(
      createD1PublicFormNotificationStore(database).replayFailed({
        siteId,
        deliveryId: accepted.deliveryId,
        actorMembershipId: "membership-owner",
        now: "2026-07-01T00:01:00.000Z",
      }),
    ).resolves.toBe(false);
    const restoreEvidence = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM public_form_restore_verifications",
      )
      .first<{ count: number }>();
    expect(restoreEvidence?.count).toBe(0);
    const backupEvidence = await database
      .prepare("SELECT COUNT(*) AS count FROM public_form_backup_records")
      .first<{ count: number }>();
    expect(backupEvidence?.count).toBe(0);
  });

  it("reclassifies a live payload, holds delivery, and records a payload-free fact", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    await expect(
      store.classifySubmission({
        siteId,
        receiptId: accepted.receiptId,
        classification: "suspected_spam",
        actorMembershipId: "membership-owner",
        now: "2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    const state = await database
      .prepare(
        `SELECT classification.classification, job.status
         FROM public_form_classifications AS classification
         JOIN public_form_delivery_intents AS delivery
           ON delivery.site_id = classification.site_id
          AND delivery.form_id = classification.form_id
          AND delivery.submission_id = classification.submission_id
         JOIN public_form_notification_jobs AS job
           ON job.delivery_id = delivery.id`,
      )
      .first<{ classification: string; status: string }>();
    expect(state).toEqual({
      classification: "suspected_spam",
      status: "held",
    });
    const audit = await database
      .prepare(
        `SELECT action, outcome_code
         FROM public_form_operation_audit_events`,
      )
      .first<{ action: string; outcome_code: string }>();
    expect(audit).toEqual({
      action: "submission_classified",
      outcome_code: "suspected_spam",
    });
    await expect(
      store.classifySubmission({
        siteId,
        receiptId: accepted.receiptId,
        classification: "accepted",
        actorMembershipId: "membership-owner",
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    const released = await database
      .prepare(
        `SELECT status, first_available_at
         FROM public_form_notification_jobs
         WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .first<{ status: string; first_available_at: string }>();
    expect(released).toEqual({
      status: "pending",
      first_available_at: "2026-07-27T00:00:00.000Z",
    });
  });

  it("holds failed delivery when classified as spam and prevents replay", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    await database
      .prepare(
        `UPDATE public_form_notification_jobs
         SET status = 'failed', attempts = 5, last_error_code = 'rejected'
         WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .run();
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );

    await expect(
      store.classifySubmission({
        siteId,
        receiptId: accepted.receiptId,
        classification: "suspected_spam",
        actorMembershipId: "membership-owner",
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      createD1PublicFormNotificationStore(database).replayFailed({
        siteId,
        deliveryId: accepted.deliveryId,
        actorMembershipId: "membership-owner",
        now: "2026-07-27T00:01:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      database
        .prepare(
          `SELECT status, attempts, last_error_code
           FROM public_form_notification_jobs
           WHERE delivery_id = ?1`,
        )
        .bind(accepted.deliveryId)
        .first(),
    ).resolves.toEqual({
      status: "held",
      attempts: 5,
      last_error_code: "rejected",
    });

    await expect(
      store.classifySubmission({
        siteId,
        receiptId: accepted.receiptId,
        classification: "accepted",
        actorMembershipId: "membership-owner",
        now: "2026-07-27T00:02:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      database
        .prepare(
          `SELECT status, attempts, last_error_code
           FROM public_form_notification_jobs
           WHERE delivery_id = ?1`,
        )
        .bind(accepted.deliveryId)
        .first(),
    ).resolves.toEqual({
      status: "pending",
      attempts: 0,
      last_error_code: null,
    });
  });

  it("audits reclassification after delivery is already terminal", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const notifications = createD1PublicFormNotificationStore(database);
    await notifications.claimDue({
      siteId,
      now: "2026-01-01T00:01:00.000Z",
      leaseToken: "delivery-complete",
      leaseUntil: "2026-01-01T00:05:00.000Z",
      limit: 1,
    });
    await notifications.recordOutcome({
      siteId,
      deliveryId: accepted.deliveryId,
      leaseToken: "delivery-complete",
      outcome: { outcome: "sent" },
      now: "2026-01-01T00:02:00.000Z",
      nextAttemptAt: null,
    });
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    await expect(
      store.classifySubmission({
        siteId,
        receiptId: accepted.receiptId,
        classification: "suspected_spam",
        actorMembershipId: "membership-owner",
        now: "2026-01-02T00:00:00.000Z",
      }),
    ).resolves.toBe(true);
    const audit = await database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM public_form_operation_audit_events
         WHERE action = 'submission_classified'`,
      )
      .first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });

  it("rejects reclassification while delivery is leased", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    await createD1PublicFormNotificationStore(database).claimDue({
      siteId,
      now: "2026-01-01T00:01:00.000Z",
      leaseToken: "delivery-active",
      leaseUntil: "2026-01-01T00:05:00.000Z",
      limit: 1,
    });
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );

    await expect(
      store.classifySubmission({
        siteId,
        receiptId: accepted.receiptId,
        classification: "suspected_spam",
        actorMembershipId: "membership-owner",
        now: "2026-01-01T00:02:00.000Z",
      }),
    ).resolves.toBe(false);

    const state = await database
      .prepare(
        `SELECT classification.classification, job.status
         FROM public_form_classifications AS classification
         JOIN public_form_notification_jobs AS job
           ON job.delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .first<{ classification: string; status: string }>();
    expect(state).toEqual({ classification: "accepted", status: "processing" });
  });

  it("does not postpone delivery when classification is unchanged", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );

    await expect(
      store.classifySubmission({
        siteId,
        receiptId: accepted.receiptId,
        classification: "accepted",
        actorMembershipId: "membership-owner",
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).resolves.toBe(false);

    const job = await database
      .prepare(
        `SELECT status, available_at, first_available_at, updated_at
         FROM public_form_notification_jobs WHERE delivery_id = ?1`,
      )
      .bind(accepted.deliveryId)
      .first<{
        status: string;
        available_at: string;
        first_available_at: string;
        updated_at: string;
      }>();
    expect(job).toEqual({
      status: "pending",
      available_at: accepted.acceptedAt,
      first_available_at: accepted.acceptedAt,
      updated_at: accepted.acceptedAt,
    });
  });

  it("rejects an oversized online snapshot before loading all form rows", async () => {
    const binding = database as unknown as D1DatabaseBinding;
    let batches = 0;
    const oversizedBinding: D1DatabaseBinding = {
      prepare: (query) => binding.prepare(query),
      async batch(statements) {
        batches += 1;
        return statements.map((_, index) => ({
          success: true,
          meta: {},
          results: [
            { bytes: index === 0 ? 8 * 1_024 * 1_024 + 1 : 0 },
          ],
        }));
      },
    };

    await expect(
      createD1PublicFormPrivacyStore(
        oversizedBinding,
      ).createBackupSnapshot({
        siteId,
        now: "2026-07-27T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "recovery_backup_too_large" });
    expect(batches).toBe(1);
  });

  it("scopes every online snapshot size estimate to the requested site", async () => {
    const binding = database as unknown as D1DatabaseBinding;
    const preparedQueries: string[] = [];
    const scopedBinding: D1DatabaseBinding = {
      prepare(query) {
        preparedQueries.push(query);
        return binding.prepare(query);
      },
      batch: (statements) => binding.batch(statements),
    };

    await createD1PublicFormPrivacyStore(scopedBinding).createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const estimates = preparedQueries.filter((query) =>
      query.includes("AS bytes"),
    );
    expect(estimates).toHaveLength(7);
    expect(estimates.every((query) => query.includes("site_id = ?1"))).toBe(
      true,
    );
    expect(
      estimates
        .filter(
          (query) =>
            query.includes("public_form_outbox_events") ||
            query.includes("public_form_notification_jobs"),
        )
        .every((query) =>
          query.includes("JOIN public_form_delivery_intents"),
        ),
    ).toBe(true);
  });

  it("fences overlapping backup writers through the complete record operation", async () => {
    const store = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    await expect(
      store.claimBackup({
        siteId,
        checkpoint: "initial",
        leaseToken: "lease-winner",
        now: "2026-07-27T00:00:00.000Z",
        leaseUntil: "2026-07-27T00:15:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimBackup({
        siteId,
        checkpoint: "initial",
        leaseToken: "lease-loser",
        now: "2026-07-27T00:00:01.000Z",
        leaseUntil: "2026-07-27T00:15:01.000Z",
      }),
    ).resolves.toBe(false);
    const original = {
      siteId,
      checkpoint: "initial",
      leaseToken: "lease-winner",
      recordedAt: "2026-07-27T00:01:00.000Z",
      backupId: "backup-site_reference-after-initial",
      objectKey:
        "forms/site_reference/backup-site_reference-after-initial.enc",
      integrityHash: "sha256:first-attempt",
      createdAt: "2026-07-27T00:00:00.000Z",
      expiresAt: "2026-08-26T00:00:00.000Z",
      retentionDays: 30,
    };
    await store.recordBackup(original);

    await expect(
      database
        .prepare(
          `SELECT object_key, integrity_hash, created_at
           FROM public_form_backup_records WHERE backup_id = ?1`,
        )
        .bind(original.backupId)
        .first(),
    ).resolves.toEqual({
      object_key: original.objectKey,
      integrity_hash: "sha256:first-attempt",
      created_at: "2026-07-27T00:00:00.000Z",
    });
    await expect(
      store.recordBackup({
        ...original,
        leaseToken: "lease-loser",
        integrityHash: "sha256:loser",
      }),
    ).rejects.toThrow("form_backup_claim_lost");
    await expect(
      store.claimBackup({
        siteId,
        checkpoint: original.createdAt,
        leaseToken: "lease-expiring",
        now: "2026-07-27T00:02:00.000Z",
        leaseUntil: "2026-07-27T00:15:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(
      store.recordBackup({
        ...original,
        checkpoint: original.createdAt,
        leaseToken: "lease-expiring",
        recordedAt: "2026-07-27T00:16:00.000Z",
        backupId: "backup-site_reference-after-first",
        objectKey: "forms/site_reference/backup-after-first.enc",
      }),
    ).rejects.toThrow("form_backup_claim_lost");
  });

  it("restores a snapshot into an empty isolated database and verifies integrity", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const source = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    const snapshot = await source.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const recovery = await runtime.getD1Database("RECOVERY_DB");
    await migrate(recovery);
    const target = createD1PublicFormPrivacyStore(
      recovery as unknown as D1DatabaseBinding,
    );
    const evidence = await target.restoreBackupSnapshot(
      restoreInput(snapshot),
    );
    expect(evidence).toMatchObject({ submissions: 1, auditFacts: 1 });
    await expect(
      target.restoreBackupSnapshot({
        snapshot,
        verification: {
          backupId: "backup-48",
          actorMembershipId: "membership-retrying-owner",
          verifiedAt: "2026-07-28T00:00:00.000Z",
        },
      }),
    ).resolves.toMatchObject({
      submissions: 1,
      auditFacts: 1,
      actorMembershipId: "membership-owner",
      verifiedAt: "2026-07-27T00:00:00.000Z",
    });
    await expect(
      target.restoreBackupSnapshot(restoreInput(snapshot, "backup-other")),
    ).rejects.toThrow("public_form_privacy_recovery_target_not_empty");
    const primaryVerification = {
      siteId,
      backupId: "backup-48",
      target: "isolated" as const,
      evidence,
    };
    await source.recordRestoreVerification(primaryVerification);
    await source.recordRestoreVerification(primaryVerification);
    const primaryFacts = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM public_form_restore_verifications
         WHERE backup_id = 'backup-48'`,
      )
      .first<{ count: number }>();
    expect(primaryFacts?.count).toBe(1);
    await target.clearRestoredSnapshot({
      siteId,
      backupId: "backup-48",
      evidence,
    });
    await target.clearRestoredSnapshot({
      siteId,
      backupId: "backup-48",
      evidence,
    });
    const recoveryRows = await recovery
      .prepare(`SELECT (${[
        "public_form_submissions",
        "public_form_classifications",
        "public_form_delivery_intents",
        "public_form_outbox_events",
        "public_form_notification_jobs",
        "public_form_audit_events",
        "public_form_operation_audit_events",
        "public_form_restore_verifications",
      ]
        .map((table) => `(SELECT COUNT(*) FROM ${table})`)
        .join(" + ")}) AS count`)
      .first<{ count: number }>();
    expect(recoveryRows?.count).toBe(0);
  });

  it("uses bounded multi-row statements for an ordinary multi-submission restore", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const source = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    const original = await source.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const copies = Array.from(
      { length: 20 },
      (_, index) => `${index + 1}`,
    ).sort();
    const snapshot = {
      ...original,
      submissions: copies.map((suffix) => ({
        ...original.submissions[0]!,
        submission_id: `submission-${suffix}`,
        receipt_id: `receipt-${suffix}`,
        request_hash: `hash-${suffix}`,
      })),
      classifications: copies.map((suffix) => ({
        ...original.classifications[0]!,
        id: `classification-${suffix}`,
        submission_id: `submission-${suffix}`,
      })),
      deliveries: copies.map((suffix) => ({
        ...original.deliveries[0]!,
        id: `delivery-${suffix}`,
        submission_id: `submission-${suffix}`,
      })),
      outboxEvents: copies.map((suffix) => ({
        ...original.outboxEvents[0]!,
        id: `outbox-${suffix}`,
        delivery_id: `delivery-${suffix}`,
      })),
      notificationJobs: copies.map((suffix) => ({
        ...original.notificationJobs[0]!,
        delivery_id: `delivery-${suffix}`,
      })),
      acceptanceAuditFacts: copies.map((suffix) => ({
        ...original.acceptanceAuditFacts[0]!,
        id: `audit-${suffix}`,
        subject_id: `submission-${suffix}`,
      })),
    };
    const recovery = await runtime.getD1Database("RECOVERY_DB");
    await migrate(recovery);
    const binding = recovery as unknown as D1DatabaseBinding;
    let queryCount = 0;
    const countedBinding: D1DatabaseBinding = {
      prepare: (query) => binding.prepare(query),
      async batch(statements) {
        queryCount += statements.length;
        return binding.batch(statements);
      },
    };

    await expect(
      createD1PublicFormPrivacyStore(countedBinding).restoreBackupSnapshot(
        restoreInput(snapshot),
      ),
    ).resolves.toMatchObject({ submissions: 20 });
    expect(queryCount).toBeLessThan(40);
  });

  it("rejects a recovery target when any restored table already contains data", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const source = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    const snapshot = await source.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const recovery = await runtime.getD1Database("RECOVERY_DB");
    await migrate(recovery);
    await recovery
      .prepare(
        `INSERT INTO public_form_audit_events (
           id, site_id, event_type, subject_id, occurred_at
         ) VALUES ('existing-audit', ?1, 'submission_accepted', 'existing', ?2)`,
      )
      .bind(siteId, "2026-07-26T00:00:00.000Z")
      .run();
    const target = createD1PublicFormPrivacyStore(
      recovery as unknown as D1DatabaseBinding,
    );

    await expect(
      target.restoreBackupSnapshot(restoreInput(snapshot)),
    ).rejects.toThrow("public_form_privacy_recovery_target_not_empty");
  });

  it("fails closed when the recovery target count result is missing", async () => {
    const binding = database as unknown as D1DatabaseBinding;
    const incompleteBinding: D1DatabaseBinding = {
      prepare: (query) => binding.prepare(query),
      async batch() {
        return [];
      },
    };
    const target = createD1PublicFormPrivacyStore(incompleteBinding);

    await expect(
      target.restoreBackupSnapshot({
        snapshot: {
          version: 1,
          siteId,
          createdAt: "2026-07-27T00:00:00.000Z",
          submissions: [],
          classifications: [],
          deliveries: [],
          outboxEvents: [],
          notificationJobs: [],
          acceptanceAuditFacts: [],
          auditFacts: [],
        },
        verification: restoreInput({
          version: 1,
          siteId,
          createdAt: "2026-07-27T00:00:00.000Z",
          submissions: [],
          classifications: [],
          deliveries: [],
          outboxEvents: [],
          notificationJobs: [],
          acceptanceAuditFacts: [],
          auditFacts: [],
        }).verification,
      }),
    ).rejects.toMatchObject({ code: "recovery_target_check_failed" });
  });

  it("maps recovery database outages to a resumable typed failure", async () => {
    const binding = database as unknown as D1DatabaseBinding;
    const unavailableBinding: D1DatabaseBinding = {
      prepare: (query) => binding.prepare(query),
      async batch() {
        throw new Error("d1_unavailable");
      },
    };

    await expect(
      createD1PublicFormPrivacyStore(
        unavailableBinding,
      ).restoreBackupSnapshot({
        snapshot: {
          version: 1,
          siteId,
          createdAt: "2026-07-27T00:00:00.000Z",
          submissions: [],
          classifications: [],
          deliveries: [],
          outboxEvents: [],
          notificationJobs: [],
          acceptanceAuditFacts: [],
          auditFacts: [],
        },
        verification: {
          backupId: "backup-unavailable",
          actorMembershipId: "membership-owner",
          verifiedAt: "2026-07-27T00:00:00.000Z",
        },
      }),
    ).rejects.toMatchObject({ code: "recovery_target_check_failed" });
  });

  it("does not promote staged rows when integrity verification fails", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const source = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    const snapshot = await source.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const recovery = await runtime.getD1Database("RECOVERY_DB");
    await migrate(recovery);
    await recovery
      .prepare(
        `CREATE TRIGGER corrupt_staged_submission
         AFTER INSERT ON public_form_restore_stage_submissions
         BEGIN
           UPDATE public_form_restore_stage_submissions
           SET fields_json = '{}'
           WHERE receipt_id = NEW.receipt_id;
         END`,
      )
      .run();
    const target = createD1PublicFormPrivacyStore(
      recovery as unknown as D1DatabaseBinding,
    );

    await expect(
      target.restoreBackupSnapshot(restoreInput(snapshot)),
    ).rejects.toThrow("public_form_privacy_recovery_integrity_mismatch");
    const [live, staged] = await Promise.all([
      recovery
        .prepare("SELECT COUNT(*) AS count FROM public_form_submissions")
        .first<{ count: number }>(),
      recovery
        .prepare(
          "SELECT COUNT(*) AS count FROM public_form_restore_stage_submissions",
        )
        .first<{ count: number }>(),
    ]);
    expect(live?.count).toBe(0);
    expect(staged?.count).toBe(0);
  });

  it("does not promote a staged generation replaced after verification", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const source = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    const snapshot = await source.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const recovery = await runtime.getD1Database("RECOVERY_DB");
    await migrate(recovery);
    const binding = recovery as unknown as D1DatabaseBinding;
    let batchCalls = 0;
    const racingBinding: D1DatabaseBinding = {
      prepare: (query) => binding.prepare(query),
      async batch(statements) {
        batchCalls += 1;
        const results = await binding.batch(statements);
        if (batchCalls === 3) {
          await recovery
            .prepare(
              `UPDATE public_form_restore_stage_control
               SET integrity_hash = 'sha256:replacement'
               WHERE id = 1`,
            )
            .run();
        }
        return results;
      },
    };

    await expect(
      createD1PublicFormPrivacyStore(racingBinding).restoreBackupSnapshot(
        restoreInput(snapshot),
      ),
    ).rejects.toMatchObject({ code: "recovery_target_check_failed" });
    const live = await recovery
      .prepare("SELECT COUNT(*) AS count FROM public_form_submissions")
      .first<{ count: number }>();
    expect(live?.count).toBe(0);
  });

  it("reconciles a committed promotion whose batch response was lost", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const source = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    const snapshot = await source.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const recovery = await runtime.getD1Database("RECOVERY_DB");
    await migrate(recovery);
    const binding = recovery as unknown as D1DatabaseBinding;
    let batchCalls = 0;
    const uncertainBinding: D1DatabaseBinding = {
      prepare: (query) => binding.prepare(query),
      async batch(statements) {
        batchCalls += 1;
        const results = await binding.batch(statements);
        if (batchCalls === 5) {
          throw new Error("promotion_response_lost");
        }
        return results;
      },
    };

    await expect(
      createD1PublicFormPrivacyStore(
        uncertainBinding,
      ).restoreBackupSnapshot(restoreInput(snapshot)),
    ).resolves.toMatchObject({
      submissions: 1,
      auditFacts: 1,
      actorMembershipId: "membership-owner",
    });
    await expect(
      recovery
        .prepare(
          `SELECT backup_id, actor_membership_id
           FROM public_form_restore_verifications`,
        )
        .first(),
    ).resolves.toEqual({
      backup_id: "backup-48",
      actor_membership_id: "membership-owner",
    });
  });

  it("atomically refuses promotion if the target changes after the empty check", async () => {
    await createD1PublicFormAcceptanceStore(database).accept(accepted);
    const source = createD1PublicFormPrivacyStore(
      database as unknown as D1DatabaseBinding,
    );
    const snapshot = await source.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const recovery = await runtime.getD1Database("RECOVERY_DB");
    await migrate(recovery);
    const binding = recovery as unknown as D1DatabaseBinding;
    let batchCalls = 0;
    const racingBinding: D1DatabaseBinding = {
      prepare: (query) => binding.prepare(query),
      async batch(statements) {
        batchCalls += 1;
        if (batchCalls === 4) {
          await recovery
            .prepare(
              `INSERT INTO public_form_audit_events (
                 id, site_id, event_type, subject_id, occurred_at
               ) VALUES (
                 'racing-audit', ?1, 'submission_accepted', 'racing', ?2
               )`,
            )
            .bind(siteId, "2026-07-27T00:00:00.000Z")
            .run();
        }
        return binding.batch(statements);
      },
    };
    const target = createD1PublicFormPrivacyStore(racingBinding);

    await expect(
      target.restoreBackupSnapshot(restoreInput(snapshot)),
    ).rejects.toThrow();
    const submissionCount = await recovery
      .prepare("SELECT COUNT(*) AS count FROM public_form_submissions")
      .first<{ count: number }>();
    const auditCount = await recovery
      .prepare("SELECT COUNT(*) AS count FROM public_form_audit_events")
      .first<{ count: number }>();
    expect(submissionCount?.count).toBe(0);
    expect(auditCount?.count).toBe(1);
  });
});

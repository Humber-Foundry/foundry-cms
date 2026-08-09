import { describe, expect, it, vi } from "vitest";

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
  type PublicFormAcceptance,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1PublicFormPrivacyStore } from "./d1-public-form-privacy-store";
import { createD1PublicFormAcceptanceStore } from "./d1-public-form-store";
import {
  createEncryptedR2PublicFormBackupVault,
  type R2BackupBucket,
} from "./encrypted-r2-form-backup-vault";
import { runPublicFormRecoveryOperator } from "./public-form-recovery-operator";
import { useMigratedTestDatabase } from "./test-support/migrated-test-database";

const testDatabase = useMigratedTestDatabase({
  PRIMARY: [
    "0001_human_access.sql",
    "0003_public_forms.sql",
    "0004_public_form_notifications.sql",
    "0006_public_form_privacy.sql",
  ],
  RECOVERY: [
    "0003_public_forms.sql",
    "0004_public_form_notifications.sql",
    "0006_public_form_privacy.sql",
  ],
});
const primary = testDatabase.databaseFor("PRIMARY");
const recovery = testDatabase.databaseFor("RECOVERY");

function memoryBucket(): R2BackupBucket {
  const objects = new Map<
    string,
    { body: Uint8Array; customMetadata?: Record<string, string> }
  >();
  return {
    async put(key, body, options) {
      objects.set(key, { body, customMetadata: options?.customMetadata });
    },
    async get(key) {
      const object = objects.get(key);
      if (object === undefined) return null;
      return {
        customMetadata: object.customMetadata,
        async arrayBuffer() {
          return object.body.buffer.slice(
            object.body.byteOffset,
            object.body.byteOffset + object.body.byteLength,
          ) as ArrayBuffer;
        },
      };
    },
    async list() {
      return { objects: [], truncated: false };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

describe("public form recovery operator", () => {
  it("uses the client key, verifies an active Owner, mirrors evidence, and clears recovery data", async () => {
    const siteId = referenceSiteDefinition.site.id;
    await primary
      .prepare(
        "INSERT INTO human_users (id, email, created_at) VALUES (?1, ?2, ?3)",
      )
      .bind("user-owner", "owner@example.com", "2026-07-27T00:00:00.000Z")
      .run();
    await primary
      .prepare(
        `INSERT INTO human_memberships (
           id, site_id, user_id, email, identity_issuer, identity_subject,
           role, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owner', 'active', ?7, ?7)`,
      )
      .bind(
        "membership-owner",
        siteId,
        "user-owner",
        "owner@example.com",
        "operator-test",
        "owner-48",
        "2026-07-27T00:00:00.000Z",
      )
      .run();
    const accepted: PublicFormAcceptance = {
      identity: {
        siteId,
        formId: createPublicFormId("contact"),
        submissionId: createPublicFormSubmissionId(
          "00000000-0000-4000-8000-000000000048",
        ),
      },
      schemaVersion: "1.0.0",
      receiptId: createPublicFormReceiptId("receipt-operator-48"),
      requestHash: createPublicFormRequestHash("hash-operator-48"),
      fields: { email: "private@example.com" },
      classification: "accepted",
      deliveryStatus: "pending",
      classificationId: createPublicFormClassificationId("classification-48"),
      auditEventId: createPublicFormAuditEventId("audit-48"),
      deliveryId: createPublicFormDeliveryId("delivery-48"),
      outboxEventId: createPublicFormOutboxEventId("outbox-48"),
      acceptedAt: "2026-07-27T00:00:00.000Z",
    };
    await createD1PublicFormAcceptanceStore(primary).accept(accepted);

    const pair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    );
    const recipient = Buffer.from(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    ).toString("base64");
    const privateKey = Buffer.from(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ).toString("base64");
    const bucket = memoryBucket();
    const primaryStore = createD1PublicFormPrivacyStore(
      primary as unknown as D1DatabaseBinding,
    );
    const createdAt = new Date().toISOString();
    const saved = await createEncryptedR2PublicFormBackupVault({
      bucket,
      recoveryRecipientBase64: recipient,
      siteId,
    }).saveEncrypted({
      backupId: "backup-operator-48",
      snapshot: await primaryStore.createBackupSnapshot({
        siteId,
        now: createdAt,
      }),
      createdAt,
      retentionDays: 30,
    });

    await expect(
      runPublicFormRecoveryOperator({
        primaryDatabase: primary as unknown as D1DatabaseBinding,
        recoveryDatabase: recovery as unknown as D1DatabaseBinding,
        backupBucket: bucket,
        recoveryPrivateKeyBase64: privateKey,
        backupId: "backup-operator-48",
        actorMembershipId: "membership-owner",
      }),
    ).resolves.toMatchObject({
      submissions: 1,
      actorMembershipId: "membership-owner",
    });
    const primaryEvidence = await primary
      .prepare(
        `SELECT integrity_hash FROM public_form_restore_verifications
         WHERE backup_id = ?1 AND target = 'isolated'`,
      )
      .bind("backup-operator-48")
      .first<{ integrity_hash: string }>();
    expect(primaryEvidence?.integrity_hash).toMatch(/^sha256:/u);
    expect(saved.integrityHash).toMatch(/^sha256:/u);
    const recoveryRows = await recovery
      .prepare("SELECT COUNT(*) AS count FROM public_form_submissions")
      .first<{ count: number }>();
    expect(recoveryRows?.count).toBe(0);
  });

  it("rejects a non-Owner before reading the backup", async () => {
    const bucket = memoryBucket();
    await expect(
      runPublicFormRecoveryOperator({
        primaryDatabase: primary as unknown as D1DatabaseBinding,
        recoveryDatabase: recovery as unknown as D1DatabaseBinding,
        backupBucket: bucket,
        recoveryPrivateKeyBase64: "invalid",
        backupId: "backup-operator-48",
        actorMembershipId: "missing-owner",
      }),
    ).rejects.toThrow("form_recovery_active_owner_required");
  });
});

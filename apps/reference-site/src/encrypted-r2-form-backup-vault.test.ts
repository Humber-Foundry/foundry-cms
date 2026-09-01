import { beforeAll, describe, expect, it } from "vitest";

import { createSiteId } from "@humber-foundry/site-definition";
import type { PublicFormBackupSnapshot } from "@humber-foundry/application";

import {
  createEncryptedR2PublicFormBackupVault,
  createEncryptedR2PublicFormRecoveryVault,
  type R2BackupBucket,
} from "./encrypted-r2-form-backup-vault";

const siteId = createSiteId("site_reference");
let recoveryRecipientBase64: string;
let recoveryPrivateKeyBase64: string;

beforeAll(async () => {
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
  recoveryRecipientBase64 = Buffer.from(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  ).toString("base64");
  recoveryPrivateKeyBase64 = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).toString("base64");
});

function memoryBucket(): R2BackupBucket & {
  objects: Map<
    string,
    { body: Uint8Array; customMetadata?: Record<string, string> }
  >;
} {
  const objects = new Map<
    string,
    { body: Uint8Array; customMetadata?: Record<string, string> }
  >();
  return {
    objects,
    async put(key, value, options) {
      objects.set(key, {
        body: value,
        customMetadata: options?.customMetadata,
      });
    },
    async get(key) {
      const object = objects.get(key);
      if (object === undefined) return null;
      return {
        customMetadata: object.customMetadata,
        arrayBuffer: async () =>
          object.body.buffer.slice(
            object.body.byteOffset,
            object.body.byteOffset + object.body.byteLength,
          ) as ArrayBuffer,
      };
    },
    async list() {
      return {
        objects: Array.from(objects, ([key, value]) => ({
          key,
          customMetadata: value.customMetadata,
        })),
        truncated: false,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function vaults(bucket: R2BackupBucket) {
  return {
    backup: createEncryptedR2PublicFormBackupVault({
      bucket,
      recoveryRecipientBase64,
      siteId,
    }),
    recovery: createEncryptedR2PublicFormRecoveryVault({
      bucket,
      recoveryPrivateKeyBase64,
      siteId,
    }),
  };
}

describe("encrypted R2 form backup vault", () => {
  it("defers recipient-key validation until encryption is required", async () => {
    const backup = createEncryptedR2PublicFormBackupVault({
      bucket: memoryBucket(),
      recoveryRecipientBase64: Buffer.from("not-an-spki-key").toString(
        "base64",
      ),
      siteId,
    });
    const snapshot: PublicFormBackupSnapshot = {
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
    };

    await expect(
      backup.deleteExpired({ now: "2026-07-27T00:00:00.000Z" }),
    ).resolves.toBe(0);
    await expect(
      backup.saveEncrypted({
        backupId: "backup-invalid-recipient",
        snapshot,
        createdAt: snapshot.createdAt,
        retentionDays: 30,
      }),
    ).rejects.toMatchObject({ code: "recovery_backup_unavailable" });
  });

  it("writes immutable per-attempt objects for one logical backup", async () => {
    const bucket = memoryBucket();
    const { backup } = vaults(bucket);
    const snapshot: PublicFormBackupSnapshot = {
      version: 1,
      siteId,
      createdAt: new Date().toISOString(),
      submissions: [],
      classifications: [],
      deliveries: [],
      outboxEvents: [],
      notificationJobs: [],
      acceptanceAuditFacts: [],
      auditFacts: [],
    };
    const createdAt = new Date().toISOString();

    const first = await backup.saveEncrypted({
      backupId: "backup-checkpoint",
      attemptId: "lease-a",
      snapshot,
      createdAt,
      retentionDays: 30,
    });
    const second = await backup.saveEncrypted({
      backupId: "backup-checkpoint",
      attemptId: "lease-b",
      snapshot,
      createdAt,
      retentionDays: 30,
    });

    expect(first.objectKey).toBe(
      "forms/site_reference/backup-checkpoint/lease-a.enc",
    );
    expect(second.objectKey).toBe(
      "forms/site_reference/backup-checkpoint/lease-b.enc",
    );
    expect(bucket.objects.has(first.objectKey)).toBe(true);
    expect(bucket.objects.has(second.objectKey)).toBe(true);
  });

  it("stores ciphertext, authenticates site metadata, and removes expired objects", async () => {
    const bucket = memoryBucket();
    const { backup, recovery } = vaults(bucket);
    // `readDecrypted` checks the stored expiry against the real clock. A fixed
    // `createdAt` makes this backup live only until its retention window ends,
    // so the backup is written now and the deletion clock is derived from it.
    const createdAt = new Date().toISOString();
    const afterRetention = new Date(
      Date.parse(createdAt) + 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const snapshot = {
      version: 1 as const,
      siteId,
      createdAt,
      submissions: [
        {
          site_id: siteId,
          form_id: "contact",
          submission_id: "submission-48",
          schema_version: "1.0.0",
          receipt_id: "receipt-48",
          request_hash: "hash-48",
          fields_json: '{"email":"private@example.com"}',
          accepted_at: createdAt,
          payload_deleted_at: null,
        },
      ],
      classifications: [],
      deliveries: [],
      outboxEvents: [],
      notificationJobs: [],
      acceptanceAuditFacts: [],
      auditFacts: [],
    };
    const saved = await backup.saveEncrypted({
      backupId: "backup-48",
      snapshot,
      createdAt: snapshot.createdAt,
      retentionDays: 30,
    });
    const raw = await bucket.get(saved.objectKey);
    const bytes = new Uint8Array(await raw!.arrayBuffer());
    const serializedEnvelope = new TextDecoder().decode(bytes);
    expect(serializedEnvelope).not.toContain("private@example.com");
    expect(JSON.parse(serializedEnvelope)).toMatchObject({
      version: 2,
      algorithm: "RSA-OAEP-256+A256GCM",
      wrappedKey: expect.any(String),
    });
    expect("readDecrypted" in backup).toBe(false);
    await expect(
      recovery.readDecrypted({ backupId: "backup-48", siteId }),
    ).resolves.toEqual(snapshot);
    await expect(
      backup.deleteExpired({ now: afterRetention }),
    ).resolves.toBe(1);
  });

  it("rejects authenticated plaintext that does not match the versioned row schema", async () => {
    const { backup, recovery } = vaults(memoryBucket());
    await backup.saveEncrypted({
      backupId: "invalid-48",
      snapshot: {
        version: 1,
        siteId,
        createdAt: "2026-07-27T00:00:00.000Z",
        submissions: [{ fields_json: "{}" }],
        classifications: [],
        deliveries: [],
        outboxEvents: [],
        notificationJobs: [],
        acceptanceAuditFacts: [],
        auditFacts: [],
      } as unknown as PublicFormBackupSnapshot,
      createdAt: "2026-07-27T00:00:00.000Z",
      retentionDays: 30,
    });
    await expect(
      recovery.readDecrypted({ backupId: "invalid-48", siteId }),
    ).rejects.toThrow("public_form_privacy_recovery_backup_invalid");
  });

  it("rejects ciphertext substituted under a different backup identity", async () => {
    const bucket = memoryBucket();
    const { backup, recovery } = vaults(bucket);
    const snapshot = {
      version: 1 as const,
      siteId,
      createdAt: "2026-07-27T00:00:00.000Z",
      submissions: [],
      classifications: [],
      deliveries: [],
      outboxEvents: [],
      notificationJobs: [],
      acceptanceAuditFacts: [],
      auditFacts: [],
    };
    const older = await backup.saveEncrypted({
      backupId: "backup-older",
      snapshot,
      createdAt: snapshot.createdAt,
      retentionDays: 30,
    });
    const requested = await backup.saveEncrypted({
      backupId: "backup-requested",
      snapshot: {
        ...snapshot,
        createdAt: "2026-07-28T00:00:00.000Z",
      },
      createdAt: "2026-07-28T00:00:00.000Z",
      retentionDays: 30,
    });
    const olderObject = bucket.objects.get(older.objectKey)!;
    const requestedObject = bucket.objects.get(requested.objectKey)!;
    await bucket.put(requested.objectKey, olderObject.body, {
      customMetadata: {
        ...requestedObject.customMetadata!,
        integrityHash: await crypto.subtle
          .digest("SHA-256", olderObject.body.slice().buffer as ArrayBuffer)
          .then(
            (digest) =>
              `sha256:${Array.from(
                new Uint8Array(digest),
                (byte) => byte.toString(16).padStart(2, "0"),
              ).join("")}`,
          ),
      },
    });

    await expect(
      recovery.readDecrypted({ backupId: "backup-requested", siteId }),
    ).rejects.toMatchObject({ code: "recovery_backup_invalid" });
  });

  it("cannot decrypt without the client-held recovery private key", async () => {
    const bucket = memoryBucket();
    const { backup } = vaults(bucket);
    await backup.saveEncrypted({
      backupId: "backup-client-key",
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
      createdAt: "2026-07-27T00:00:00.000Z",
      retentionDays: 30,
    });
    const unrelatedPair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    );
    const unrelatedPrivateKey = Buffer.from(
      await crypto.subtle.exportKey("pkcs8", unrelatedPair.privateKey),
    ).toString("base64");
    const unrelatedRecovery =
      createEncryptedR2PublicFormRecoveryVault({
        bucket,
        recoveryPrivateKeyBase64: unrelatedPrivateKey,
        siteId,
      });

    await expect(
      unrelatedRecovery.readDecrypted({
        backupId: "backup-client-key",
        siteId,
      }),
    ).rejects.toMatchObject({ code: "recovery_backup_invalid" });
  });

  it("rejects an authenticated backup after its retention deadline", async () => {
    const { backup, recovery } = vaults(memoryBucket());
    await backup.saveEncrypted({
      backupId: "backup-expired",
      snapshot: {
        version: 1,
        siteId,
        createdAt: "2025-01-01T00:00:00.000Z",
        submissions: [],
        classifications: [],
        deliveries: [],
        outboxEvents: [],
        notificationJobs: [],
        acceptanceAuditFacts: [],
        auditFacts: [],
      },
      createdAt: "2025-01-01T00:00:00.000Z",
      retentionDays: 30,
    });

    await expect(
      recovery.readDecrypted({ backupId: "backup-expired", siteId }),
    ).rejects.toMatchObject({ code: "recovery_backup_not_found" });
  });

  it("returns typed missing and unavailable backup failures", async () => {
    const missing = createEncryptedR2PublicFormRecoveryVault({
      bucket: memoryBucket(),
      recoveryPrivateKeyBase64,
      siteId,
    });
    await expect(
      missing.readDecrypted({ backupId: "missing-48", siteId }),
    ).rejects.toMatchObject({ code: "recovery_backup_not_found" });

    const unavailable = createEncryptedR2PublicFormRecoveryVault({
      bucket: {
        ...memoryBucket(),
        async get() {
          throw new Error("r2_unavailable");
        },
      },
      recoveryPrivateKeyBase64,
      siteId,
    });
    await expect(
      unavailable.readDecrypted({ backupId: "unavailable-48", siteId }),
    ).rejects.toMatchObject({ code: "recovery_backup_unavailable" });
  });
});

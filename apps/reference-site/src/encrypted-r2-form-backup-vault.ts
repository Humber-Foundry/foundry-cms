import {
  PublicFormPrivacyError,
  publicFormClassifications,
  publicFormDeliveryStatuses,
  publicFormNotificationJobStatuses,
  publicFormOperationAuditActions,
  publicFormOutboxEventTypes,
  type PublicFormBackupAcceptanceAuditRow,
  type PublicFormBackupClassificationRow,
  type PublicFormBackupDeliveryRow,
  type PublicFormBackupNotificationJobRow,
  type PublicFormBackupOperationAuditRow,
  type PublicFormBackupOutboxRow,
  type PublicFormBackupSnapshot,
  type PublicFormBackupSubmissionRow,
  type PublicFormBackupVault,
  type PublicFormRecoveryVault,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

export interface R2BackupBucket {
  put(
    key: string,
    value: Uint8Array,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{
    customMetadata?: Record<string, string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  list(input?: {
    prefix?: string;
    cursor?: string;
    include?: ReadonlyArray<"customMetadata">;
  }): Promise<{
    objects: ReadonlyArray<{
      key: string;
      customMetadata?: Record<string, string>;
    }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<unknown>;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeRecoveryKey(value: string) {
  try {
    return decodeBase64(value);
  } catch {
    throw new PublicFormPrivacyError("recovery_backup_unavailable");
  }
}

function backupAdditionalData(
  siteId: SiteId,
  backupId: string,
  createdAt: string,
  expiresAt: string,
) {
  return new TextEncoder().encode(
    JSON.stringify({ siteId, backupId, createdAt, expiresAt }),
  );
}

async function sha256(value: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    value.slice().buffer as ArrayBuffer,
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

type Shape = Readonly<Record<string, "string" | "number" | "nullable-string">>;

function hasShape(value: unknown, shape: Shape): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === Object.keys(shape).length &&
    Object.entries(shape).every(([key, kind]) => {
      const candidate = record[key];
      return kind === "nullable-string"
        ? candidate === null || typeof candidate === "string"
        : typeof candidate === kind;
    })
  );
}

function everyRow<T>(
  value: unknown,
  shape: Shape,
  refine?: (row: Record<string, unknown>) => boolean,
): value is ReadonlyArray<T> {
  return (
    Array.isArray(value) &&
    value.every(
      (row) => hasShape(row, shape) && (refine === undefined || refine(row)),
    )
  );
}

function includesValue<const Values extends ReadonlyArray<string>>(
  values: Values,
  candidate: unknown,
): candidate is Values[number] {
  return typeof candidate === "string" && values.includes(candidate);
}

const submissionShape = {
  site_id: "string",
  form_id: "string",
  submission_id: "string",
  schema_version: "string",
  receipt_id: "string",
  request_hash: "string",
  fields_json: "string",
  accepted_at: "string",
  payload_deleted_at: "nullable-string",
} as const;
const classificationShape = {
  id: "string",
  site_id: "string",
  form_id: "string",
  submission_id: "string",
  classification: "string",
  classified_at: "string",
} as const;
const deliveryShape = {
  id: "string",
  site_id: "string",
  form_id: "string",
  submission_id: "string",
  status: "string",
  created_at: "string",
} as const;
const outboxShape = {
  id: "string",
  delivery_id: "string",
  event_type: "string",
  status: "string",
  available_at: "string",
  created_at: "string",
} as const;
const notificationJobShape = {
  delivery_id: "string",
  status: "string",
  attempts: "number",
  available_at: "string",
  first_available_at: "string",
  lease_token: "nullable-string",
  lease_until: "nullable-string",
  last_error_code: "nullable-string",
  provider_reference: "nullable-string",
  delivered_at: "nullable-string",
  updated_at: "string",
} as const;
const acceptanceAuditShape = {
  id: "string",
  site_id: "string",
  event_type: "string",
  subject_id: "string",
  occurred_at: "string",
} as const;
const operationAuditShape = {
  id: "number",
  site_id: "string",
  delivery_id: "string",
  actor_membership_id: "nullable-string",
  action: "string",
  outcome_code: "nullable-string",
  occurred_at: "string",
} as const;

function isPublicFormBackupSnapshot(
  value: unknown,
  siteId: SiteId,
): value is PublicFormBackupSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.version === 1 &&
    snapshot.siteId === siteId &&
    typeof snapshot.createdAt === "string" &&
    everyRow<PublicFormBackupSubmissionRow>(
      snapshot.submissions,
      submissionShape,
    ) &&
    everyRow<PublicFormBackupClassificationRow>(
      snapshot.classifications,
      classificationShape,
      (row) => includesValue(publicFormClassifications, row.classification),
    ) &&
    everyRow<PublicFormBackupDeliveryRow>(
      snapshot.deliveries,
      deliveryShape,
      (row) => includesValue(publicFormDeliveryStatuses, row.status),
    ) &&
    everyRow<PublicFormBackupOutboxRow>(
      snapshot.outboxEvents,
      outboxShape,
      (row) =>
        includesValue(publicFormOutboxEventTypes, row.event_type) &&
        includesValue(publicFormDeliveryStatuses, row.status),
    ) &&
    everyRow<PublicFormBackupNotificationJobRow>(
      snapshot.notificationJobs,
      notificationJobShape,
      (row) =>
        includesValue(publicFormNotificationJobStatuses, row.status),
    ) &&
    everyRow<PublicFormBackupAcceptanceAuditRow>(
      snapshot.acceptanceAuditFacts,
      acceptanceAuditShape,
      (row) => row.event_type === "submission_accepted",
    ) &&
    everyRow<PublicFormBackupOperationAuditRow>(
      snapshot.auditFacts,
      operationAuditShape,
      (row) => includesValue(publicFormOperationAuditActions, row.action),
    )
  );
}

export function createEncryptedR2PublicFormBackupVault({
  bucket,
  recoveryRecipientBase64,
  siteId,
}: {
  bucket: R2BackupBucket;
  recoveryRecipientBase64: string;
  siteId: SiteId;
}): PublicFormBackupVault {
  const prefix = `forms/${siteId}/`;
  let recoveryRecipient: Promise<CryptoKey> | undefined;
  const loadRecoveryRecipient = () => {
    recoveryRecipient ??= Promise.resolve()
      .then(() =>
        crypto.subtle.importKey(
          "spki",
          decodeRecoveryKey(recoveryRecipientBase64),
          { name: "RSA-OAEP", hash: "SHA-256" },
          false,
          ["encrypt"],
        ),
      )
      .catch(() => {
        throw new PublicFormPrivacyError("recovery_backup_unavailable");
      });
    return recoveryRecipient;
  };
  return {
    async saveEncrypted({
      backupId,
      attemptId,
      snapshot,
      createdAt,
      retentionDays,
    }) {
      if (snapshot.siteId !== siteId) {
        throw new Error("form_backup_site_mismatch");
      }
      const expiresAt = new Date(
        Date.parse(createdAt) + retentionDays * 86_400_000,
      ).toISOString();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const rawDataKey = crypto.getRandomValues(new Uint8Array(32));
      const dataKey = await crypto.subtle.importKey(
        "raw",
        rawDataKey,
        { name: "AES-GCM" },
        false,
        ["encrypt"],
      );
      const wrappedKey = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "RSA-OAEP" },
          await loadRecoveryRecipient(),
          rawDataKey,
        ),
      );
      const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: backupAdditionalData(
              siteId,
              backupId,
              createdAt,
              expiresAt,
            ),
          },
          dataKey,
          plaintext,
        ),
      );
      const envelope = new TextEncoder().encode(
        JSON.stringify({
          version: 2,
          algorithm: "RSA-OAEP-256+A256GCM",
          wrappedKey: encodeBase64(wrappedKey),
          iv: encodeBase64(iv),
          ciphertext: encodeBase64(ciphertext),
        }),
      );
      if (
        attemptId !== undefined &&
        !/^[A-Za-z0-9_-]{1,128}$/u.test(attemptId)
      ) {
        throw new Error("form_backup_attempt_invalid");
      }
      const objectKey =
        attemptId === undefined
          ? `${prefix}${backupId}.enc`
          : `${prefix}${backupId}/${attemptId}.enc`;
      const integrityHash = await sha256(envelope);
      await bucket.put(objectKey, envelope, {
        customMetadata: {
          siteId,
          backupId,
          createdAt,
          expiresAt,
          integrityHash,
        },
      });
      return { backupId, objectKey, integrityHash, expiresAt };
    },
    async deleteExpired({ now }) {
      let cursor: string | undefined;
      let deleted = 0;
      do {
        const page = await bucket.list({
          prefix,
          cursor,
          include: ["customMetadata"],
        });
        for (const object of page.objects) {
          const expiresAt = object.customMetadata?.expiresAt;
          if (expiresAt !== undefined && expiresAt <= now) {
            await bucket.delete(object.key);
            deleted += 1;
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return deleted;
    },
  };
}

export function createEncryptedR2PublicFormRecoveryVault({
  bucket,
  recoveryPrivateKeyBase64,
  siteId,
}: {
  bucket: R2BackupBucket;
  recoveryPrivateKeyBase64: string;
  siteId: SiteId;
}): PublicFormRecoveryVault {
  const prefix = `forms/${siteId}/`;
  const recoveryPrivateKey = crypto.subtle
    .importKey(
      "pkcs8",
      decodeRecoveryKey(recoveryPrivateKeyBase64),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    )
    .catch(() => {
      throw new PublicFormPrivacyError("recovery_backup_unavailable");
    });
  return {
    async readDecrypted({ backupId, siteId: requestedSiteId }) {
      if (requestedSiteId !== siteId) {
        throw new PublicFormPrivacyError("recovery_backup_invalid");
      }
      let object;
      try {
        object = await bucket.get(`${prefix}${backupId}.enc`);
      } catch {
        throw new PublicFormPrivacyError("recovery_backup_unavailable");
      }
      if (object === null) {
        throw new PublicFormPrivacyError("recovery_backup_not_found");
      }
      let envelopeBytes: Uint8Array;
      try {
        envelopeBytes = new Uint8Array(await object.arrayBuffer());
      } catch {
        throw new PublicFormPrivacyError("recovery_backup_unavailable");
      }
      try {
        if (
          object.customMetadata?.siteId !== siteId ||
          object.customMetadata.backupId !== backupId ||
          typeof object.customMetadata.createdAt !== "string" ||
          typeof object.customMetadata.expiresAt !== "string" ||
          object.customMetadata.integrityHash !==
            (await sha256(envelopeBytes))
        ) {
          throw new PublicFormPrivacyError("recovery_backup_invalid");
        }
        const envelope: unknown = JSON.parse(
          new TextDecoder().decode(envelopeBytes),
        );
        if (
          typeof envelope !== "object" ||
          envelope === null ||
          !("version" in envelope) ||
          envelope.version !== 2 ||
          !("algorithm" in envelope) ||
          envelope.algorithm !== "RSA-OAEP-256+A256GCM" ||
          !("wrappedKey" in envelope) ||
          typeof envelope.wrappedKey !== "string" ||
          !("iv" in envelope) ||
          typeof envelope.iv !== "string" ||
          !("ciphertext" in envelope) ||
          typeof envelope.ciphertext !== "string"
        ) {
          throw new PublicFormPrivacyError("recovery_backup_invalid");
        }
        const rawDataKey = await crypto.subtle.decrypt(
          { name: "RSA-OAEP" },
          await recoveryPrivateKey,
          decodeBase64(envelope.wrappedKey),
        );
        const dataKey = await crypto.subtle.importKey(
          "raw",
          rawDataKey,
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: decodeBase64(envelope.iv),
            additionalData: backupAdditionalData(
              siteId,
              backupId,
              object.customMetadata.createdAt,
              object.customMetadata.expiresAt,
            ),
          },
          dataKey,
          decodeBase64(envelope.ciphertext),
        );
        const snapshot: unknown = JSON.parse(
          new TextDecoder().decode(plaintext),
        );
        if (!isPublicFormBackupSnapshot(snapshot, siteId)) {
          throw new PublicFormPrivacyError("recovery_backup_invalid");
        }
        if (object.customMetadata.expiresAt <= new Date().toISOString()) {
          throw new PublicFormPrivacyError("recovery_backup_not_found");
        }
        return snapshot;
      } catch (error) {
        if (error instanceof PublicFormPrivacyError) throw error;
        throw new PublicFormPrivacyError("recovery_backup_invalid");
      }
    },
  };
}

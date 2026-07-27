import type { SiteId } from "@foundry/site-definition";

import type {
  ExternalHumanIdentity,
  HumanCapability,
  HumanMembership,
} from "./human-access";
import type { PublicFormReceiptId } from "./public-form";

export type PublicFormRetentionPolicy = Readonly<{
  suspectedSpamDays: number;
  acceptedDays: number;
  auditDays: number;
  backupDays: number;
}>;

export const defaultPublicFormRetentionPolicy: PublicFormRetentionPolicy = Object.freeze({
  suspectedSpamDays: 30,
  acceptedDays: 180,
  auditDays: 365,
  backupDays: 30,
});

export type ExportedPublicFormSubmission = Readonly<{
  receiptId: PublicFormReceiptId;
  formId: string;
  acceptedAt: string;
  classification: "accepted" | "suspected_spam";
  fields: Readonly<Record<string, string>>;
}>;

export type PublicFormBackupSubmissionRow = Readonly<{
  site_id: string;
  form_id: string;
  submission_id: string;
  schema_version: string;
  receipt_id: string;
  request_hash: string;
  fields_json: string;
  accepted_at: string;
  payload_deleted_at: string | null;
}>;
export const publicFormClassifications = [
  "accepted",
  "suspected_spam",
] as const;
export type PublicFormClassification =
  (typeof publicFormClassifications)[number];
export type PublicFormBackupClassificationRow = Readonly<{
  id: string;
  site_id: string;
  form_id: string;
  submission_id: string;
  classification: PublicFormClassification;
  classified_at: string;
}>;
export const publicFormDeliveryStatuses = ["pending", "held"] as const;
export type PublicFormDeliveryStatus =
  (typeof publicFormDeliveryStatuses)[number];
export type PublicFormBackupDeliveryRow = Readonly<{
  id: string;
  site_id: string;
  form_id: string;
  submission_id: string;
  status: PublicFormDeliveryStatus;
  created_at: string;
}>;
export const publicFormOutboxEventTypes = [
  "deliver_submission",
  "hold_for_spam_review",
] as const;
export type PublicFormOutboxEventType =
  (typeof publicFormOutboxEventTypes)[number];
export type PublicFormBackupOutboxRow = Readonly<{
  id: string;
  delivery_id: string;
  event_type: PublicFormOutboxEventType;
  status: PublicFormDeliveryStatus;
  available_at: string;
  created_at: string;
}>;
export const publicFormNotificationJobStatuses = [
  "pending",
  "processing",
  "retry",
  "delivered",
  "failed",
  "held",
] as const;
export type PublicFormNotificationJobStatus =
  (typeof publicFormNotificationJobStatuses)[number];
export type PublicFormBackupNotificationJobRow = Readonly<{
  delivery_id: string;
  status: PublicFormNotificationJobStatus;
  attempts: number;
  available_at: string;
  first_available_at: string;
  lease_token: string | null;
  lease_until: string | null;
  last_error_code: string | null;
  provider_reference: string | null;
  delivered_at: string | null;
  updated_at: string;
}>;
export type PublicFormBackupAcceptanceAuditRow = Readonly<{
  id: string;
  site_id: string;
  event_type: "submission_accepted";
  subject_id: string;
  occurred_at: string;
}>;
export const publicFormOperationAuditActions = [
  "delivery_sent",
  "delivery_retry_scheduled",
  "delivery_failed",
  "delivery_replayed",
  "spam_released",
  "submission_viewed",
  "submission_exported",
  "submission_classified",
  "submission_payload_erased",
  "submission_retention_expired",
] as const;
export type PublicFormOperationAuditAction =
  (typeof publicFormOperationAuditActions)[number];
export type PublicFormBackupOperationAuditRow = Readonly<{
  id: number;
  site_id: string;
  delivery_id: string;
  actor_membership_id: string | null;
  action: PublicFormOperationAuditAction;
  outcome_code: string | null;
  occurred_at: string;
}>;

export type PublicFormBackupSnapshot = Readonly<{
  version: 1;
  siteId: SiteId;
  createdAt: string;
  submissions: ReadonlyArray<PublicFormBackupSubmissionRow>;
  classifications: ReadonlyArray<PublicFormBackupClassificationRow>;
  deliveries: ReadonlyArray<PublicFormBackupDeliveryRow>;
  outboxEvents: ReadonlyArray<PublicFormBackupOutboxRow>;
  notificationJobs: ReadonlyArray<PublicFormBackupNotificationJobRow>;
  acceptanceAuditFacts: ReadonlyArray<PublicFormBackupAcceptanceAuditRow>;
  auditFacts: ReadonlyArray<PublicFormBackupOperationAuditRow>;
}>;

export type PublicFormRestoreEvidence = Readonly<{
  submissions: number;
  auditFacts: number;
  integrityHash: string;
  actorMembershipId: string;
  verifiedAt: string;
}>;

export interface PublicFormPrivacyStore {
  exportSubmission(input: {
    siteId: SiteId;
    receiptId: PublicFormReceiptId;
    actorMembershipId: string;
    now: string;
  }): Promise<ExportedPublicFormSubmission | null>;
  classifySubmission(input: {
    siteId: SiteId;
    receiptId: PublicFormReceiptId;
    classification: "accepted" | "suspected_spam";
    actorMembershipId: string;
    now: string;
  }): Promise<boolean>;
  eraseSubmissionPayload(input: {
    siteId: SiteId;
    receiptId: PublicFormReceiptId;
    reason: "authorized_erasure";
    actorMembershipId: string;
    now: string;
  }): Promise<boolean>;
  applyRetention(input: {
    siteId: SiteId;
    now: string;
    policy: PublicFormRetentionPolicy;
  }): Promise<{ erasedPayloads: number; expiredAuditFacts: number }>;
  latestRetentionAt(input: { siteId: SiteId }): Promise<string | null>;
  recordRetention(input: { siteId: SiteId; appliedAt: string }): Promise<void>;
  createBackupSnapshot(input: {
    siteId: SiteId;
    now: string;
  }): Promise<PublicFormBackupSnapshot>;
  latestBackupAt(input: { siteId: SiteId }): Promise<string | null>;
  recordBackup(input: {
    siteId: SiteId;
    backupId: string;
    objectKey: string;
    integrityHash: string;
    createdAt: string;
    expiresAt: string;
    retentionDays: number;
  }): Promise<void>;
  restoreBackupSnapshot(input: {
    snapshot: PublicFormBackupSnapshot;
    verification: {
      backupId: string;
      actorMembershipId: string;
      verifiedAt: string;
    };
  }): Promise<PublicFormRestoreEvidence>;
  recordRestoreVerification(input: {
    siteId: SiteId;
    backupId: string;
    target: "isolated";
    evidence: PublicFormRestoreEvidence;
  }): Promise<void>;
  clearRestoredSnapshot(input: {
    siteId: SiteId;
    backupId: string;
    evidence: PublicFormRestoreEvidence;
  }): Promise<void>;
}

export interface PublicFormBackupVault {
  saveEncrypted(input: {
    backupId: string;
    snapshot: PublicFormBackupSnapshot;
    createdAt: string;
    retentionDays: number;
  }): Promise<{
    backupId: string;
    objectKey: string;
    integrityHash: string;
    expiresAt: string;
  }>;
  deleteExpired(input: { now: string }): Promise<number>;
}

export interface PublicFormRecoveryVault {
  readDecrypted(input: {
    backupId: string;
    siteId: SiteId;
  }): Promise<PublicFormBackupSnapshot>;
}

export type PublicFormPrivacyApplication = Readonly<{
  queries: Readonly<{
    exportSubmission(input: {
      actor: ExternalHumanIdentity;
      receiptId: PublicFormReceiptId;
    }): Promise<ExportedPublicFormSubmission>;
  }>;
  commands: Readonly<{
    classifySubmission(input: {
      actor: ExternalHumanIdentity;
      receiptId: PublicFormReceiptId;
      classification: "accepted" | "suspected_spam";
    }): Promise<void>;
    eraseSubmission(input: {
      actor: ExternalHumanIdentity;
      receiptId: PublicFormReceiptId;
    }): Promise<void>;
    restoreToIsolatedTarget(input: {
      actor: ExternalHumanIdentity;
      backupId: string;
    }): Promise<PublicFormRestoreEvidence>;
  }>;
}>;

export class PublicFormPrivacyError extends Error {
  constructor(
    readonly code:
      | "submission_not_found"
      | "operation_not_available"
      | "recovery_not_configured"
      | "recovery_target_not_empty"
      | "recovery_target_check_failed"
      | "recovery_integrity_mismatch"
      | "recovery_backup_not_found"
      | "recovery_backup_invalid"
      | "recovery_backup_unavailable"
      | "recovery_backup_too_large"
      | "recovery_verification_pending"
      | "recovery_cleanup_pending",
  ) {
    super(`public_form_privacy_${code}`);
    this.name = "PublicFormPrivacyError";
  }
}

export function createPublicFormPrivacyApplication({
  siteId,
  store,
  vault,
  recoveryVault,
  recoveryStore,
  authorize,
  clock = () => new Date(),
}: {
  siteId: SiteId;
  store: PublicFormPrivacyStore;
  vault?: PublicFormBackupVault;
  recoveryVault?: PublicFormRecoveryVault;
  recoveryStore?: PublicFormPrivacyStore;
  authorize(
    actor: ExternalHumanIdentity,
    capability: HumanCapability,
  ): Promise<HumanMembership>;
  clock?: () => Date;
}): PublicFormPrivacyApplication {
  async function owner(actor: ExternalHumanIdentity) {
    return authorize(actor, "forms.data.manage");
  }
  const queries: PublicFormPrivacyApplication["queries"] = Object.freeze({
    async exportSubmission({ actor, receiptId }) {
      const membership = await owner(actor);
      const exported = await store.exportSubmission({
        siteId,
        receiptId,
        actorMembershipId: membership.id,
        now: clock().toISOString(),
      });
      if (exported === null) {
        throw new PublicFormPrivacyError("submission_not_found");
      }
      return exported;
    },
  });
  const commands: PublicFormPrivacyApplication["commands"] = Object.freeze({
    async classifySubmission({ actor, receiptId, classification }) {
      const membership = await owner(actor);
      const changed = await store.classifySubmission({
        siteId,
        receiptId,
        classification,
        actorMembershipId: membership.id,
        now: clock().toISOString(),
      });
      if (!changed) {
        throw new PublicFormPrivacyError("operation_not_available");
      }
    },
    async eraseSubmission({ actor, receiptId }) {
      const membership = await owner(actor);
      const erased = await store.eraseSubmissionPayload({
        siteId,
        receiptId,
        reason: "authorized_erasure",
        actorMembershipId: membership.id,
        now: clock().toISOString(),
      });
      if (!erased) {
        throw new PublicFormPrivacyError("operation_not_available");
      }
    },
    async restoreToIsolatedTarget({ actor, backupId }) {
      const membership = await owner(actor);
      if (recoveryVault === undefined || recoveryStore === undefined) {
        throw new PublicFormPrivacyError("recovery_not_configured");
      }
      const snapshot = await recoveryVault.readDecrypted({ backupId, siteId });
      const verifiedAt = clock().toISOString();
      const evidence = await recoveryStore.restoreBackupSnapshot({
        snapshot,
        verification: {
          backupId,
          actorMembershipId: membership.id,
          verifiedAt,
        },
      });
      try {
        await store.recordRestoreVerification({
          siteId,
          backupId,
          target: "isolated",
          evidence,
        });
      } catch {
        throw new PublicFormPrivacyError("recovery_verification_pending");
      }
      try {
        await recoveryStore.clearRestoredSnapshot({
          siteId,
          backupId,
          evidence,
        });
      } catch {
        throw new PublicFormPrivacyError("recovery_cleanup_pending");
      }
      return evidence;
    },
  });
  return Object.freeze({
    queries,
    commands,
  });
}

export async function runPublicFormRetentionMaintenance({
  siteId,
  store,
  now,
  policy = defaultPublicFormRetentionPolicy,
}: {
  siteId: SiteId;
  store: PublicFormPrivacyStore;
  now: Date;
  policy?: PublicFormRetentionPolicy;
}) {
  const timestamp = now.toISOString();
  const latestRetentionAt = await store.latestRetentionAt({ siteId });
  if (
    latestRetentionAt !== null &&
    Date.parse(timestamp) - Date.parse(latestRetentionAt) < 24 * 60 * 60 * 1_000
  ) {
    return { erasedPayloads: 0, expiredAuditFacts: 0, applied: false };
  }
  const retention = await store.applyRetention({
    siteId,
    now: timestamp,
    policy,
  });
  await store.recordRetention({ siteId, appliedAt: timestamp });
  return { ...retention, applied: true };
}

export async function runPublicFormBackupMaintenance({
  siteId,
  store,
  vault,
  now,
  policy = defaultPublicFormRetentionPolicy,
}: {
  siteId: SiteId;
  store: PublicFormPrivacyStore;
  vault?: PublicFormBackupVault;
  now: Date;
  policy?: PublicFormRetentionPolicy;
}) {
  const timestamp = now.toISOString();
  if (vault === undefined) {
    return { backupId: null, expiredBackups: 0 };
  }
  const expiredBackups = await vault.deleteExpired({ now: timestamp });
  const latestBackupAt = await store.latestBackupAt({ siteId });
  if (
    latestBackupAt !== null &&
    Date.parse(timestamp) - Date.parse(latestBackupAt) < 24 * 60 * 60 * 1_000
  ) {
    return { backupId: null, expiredBackups };
  }
  const checkpoint =
    latestBackupAt === null
      ? "initial"
      : latestBackupAt.replaceAll(/[^0-9]/gu, "");
  const backupId = `backup-${siteId}-after-${checkpoint}`;
  const snapshot = await store.createBackupSnapshot({
    siteId,
    now: timestamp,
  });
  const saved = await vault.saveEncrypted({
    backupId,
    snapshot,
    createdAt: timestamp,
    retentionDays: policy.backupDays,
  });
  await store.recordBackup({
    siteId,
    ...saved,
    createdAt: timestamp,
    retentionDays: policy.backupDays,
  });
  return { backupId, expiredBackups };
}

export async function runPublicFormPrivacyMaintenance(
  input: Parameters<typeof runPublicFormRetentionMaintenance>[0] &
    Pick<Parameters<typeof runPublicFormBackupMaintenance>[0], "vault">,
) {
  const retention = await runPublicFormRetentionMaintenance(input);
  const backup = await runPublicFormBackupMaintenance(input);
  return { ...retention, ...backup };
}

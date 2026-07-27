import {
  defaultPublicFormRetentionPolicy,
  runPublicFormBackupMaintenance,
  runPublicFormRetentionMaintenance,
  type PublicFormBackupVault,
  type PublicFormRetentionPolicy,
} from "@foundry/application";
import { referenceSiteDefinition } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1PublicFormPrivacyStore } from "./d1-public-form-privacy-store";
import {
  createEncryptedR2PublicFormBackupVault,
  type R2BackupBucket,
} from "./encrypted-r2-form-backup-vault";

export type PublicFormPrivacyEnvironment = Readonly<{
  FOUNDRY_DB?: D1DatabaseBinding;
  FOUNDRY_FORM_BACKUPS?: R2BackupBucket;
  FOUNDRY_FORM_BACKUP_RECIPIENT?: string;
  FOUNDRY_FORM_RETENTION_SPAM_DAYS?: string;
  FOUNDRY_FORM_RETENTION_ACCEPTED_DAYS?: string;
  FOUNDRY_FORM_RETENTION_AUDIT_DAYS?: string;
  FOUNDRY_FORM_RETENTION_BACKUP_DAYS?: string;
}>;

function retentionDays(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]{0,3}$/u.test(value)) {
    throw new Error("form_retention_configuration_invalid");
  }
  const days = Number(value);
  if (days > 3_650) {
    throw new Error("form_retention_configuration_invalid");
  }
  return days;
}

export function publicFormRetentionPolicyFromEnvironment(
  environment: PublicFormPrivacyEnvironment,
): PublicFormRetentionPolicy {
  return {
    suspectedSpamDays: retentionDays(
      environment.FOUNDRY_FORM_RETENTION_SPAM_DAYS,
      defaultPublicFormRetentionPolicy.suspectedSpamDays,
    ),
    acceptedDays: retentionDays(
      environment.FOUNDRY_FORM_RETENTION_ACCEPTED_DAYS,
      defaultPublicFormRetentionPolicy.acceptedDays,
    ),
    auditDays: retentionDays(
      environment.FOUNDRY_FORM_RETENTION_AUDIT_DAYS,
      defaultPublicFormRetentionPolicy.auditDays,
    ),
    backupDays: retentionDays(
      environment.FOUNDRY_FORM_RETENTION_BACKUP_DAYS,
      defaultPublicFormRetentionPolicy.backupDays,
    ),
  };
}

export function createConfiguredPublicFormPrivacy(
  environment: PublicFormPrivacyEnvironment,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new Error("form_privacy_not_configured");
  }
  const createVault = () => {
    if (
      environment.FOUNDRY_FORM_BACKUPS === undefined ||
      environment.FOUNDRY_FORM_BACKUP_RECIPIENT === undefined
    ) {
      return undefined;
    }
    return createEncryptedR2PublicFormBackupVault({
      bucket: environment.FOUNDRY_FORM_BACKUPS,
      recoveryRecipientBase64:
        environment.FOUNDRY_FORM_BACKUP_RECIPIENT,
      siteId: referenceSiteDefinition.site.id,
    });
  };
  const hasVaultConfiguration =
    environment.FOUNDRY_FORM_BACKUPS !== undefined &&
    environment.FOUNDRY_FORM_BACKUP_RECIPIENT !== undefined;
  const hasPartialVaultConfiguration =
    (environment.FOUNDRY_FORM_BACKUPS !== undefined) !==
    (environment.FOUNDRY_FORM_BACKUP_RECIPIENT !== undefined);
  if (hasPartialVaultConfiguration) {
    throw new Error("form_backup_not_configured");
  }
  const requireVault = () => {
    const vault = createVault();
    if (vault === undefined) throw new Error("form_backup_not_configured");
    return vault;
  };
  const vault: PublicFormBackupVault | undefined = hasVaultConfiguration
    ? {
        saveEncrypted: (input) => requireVault().saveEncrypted(input),
        deleteExpired: (input) => requireVault().deleteExpired(input),
      }
    : undefined;
  return {
    store: createD1PublicFormPrivacyStore(environment.FOUNDRY_DB),
    vault,
  };
}

export function createConfiguredPublicFormRetention(
  environment: PublicFormPrivacyEnvironment,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new Error("form_privacy_not_configured");
  }
  return {
    store: createD1PublicFormPrivacyStore(environment.FOUNDRY_DB),
    policy: publicFormRetentionPolicyFromEnvironment(environment),
  };
}

export async function runPublicFormRetentionMaintenanceIfDue(
  environment: PublicFormPrivacyEnvironment,
) {
  const { store, policy } = createConfiguredPublicFormRetention(environment);
  return runPublicFormRetentionMaintenance({
    siteId: referenceSiteDefinition.site.id,
    store,
    now: new Date(),
    policy,
  });
}

export async function runPublicFormBackupMaintenanceIfDue(
  environment: PublicFormPrivacyEnvironment,
) {
  const { store, vault } = createConfiguredPublicFormPrivacy(environment);
  return runPublicFormBackupMaintenance({
    siteId: referenceSiteDefinition.site.id,
    store,
    vault,
    now: new Date(),
    createBackupId: () => `backup-${crypto.randomUUID()}`,
    policy: publicFormRetentionPolicyFromEnvironment(environment),
  });
}

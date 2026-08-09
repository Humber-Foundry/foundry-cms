import {
  createHumanMembershipId,
  createHumanUserId,
  createPublicFormPrivacyApplication,
  type ExternalHumanIdentity,
  type HumanCapability,
  type HumanMembership,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1PublicFormPrivacyStore } from "./d1-public-form-privacy-store";
import {
  createEncryptedR2PublicFormRecoveryVault,
  type R2BackupBucket,
} from "./encrypted-r2-form-backup-vault";

type OwnerRow = Readonly<{
  id: string;
  user_id: string;
  email: string;
  identity_issuer: string;
  identity_subject: string;
  role: string;
  status: string;
}>;

export async function runPublicFormRecoveryOperator({
  primaryDatabase,
  recoveryDatabase,
  backupBucket,
  recoveryPrivateKeyBase64,
  backupId,
  actorMembershipId,
  clock = () => new Date(),
}: {
  primaryDatabase: D1DatabaseBinding;
  recoveryDatabase: D1DatabaseBinding;
  backupBucket: R2BackupBucket;
  recoveryPrivateKeyBase64: string;
  backupId: string;
  actorMembershipId: string;
  clock?: () => Date;
}) {
  const siteId = installedSiteDefinition.site.id;
  const row = await primaryDatabase
    .prepare(
      `SELECT id, user_id, email, identity_issuer, identity_subject, role, status
       FROM human_memberships
       WHERE id = ?1 AND site_id = ?2
         AND role = 'owner' AND status = 'active'
       LIMIT 1`,
    )
    .bind(actorMembershipId, siteId)
    .first<OwnerRow>();
  if (row === null) throw new Error("form_recovery_active_owner_required");

  const membership: HumanMembership = {
    id: createHumanMembershipId(row.id),
    siteId,
    userId: createHumanUserId(row.user_id),
    email: row.email,
    identityBinding: {
      issuer: row.identity_issuer,
      subject: row.identity_subject,
    },
    role: "owner",
    status: "active",
  };
  const actor: ExternalHumanIdentity = {
    binding: membership.identityBinding,
    email: membership.email,
    nonce: `recovery:${backupId}`,
  };
  const authorize = async (
    candidate: ExternalHumanIdentity,
    capability: HumanCapability,
  ) => {
    if (
      capability !== "forms.data.manage" ||
      candidate.binding.issuer !== membership.identityBinding.issuer ||
      candidate.binding.subject !== membership.identityBinding.subject
    ) {
      throw new Error("form_recovery_not_authorized");
    }
    return membership;
  };

  const application = createPublicFormPrivacyApplication({
    siteId,
    store: createD1PublicFormPrivacyStore(primaryDatabase),
    recoveryStore: createD1PublicFormPrivacyStore(recoveryDatabase),
    recoveryVault: createEncryptedR2PublicFormRecoveryVault({
      bucket: backupBucket,
      recoveryPrivateKeyBase64,
      siteId,
    }),
    authorize,
    clock,
  });
  return application.commands.restoreToIsolatedTarget({ actor, backupId });
}

import { describe, expect, it, vi } from "vitest";

import { createSiteId } from "@foundry/site-definition";

import { createHumanMembershipId } from "./human-access";
import {
  createPublicFormReceiptId,
} from "./public-form";
import {
  createPublicFormPrivacyApplication,
  defaultPublicFormRetentionPolicy,
  runPublicFormPrivacyMaintenance,
  type PublicFormBackupVault,
  type PublicFormPrivacyStore,
} from "./public-form-privacy";

const siteId = createSiteId("site_reference");
const receiptId = createPublicFormReceiptId("receipt-48");
const owner = {
  binding: { issuer: "issuer", subject: "owner" },
  email: "owner@example.com",
  nonce: "nonce",
};

function store(
  overrides: Partial<PublicFormPrivacyStore> = {},
): PublicFormPrivacyStore {
  return {
    exportSubmission: vi.fn().mockResolvedValue({
      receiptId,
      formId: "contact",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      classification: "accepted",
      fields: { message: "private" },
    }),
    classifySubmission: vi.fn().mockResolvedValue(true),
    eraseSubmissionPayload: vi.fn().mockResolvedValue(true),
    applyRetention: vi.fn().mockResolvedValue({
      erasedPayloads: 1,
      expiredAuditFacts: 0,
    }),
    latestRetentionAt: vi.fn().mockResolvedValue(null),
    recordRetention: vi.fn().mockResolvedValue(undefined),
    createBackupSnapshot: vi.fn().mockResolvedValue({
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
    }),
    latestBackupAt: vi.fn().mockResolvedValue(null),
    claimBackup: vi.fn().mockResolvedValue(true),
    recordBackup: vi.fn().mockResolvedValue(undefined),
    restoreBackupSnapshot: vi.fn().mockResolvedValue({
      submissions: 0,
      auditFacts: 0,
      integrityHash: "sha256:empty",
      actorMembershipId: "membership-owner",
      verifiedAt: "2026-07-28T00:00:00.000Z",
    }),
    recordRestoreVerification: vi.fn().mockResolvedValue(undefined),
    clearRestoredSnapshot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("public form privacy application", () => {
  it("requires owner data authority and audits exports through the store", async () => {
    const privacyStore = store();
    const authorize = vi.fn().mockResolvedValue({
      id: createHumanMembershipId("membership-owner"),
      role: "owner",
    });
    const application = createPublicFormPrivacyApplication({
      siteId,
      store: privacyStore,
      authorize,
      clock: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    await expect(
      application.queries.exportSubmission({ actor: owner, receiptId }),
    ).resolves.toMatchObject({ fields: { message: "private" } });
    expect(authorize).toHaveBeenCalledWith(owner, "forms.data.manage");
    expect(privacyStore.exportSubmission).toHaveBeenCalledWith({
      siteId,
      receiptId,
      actorMembershipId: "membership-owner",
      now: "2026-07-27T12:00:00.000Z",
    });
  });

  it("uses bounded defaults for payload, audit, and backup retention", () => {
    expect(defaultPublicFormRetentionPolicy).toEqual({
      suspectedSpamDays: 30,
      acceptedDays: 180,
      auditDays: 365,
      backupDays: 30,
    });
  });

  it("runs payload and audit retention when backup storage is not configured", async () => {
    const privacyStore = store();

    await expect(
      runPublicFormPrivacyMaintenance({
        siteId,
        store: privacyStore,
        now: new Date("2026-07-27T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ backupId: null, expiredBackups: 0 });
    expect(privacyStore.applyRetention).toHaveBeenCalledOnce();
    expect(privacyStore.recordRetention).toHaveBeenCalledWith({
      siteId,
      appliedAt: "2026-07-27T00:00:00.000Z",
    });
    expect(privacyStore.createBackupSnapshot).not.toHaveBeenCalled();
  });

  it("skips day-scale retention work until its daily checkpoint is due", async () => {
    const privacyStore = store({
      latestRetentionAt: vi
        .fn()
        .mockResolvedValue("2026-07-27T00:00:00.000Z"),
    });

    await expect(
      runPublicFormPrivacyMaintenance({
        siteId,
        store: privacyStore,
        now: new Date("2026-07-27T00:05:00.000Z"),
      }),
    ).resolves.toMatchObject({ applied: false });
    expect(privacyStore.applyRetention).not.toHaveBeenCalled();
    expect(privacyStore.recordRetention).not.toHaveBeenCalled();
  });

  it("encrypts a backup before recording it and restores only into the supplied isolated store", async () => {
    const primary = store();
    const isolated = store();
    const vault: PublicFormBackupVault = {
      saveEncrypted: vi.fn(async (input) => ({
        backupId: input.backupId,
        objectKey: `forms/site_reference/${input.backupId}.enc`,
        integrityHash: "sha256:ciphertext",
        expiresAt: "2026-08-26T00:00:00.000Z",
      })),
      deleteExpired: vi.fn().mockResolvedValue(0),
    };
    const recoveryVault = {
      readDecrypted: vi.fn().mockResolvedValue(
        await primary.createBackupSnapshot({
          siteId,
          now: "2026-07-27T00:00:00.000Z",
        }),
      ),
    };

    await runPublicFormPrivacyMaintenance({
      siteId,
      store: primary,
      vault,
      now: new Date("2026-07-27T00:00:00.000Z"),
    });
    expect(vault.saveEncrypted).toHaveBeenCalledOnce();
    expect(primary.recordBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        backupId: "backup-site_reference-after-initial",
        checkpoint: "initial",
        leaseToken: expect.any(String),
        retentionDays: 30,
      }),
    );

    const application = createPublicFormPrivacyApplication({
      siteId,
      store: primary,
      vault,
      recoveryVault,
      recoveryStore: isolated,
      authorize: vi.fn().mockResolvedValue({
        id: createHumanMembershipId("membership-owner"),
        role: "owner",
      }),
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    await application.commands.restoreToIsolatedTarget({
      actor: owner,
      backupId: "backup-48",
    });
    expect(isolated.restoreBackupSnapshot).toHaveBeenCalledWith({
      snapshot: expect.objectContaining({ siteId }),
      verification: {
        backupId: "backup-48",
        actorMembershipId: "membership-owner",
        verifiedAt: "2026-07-28T00:00:00.000Z",
      },
    });
    expect(primary.restoreBackupSnapshot).not.toHaveBeenCalled();
    expect(primary.recordRestoreVerification).toHaveBeenCalledWith(
      expect.objectContaining({ backupId: "backup-48" }),
    );
    expect(isolated.clearRestoredSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ backupId: "backup-48" }),
    );
  });

  it("sweeps expiry before a checkpoint-stable backup retry can fail", async () => {
    const events: string[] = [];
    const privacyStore = store();
    const vault: PublicFormBackupVault = {
      async deleteExpired() {
        events.push("expiry");
        return 2;
      },
      async saveEncrypted(input) {
        events.push(`save:${input.backupId}`);
        throw new Error("r2_unavailable");
      },
    };

    for (const now of [
      "2026-07-27T23:59:00.000Z",
      "2026-07-28T00:04:00.000Z",
    ]) {
      await expect(
        runPublicFormPrivacyMaintenance({
          siteId,
          store: privacyStore,
          vault,
          now: new Date(now),
        }),
      ).rejects.toThrow("r2_unavailable");
    }
    expect(events).toEqual([
      "expiry",
      "save:backup-site_reference-after-initial",
      "expiry",
      "save:backup-site_reference-after-initial",
    ]);
    expect(privacyStore.recordBackup).not.toHaveBeenCalled();
  });

  it("allows only one overlapping scheduler run to write the checkpoint object", async () => {
    let claimed = false;
    const privacyStore = store({
      claimBackup: vi.fn(async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      }),
    });
    const vault: PublicFormBackupVault = {
      deleteExpired: vi.fn().mockResolvedValue(0),
      saveEncrypted: vi.fn(async (input) => ({
        backupId: input.backupId,
        objectKey: `forms/site_reference/${input.backupId}.enc`,
        integrityHash: "sha256:winner",
        expiresAt: "2026-08-26T00:00:00.000Z",
      })),
    };

    const results = await Promise.all([
      runPublicFormPrivacyMaintenance({
        siteId,
        store: privacyStore,
        vault,
        now: new Date("2026-07-27T00:00:00.000Z"),
        createBackupLeaseToken: () => "lease-a",
      }),
      runPublicFormPrivacyMaintenance({
        siteId,
        store: privacyStore,
        vault,
        now: new Date("2026-07-27T00:00:00.000Z"),
        createBackupLeaseToken: () => "lease-b",
      }),
    ]);

    expect(results.map((result) => result.backupId).sort()).toEqual([
      "backup-site_reference-after-initial",
      null,
    ]);
    expect(vault.saveEncrypted).toHaveBeenCalledOnce();
    expect(privacyStore.recordBackup).toHaveBeenCalledOnce();
  });

  it("can resume the primary verification write after target promotion", async () => {
    const primary = store({
      recordRestoreVerification: vi
        .fn()
        .mockRejectedValueOnce(new Error("primary_unavailable"))
        .mockResolvedValue(undefined),
    });
    const isolated = store({
      restoreBackupSnapshot: vi
        .fn()
        .mockResolvedValue({
          submissions: 0,
          auditFacts: 0,
          integrityHash: "sha256:empty",
          actorMembershipId: "membership-original-owner",
          verifiedAt: "2026-07-27T23:59:00.000Z",
        }),
    });
    const snapshot = await primary.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const application = createPublicFormPrivacyApplication({
      siteId,
      store: primary,
      vault: {
        saveEncrypted: vi.fn(),
        deleteExpired: vi.fn(),
      },
      recoveryVault: {
        readDecrypted: vi.fn().mockResolvedValue(snapshot),
      },
      recoveryStore: isolated,
      authorize: vi.fn().mockResolvedValue({
        id: createHumanMembershipId("membership-owner"),
        role: "owner",
      }),
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    });

    await expect(
      application.commands.restoreToIsolatedTarget({
        actor: owner,
        backupId: "backup-48",
      }),
    ).rejects.toMatchObject({ code: "recovery_verification_pending" });
    await expect(
      application.commands.restoreToIsolatedTarget({
        actor: owner,
        backupId: "backup-48",
      }),
    ).resolves.toMatchObject({ integrityHash: "sha256:empty" });
    expect(isolated.restoreBackupSnapshot).toHaveBeenCalledTimes(2);
    expect(primary.recordRestoreVerification).toHaveBeenCalledTimes(2);
    expect(isolated.clearRestoredSnapshot).toHaveBeenCalledTimes(1);
    expect(primary.recordRestoreVerification).toHaveBeenLastCalledWith({
      siteId,
      backupId: "backup-48",
      target: "isolated",
      evidence: expect.objectContaining({
        actorMembershipId: "membership-original-owner",
        verifiedAt: "2026-07-27T23:59:00.000Z",
      }),
    });
  });

  it("reports isolated cleanup as retryable after verification is mirrored", async () => {
    const primary = store();
    const isolated = store({
      clearRestoredSnapshot: vi
        .fn()
        .mockRejectedValue(new Error("cleanup_unavailable")),
    });
    const snapshot = await primary.createBackupSnapshot({
      siteId,
      now: "2026-07-27T00:00:00.000Z",
    });
    const application = createPublicFormPrivacyApplication({
      siteId,
      store: primary,
      recoveryVault: {
        readDecrypted: vi.fn().mockResolvedValue(snapshot),
      },
      recoveryStore: isolated,
      authorize: vi.fn().mockResolvedValue({
        id: createHumanMembershipId("membership-owner"),
        role: "owner",
      }),
      clock: () => new Date("2026-07-28T00:00:00.000Z"),
    });

    await expect(
      application.commands.restoreToIsolatedTarget({
        actor: owner,
        backupId: "backup-48",
      }),
    ).rejects.toMatchObject({ code: "recovery_cleanup_pending" });
    expect(primary.recordRestoreVerification).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from "vitest";

import {
  createConfiguredPublicFormPrivacy,
  createConfiguredPublicFormRetention,
  publicFormRetentionPolicyFromEnvironment,
} from "./public-form-privacy-runtime";

describe("public form retention configuration", () => {
  it("uses product defaults and accepts bounded installation overrides", () => {
    expect(publicFormRetentionPolicyFromEnvironment({})).toEqual({
      suspectedSpamDays: 30,
      acceptedDays: 180,
      auditDays: 365,
      backupDays: 30,
    });
    expect(
      publicFormRetentionPolicyFromEnvironment({
        FOUNDRY_FORM_RETENTION_SPAM_DAYS: "14",
        FOUNDRY_FORM_RETENTION_ACCEPTED_DAYS: "90",
        FOUNDRY_FORM_RETENTION_AUDIT_DAYS: "730",
        FOUNDRY_FORM_RETENTION_BACKUP_DAYS: "60",
      }),
    ).toEqual({
      suspectedSpamDays: 14,
      acceptedDays: 90,
      auditDays: 730,
      backupDays: 60,
    });
  });

  it("fails closed for invalid or unbounded durations", () => {
    expect(() =>
      publicFormRetentionPolicyFromEnvironment({
        FOUNDRY_FORM_RETENTION_SPAM_DAYS: "0",
      }),
    ).toThrow("form_retention_configuration_invalid");
    expect(() =>
      publicFormRetentionPolicyFromEnvironment({
        FOUNDRY_FORM_RETENTION_AUDIT_DAYS: "3651",
      }),
    ).toThrow("form_retention_configuration_invalid");
  });

  it("keeps D1-only privacy actions available without backup configuration", () => {
    const configured = createConfiguredPublicFormPrivacy({
      FOUNDRY_DB: {
        prepare() {
          throw new Error("not_called");
        },
        async batch() {
          throw new Error("not_called");
        },
      },
    });

    expect(configured.store).toBeDefined();
    expect(configured.vault).toBeUndefined();
  });

  it("rejects a bucket or key configured without its required counterpart", () => {
    const database = {
      prepare() {
        throw new Error("not_called");
      },
      async batch() {
        throw new Error("not_called");
      },
    };
    expect(() =>
      createConfiguredPublicFormPrivacy({
        FOUNDRY_DB: database,
        FOUNDRY_FORM_BACKUPS: {} as never,
      }),
    ).toThrow("form_backup_not_configured");
    expect(() =>
      createConfiguredPublicFormPrivacy({
        FOUNDRY_DB: database,
        FOUNDRY_FORM_BACKUP_RECIPIENT: "missing-bucket",
      }),
    ).toThrow("form_backup_not_configured");
  });

  it("keeps retention independent from partial backup configuration", () => {
    const database = {
      prepare() {
        throw new Error("not_called");
      },
      async batch() {
        throw new Error("not_called");
      },
    };

    expect(
      createConfiguredPublicFormRetention({
        FOUNDRY_DB: database,
        FOUNDRY_FORM_BACKUPS: {} as never,
      }),
    ).toMatchObject({
      store: expect.any(Object),
      policy: {
        suspectedSpamDays: 30,
        acceptedDays: 180,
        auditDays: 365,
        backupDays: 30,
      },
    });
  });
});

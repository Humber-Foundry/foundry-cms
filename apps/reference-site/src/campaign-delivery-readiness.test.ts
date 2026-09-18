import { describe, expect, it } from "vitest";

import {
  campaignDeliverySettingNames,
  campaignDeliverySetupGuide,
  listMissingCampaignDeliverySettings,
} from "./campaign-delivery-readiness";
import type { HumanAccessEnvironment } from "./human-access-configuration";

const configuredEnvironment: HumanAccessEnvironment = Object.freeze({
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender_primary",
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v1",
  FOUNDRY_CAMPAIGN_LEGAL_NAME: "Example Publisher",
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "1 Example Street",
  FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.test/contact",
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
    "https://example.test/newsletter/unsubscribe",
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: "n".repeat(32),
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: "s".repeat(32),
  FOUNDRY_BREVO_API_KEY: "example-api-key",
  FOUNDRY_CAMPAIGN_TEST_PROOF_KEY: "example-proof-key",
  FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN: "w".repeat(32),
  FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT: "a".repeat(64),
  FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON: JSON.stringify({
    classification: "client_owned",
    evidenceId: "evidence-1",
    accountScopeFingerprint: "a".repeat(64),
    verifiedAt: "2026-01-01T00:00:00.000Z",
  }),
  FOUNDRY_BREVO_SENDERS_JSON: JSON.stringify({
    sender_primary: {
      id: 1,
      email: "news@example.test",
      name: "Example Publisher",
    },
  }),
  FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON: JSON.stringify({
    "membership-owner": "owner@example.test",
  }),
});

function environmentWithout(
  name: keyof HumanAccessEnvironment,
): HumanAccessEnvironment {
  const { [name]: _removed, ...rest } = configuredEnvironment;
  return rest;
}

describe("campaign delivery readiness settings", () => {
  it("reports nothing missing when every delivery setting is installed", () => {
    expect(listMissingCampaignDeliverySettings(configuredEnvironment)).toEqual(
      [],
    );
  });

  it("reports every delivery setting when none is installed", () => {
    expect(listMissingCampaignDeliverySettings({})).toEqual([
      ...campaignDeliverySettingNames,
    ]);
  });

  it("names each absent setting one at a time", () => {
    for (const name of campaignDeliverySettingNames) {
      expect(
        listMissingCampaignDeliverySettings(
          environmentWithout(name as keyof HumanAccessEnvironment),
        ),
      ).toEqual([name]);
    }
  });

  it("treats a blank setting as missing", () => {
    expect(
      listMissingCampaignDeliverySettings({
        ...configuredEnvironment,
        FOUNDRY_BREVO_API_KEY: "   ",
      }),
    ).toEqual(["FOUNDRY_BREVO_API_KEY"]);
  });

  it("rejects a webhook token shorter than 32 characters", () => {
    expect(
      listMissingCampaignDeliverySettings({
        ...configuredEnvironment,
        FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN: "w".repeat(31),
      }),
    ).toEqual(["FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN"]);
  });

  it("rejects a delivery secret shorter than 32 characters", () => {
    expect(
      listMissingCampaignDeliverySettings({
        ...configuredEnvironment,
        FOUNDRY_NEWSLETTER_DELIVERY_SECRET: "n".repeat(31),
      }),
    ).toEqual(["FOUNDRY_NEWSLETTER_DELIVERY_SECRET"]);
  });

  it("rejects a subscriber identity secret shorter than 32 characters", () => {
    expect(
      listMissingCampaignDeliverySettings({
        ...configuredEnvironment,
        FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: "s".repeat(31),
      }),
    ).toEqual(["FOUNDRY_SUBSCRIBER_IDENTITY_SECRET"]);
  });

  it("rejects an account scope fingerprint that is not 64 hex characters", () => {
    for (const value of ["A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
      expect(
        listMissingCampaignDeliverySettings({
          ...configuredEnvironment,
          FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT: value,
        }),
      ).toEqual(["FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT"]);
    }
  });

  it("ignores the compliance settings, which are not delivery secrets", () => {
    // The compliance footer is stored on every campaign revision, so Foundry
    // never stands in for these. They are required whether or not delivery is
    // connected, and they are not part of this report.
    const { FOUNDRY_CAMPAIGN_LEGAL_NAME: _name, ...rest } =
      configuredEnvironment;
    expect(listMissingCampaignDeliverySettings(rest)).toEqual([]);
  });

  it("does not require provisioning evidence, which marks an evaluation account", () => {
    const { FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON: _evidence, ...rest } =
      configuredEnvironment;
    expect(listMissingCampaignDeliverySettings(rest)).toEqual([]);
  });

  it("rejects malformed or empty sender and recipient mappings", () => {
    expect(
      listMissingCampaignDeliverySettings({
        ...configuredEnvironment,
        FOUNDRY_BREVO_SENDERS_JSON: "not json",
      }),
    ).toEqual(["FOUNDRY_BREVO_SENDERS_JSON"]);
    expect(
      listMissingCampaignDeliverySettings({
        ...configuredEnvironment,
        FOUNDRY_BREVO_SENDERS_JSON: "{}",
      }),
    ).toEqual(["FOUNDRY_BREVO_SENDERS_JSON"]);
    expect(
      listMissingCampaignDeliverySettings({
        ...configuredEnvironment,
        FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON: "[]",
      }),
    ).toEqual(["FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON"]);
  });

  it("returns setting names only, never a configured value", () => {
    const missing = listMissingCampaignDeliverySettings({});
    const joined = missing.join(" ");
    for (const value of Object.values(configuredEnvironment)) {
      if (typeof value !== "string") continue;
      expect(joined).not.toContain(value);
    }
    for (const name of missing) {
      expect(name.startsWith("FOUNDRY_")).toBe(true);
    }
  });

  it("points at the setup document inside this repository", () => {
    expect(campaignDeliverySetupGuide).toBe(
      "docs/operations/brevo-test-delivery-readiness.md",
    );
  });
});

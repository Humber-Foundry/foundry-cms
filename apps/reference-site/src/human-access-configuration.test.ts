import { describe, expect, it } from "vitest";

import {
  createDeferredAccessEligibilitySynchronizer,
  HumanAccessConfigurationError,
  readCampaignChannelConfiguration,
  readSubscriberIdentityKeySecret,
} from "./human-access-configuration";

describe("human access synchronization configuration", () => {
  it("defers missing Access policy settings until synchronization starts", async () => {
    const synchronizer =
      createDeferredAccessEligibilitySynchronizer({});

    await expect(
      synchronizer.replaceExactEmailEligibility([
        "owner@example.com",
      ]),
    ).rejects.toBeInstanceOf(HumanAccessConfigurationError);
  });

  it("requires a dedicated strong subscriber identity key", () => {
    expect(() => readSubscriberIdentityKeySecret({})).toThrow(
      HumanAccessConfigurationError,
    );
    expect(() =>
      readSubscriberIdentityKeySecret({
        FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: "too-short",
      }),
    ).toThrow(HumanAccessConfigurationError);
    expect(
      readSubscriberIdentityKeySecret({
        FOUNDRY_SUBSCRIBER_IDENTITY_SECRET:
          "production-subscriber-identity-secret",
      }),
    ).toBe("production-subscriber-identity-secret");
  });

  it("builds campaign sender and compliance material only from installation settings", () => {
    expect(
      readCampaignChannelConfiguration({
        FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender-primary",
        FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v4",
        FOUNDRY_CAMPAIGN_LEGAL_NAME: "Example Society",
        FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "10 Main Street, Victoria, BC",
        FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.org/contact",
        FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
          "https://example.org/newsletter/unsubscribe",
      }),
    ).toEqual({
      senderIdentityId: "sender-primary",
      complianceFooter: {
        version: "footer-v4",
        content:
          "Example Society · 10 Main Street, Victoria, BC · " +
          "Contact: https://example.org/contact · " +
          "Unsubscribe: https://example.org/newsletter/unsubscribe",
      },
      audienceDefinition: {
        id: "canonical-consent-and-suppression",
        version: 1,
      },
    });
    expect(() => readCampaignChannelConfiguration({})).toThrow(
      HumanAccessConfigurationError,
    );
  });
});

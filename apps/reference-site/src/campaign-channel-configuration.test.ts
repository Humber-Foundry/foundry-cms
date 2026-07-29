import { describe, expect, it } from "vitest";

import {
  CampaignChannelConfigurationError,
  readCampaignChannelConfiguration,
} from "./campaign-channel-configuration";

describe("campaign channel configuration", () => {
  it("builds sender and compliance material only from installation settings", () => {
    expect(
      readCampaignChannelConfiguration(
        {
          FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender-primary",
          FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v4",
          FOUNDRY_CAMPAIGN_LEGAL_NAME: "Example Society",
          FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "10 Main Street, Victoria, BC",
          FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.org/contact",
        },
        "https://example.org/newsletter/unsubscribe" +
          "?token={{foundry.unsubscribe.token}}",
      ),
    ).toEqual({
      senderIdentityId: "sender-primary",
      complianceFooter: {
        version: "footer-v4",
        content:
          "Example Society · 10 Main Street, Victoria, BC · " +
          "Contact: https://example.org/contact · Newsletter preferences",
        unsubscribePlaceholder:
          "https://example.org/newsletter/unsubscribe" +
          "?token={{foundry.unsubscribe.token}}",
      },
      audienceDefinition: {
        id: "canonical-consent-and-suppression",
        version: 1,
      },
    });
    expect(() => readCampaignChannelConfiguration({}, "")).toThrow(
      CampaignChannelConfigurationError,
    );
  });
});

import { describe, expect, it } from "vitest";

import { readCampaignChannelConfiguration } from "./campaign-channel-configuration";

const unsubscribePlaceholder =
  "https://example.org/newsletter/unsubscribe" +
  "?token={{foundry.unsubscribe.token}}";

const settings = {
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender-primary",
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v4",
  FOUNDRY_CAMPAIGN_LEGAL_NAME: "Example Society",
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "10 Main Street, Victoria, BC",
  FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.org/contact",
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
    "https://example.org/newsletter/unsubscribe",
};

describe("campaign channel configuration", () => {
  it("builds sender and compliance material only from installation settings", () => {
    expect(
      readCampaignChannelConfiguration(settings, unsubscribePlaceholder),
    ).toEqual({
      state: "configured",
      configuration: {
        senderIdentityId: "sender-primary",
        complianceFooter: {
          version: "footer-v4",
          content:
            "Example Society · 10 Main Street, Victoria, BC · " +
            "Contact: https://example.org/contact · Newsletter preferences",
          unsubscribePlaceholder,
        },
        audienceDefinition: {
          id: "canonical-consent-and-suppression",
          version: 1,
        },
      },
    });
  });

  it("reports a value rather than throwing when nothing is set", () => {
    const result = readCampaignChannelConfiguration({}, "");
    expect(result.state).toBe("not_configured");
    if (result.state !== "not_configured") throw new Error("unreachable");
    expect(result.reason).toBe("campaign_sender_details_not_configured");
    expect(result.missingSettings).toEqual([
      "FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID",
      "FOUNDRY_CAMPAIGN_LEGAL_NAME",
      "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
      "FOUNDRY_CAMPAIGN_CONTACT_URL",
      "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
      "FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION",
    ]);
  });

  it("names only the setting that is missing", () => {
    const result = readCampaignChannelConfiguration(
      { ...settings, FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "   " },
      unsubscribePlaceholder,
    );
    expect(result.state).toBe("not_configured");
    if (result.state !== "not_configured") throw new Error("unreachable");
    expect(result.missingSettings).toEqual([
      "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
    ]);
  });

  it("refuses a contact address that is not an absolute https address", () => {
    for (const contactUrl of [
      "/contact",
      "http://example.org/contact",
      "https://user:secret@example.org/contact",
    ]) {
      const result = readCampaignChannelConfiguration(
        { ...settings, FOUNDRY_CAMPAIGN_CONTACT_URL: contactUrl },
        unsubscribePlaceholder,
      );
      expect(result.state).toBe("not_configured");
      if (result.state !== "not_configured") throw new Error("unreachable");
      expect(result.missingSettings).toEqual([
        "FOUNDRY_CAMPAIGN_CONTACT_URL",
      ]);
    }
  });

  it("names the unsubscribe address when no placeholder could be built", () => {
    const result = readCampaignChannelConfiguration(settings, "");
    expect(result.state).toBe("not_configured");
    if (result.state !== "not_configured") throw new Error("unreachable");
    expect(result.missingSettings).toEqual([
      "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
    ]);
  });

  it("never carries a setting value in what it reports as missing", () => {
    const result = readCampaignChannelConfiguration({}, "");
    if (result.state !== "not_configured") throw new Error("unreachable");
    for (const name of result.missingSettings) {
      expect(name).toMatch(/^FOUNDRY_[A-Z0-9_]+$/u);
    }
  });
});

import { describe, expect, it } from "vitest";

import { resolveCampaignChannel } from "./campaign-channel-configuration";

const unsubscribePlaceholder =
  "https://example.org/newsletter/unsubscribe" +
  "?token={{foundry.unsubscribe.token}}";

/** The channel value alone, which is what every caller narrows on. */
function channelFor(environment: Record<string, string>) {
  return resolveCampaignChannel(environment).channel;
}

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
      channelFor(settings),
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
    const result = channelFor({});
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
    const result = channelFor({ ...settings, FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "   " });
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
      const result = channelFor({ ...settings, FOUNDRY_CAMPAIGN_CONTACT_URL: contactUrl });
      expect(result.state).toBe("not_configured");
      if (result.state !== "not_configured") throw new Error("unreachable");
      expect(result.missingSettings).toEqual([
        "FOUNDRY_CAMPAIGN_CONTACT_URL",
      ]);
    }
  });

  it("names the unsubscribe address when no placeholder could be built", () => {
    const result = channelFor({
      ...settings,
      FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: "not a url",
    });
    expect(result.state).toBe("not_configured");
    if (result.state !== "not_configured") throw new Error("unreachable");
    expect(result.missingSettings).toEqual([
      "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
    ]);
  });

  it("reports readiness that names the same settings it refused on", () => {
    // The screen and the application must never disagree about what is
    // missing, so both come from one reading of the settings.
    const { channel, readiness } = resolveCampaignChannel({});
    if (channel.state !== "not_configured") throw new Error("unreachable");
    expect(readiness.state).toBe("not_configured");
    expect(readiness.missingSettings).toEqual(channel.missingSettings);
    expect(readiness.setupGuide).toBe(
      "docs/operations/brevo-test-delivery-readiness.md",
    );
    expect(resolveCampaignChannel(settings).readiness).toEqual({
      state: "connected",
      missingSettings: [],
      setupGuide: "docs/operations/brevo-test-delivery-readiness.md",
    });
  });

  it("never carries a setting value in what it reports as missing", () => {
    const result = channelFor({});
    if (result.state !== "not_configured") throw new Error("unreachable");
    for (const name of result.missingSettings) {
      expect(name).toMatch(/^FOUNDRY_[A-Z0-9_]+$/u);
    }
  });
});

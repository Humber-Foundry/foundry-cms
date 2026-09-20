import { describe, expect, it } from "vitest";

import {
  newsletterSignupSettingNames,
  readNewsletterConfirmationDelivery,
  readNewsletterSignupReadiness,
  type NewsletterSignupEnvironment,
} from "./newsletter-signup-readiness";
import { publicNewsletterSignupStatus } from "./newsletter-signup-public-status";

const secret = "a-secret-value-long-enough-for-this-check";

const connected: NewsletterSignupEnvironment = Object.freeze({
  FOUNDRY_CANONICAL_ORIGIN: "https://example.test",
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: secret,
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: secret,
  FOUNDRY_TURNSTILE_SITE_KEY: "0xSITEKEY",
  FOUNDRY_TURNSTILE_SECRET: "turnstile-secret",
  FOUNDRY_BREVO_API_KEY: "api-key",
  FOUNDRY_BREVO_SENDERS_JSON: JSON.stringify({
    primary: { id: 1, email: "news@example.test", name: "Studio" },
  }),
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "primary",
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "footer-v1",
  FOUNDRY_CAMPAIGN_LEGAL_NAME: "Studio",
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "1 Street, Town",
  FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.test/contact",
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: "https://example.test/newsletter/unsubscribe",
});

describe("newsletter signup readiness", () => {
  it("is connected when every setting is installed", () => {
    expect(readNewsletterSignupReadiness(connected)).toMatchObject({
      state: "connected",
      missingSettings: [],
    });
  });

  it("names the missing settings without reading any value", () => {
    const readiness = readNewsletterSignupReadiness({});
    expect(readiness.state).toBe("not_configured");
    expect([...readiness.missingSettings]).toStrictEqual([
      ...newsletterSignupSettingNames,
    ]);
    expect(JSON.stringify(readiness)).not.toContain(secret);
  });

  it("reports the legal footer settings as missing on their own", () => {
    const { FOUNDRY_CAMPAIGN_LEGAL_NAME, ...withoutLegalName } = connected;
    expect(FOUNDRY_CAMPAIGN_LEGAL_NAME).toBe("Studio");
    const readiness = readNewsletterSignupReadiness(withoutLegalName);
    expect(readiness.state).toBe("not_configured");
    expect(readiness.missingSettings).toStrictEqual([
      "FOUNDRY_CAMPAIGN_LEGAL_NAME",
    ]);
  });

  it("needs both halves of the automated-traffic check", () => {
    // With the site key alone the form would look ready and then refuse every
    // address at the last moment.
    const { FOUNDRY_TURNSTILE_SECRET, ...withoutSecret } = connected;
    expect(FOUNDRY_TURNSTILE_SECRET).toBe("turnstile-secret");
    expect(
      readNewsletterSignupReadiness(withoutSecret).missingSettings,
    ).toStrictEqual(["FOUNDRY_TURNSTILE_SECRET"]);
  });

  it("refuses a delivery secret that is too short", () => {
    const readiness = readNewsletterSignupReadiness({
      ...connected,
      FOUNDRY_NEWSLETTER_DELIVERY_SECRET: "short",
    });
    expect(readiness.missingSettings).toStrictEqual([
      "FOUNDRY_NEWSLETTER_DELIVERY_SECRET",
    ]);
  });

  it("refuses an origin that is not https", () => {
    expect(
      readNewsletterSignupReadiness({
        ...connected,
        FOUNDRY_CANONICAL_ORIGIN: "http://example.test",
      }).missingSettings,
    ).toStrictEqual(["FOUNDRY_CANONICAL_ORIGIN"]);
  });

  it("says local development rather than name a missing setting", () => {
    expect(
      readNewsletterSignupReadiness({}, { localDevelopment: true }),
    ).toMatchObject({ state: "local_development", missingSettings: [] });
  });

  it("gives the sender identity and the legal footer when connected", () => {
    const delivery = readNewsletterConfirmationDelivery(connected);
    expect(delivery?.senderIdentityId).toBe("primary");
    expect(delivery?.legalFooter).toContain("Studio");
    expect(delivery?.legalFooter).toContain("1 Street, Town");
  });

  it("gives nothing at all when a legal footer setting is missing", () => {
    const { FOUNDRY_CAMPAIGN_POSTAL_ADDRESS, ...missing } = connected;
    expect(FOUNDRY_CAMPAIGN_POSTAL_ADDRESS).toBe("1 Street, Town");
    expect(readNewsletterConfirmationDelivery(missing)).toBeNull();
  });
});

describe("what the public form is told", () => {
  it("gets the site key only when signup works", () => {
    expect(
      publicNewsletterSignupStatus(
        readNewsletterSignupReadiness(connected),
        connected,
      ),
    ).toStrictEqual({ available: true, turnstileSiteKey: "0xSITEKEY" });
  });

  it("is told no, with no setting names and no site key", () => {
    const status = publicNewsletterSignupStatus(
      readNewsletterSignupReadiness({ ...connected, FOUNDRY_BREVO_API_KEY: "" }),
      connected,
    );
    expect(status).toStrictEqual({
      available: false,
      turnstileSiteKey: null,
    });
    expect(JSON.stringify(status)).not.toContain("FOUNDRY_");
  });

  it("never carries a secret to the public form", () => {
    const status = publicNewsletterSignupStatus(
      readNewsletterSignupReadiness(connected),
      connected,
    );
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(status)).not.toContain("api-key");
  });
});

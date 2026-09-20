import type { HumanAccessEnvironment } from "./human-access-configuration";
import {
  CampaignChannelConfigurationError,
  readCampaignChannelConfiguration,
} from "./campaign-channel-configuration";
import {
  emailDeliverySetupGuide,
  isHttpsUrl,
  isLongEnoughSecret,
  isNonEmptyJsonObject,
  isPresent,
  type SettingCheck,
} from "./settings-presence";

/**
 * Whether this installation can run newsletter signup.
 *
 * Signup needs more than the campaign delivery secrets. It also needs the
 * sender identity and the compliance settings, because the confirmation message
 * is a real message to a member of the public and carries the same legal footer
 * a campaign carries. Without them there is no lawful message to send, so the
 * form must say signup is not available and must not take an address it can
 * never confirm.
 *
 * `missingSettings` holds configuration names only. This result reaches the
 * dashboard, so it must never carry a secret value or an address. The public
 * form is told yes or no and nothing else: a visitor has no business learning
 * how a site is configured.
 */
export type NewsletterSignupReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  missingSettings: ReadonlyArray<NewsletterSignupSettingName>;
  setupGuide: string;
}>;

export const newsletterSignupSettingNames = Object.freeze([
  "FOUNDRY_CANONICAL_ORIGIN",
  "FOUNDRY_NEWSLETTER_DELIVERY_SECRET",
  "FOUNDRY_SUBSCRIBER_IDENTITY_SECRET",
  "FOUNDRY_TURNSTILE_SITE_KEY",
  "FOUNDRY_BREVO_API_KEY",
  "FOUNDRY_BREVO_SENDERS_JSON",
  "FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID",
  "FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION",
  "FOUNDRY_CAMPAIGN_LEGAL_NAME",
  "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
  "FOUNDRY_CAMPAIGN_CONTACT_URL",
  "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
] as const);

export type NewsletterSignupSettingName =
  (typeof newsletterSignupSettingNames)[number];

const newsletterSignupSettingChecks: Readonly<
  Record<
    NewsletterSignupSettingName,
    SettingCheck<NewsletterSignupEnvironment>
  >
> = Object.freeze({
  FOUNDRY_CANONICAL_ORIGIN: (environment) =>
    isHttpsUrl(environment.FOUNDRY_CANONICAL_ORIGIN),
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: (environment) =>
    isLongEnoughSecret(environment.FOUNDRY_NEWSLETTER_DELIVERY_SECRET),
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: (environment) =>
    isLongEnoughSecret(environment.FOUNDRY_SUBSCRIBER_IDENTITY_SECRET),
  FOUNDRY_TURNSTILE_SITE_KEY: (environment) =>
    isPresent(environment.FOUNDRY_TURNSTILE_SITE_KEY),
  FOUNDRY_BREVO_API_KEY: (environment) =>
    isPresent(environment.FOUNDRY_BREVO_API_KEY),
  FOUNDRY_BREVO_SENDERS_JSON: (environment) =>
    isNonEmptyJsonObject(environment.FOUNDRY_BREVO_SENDERS_JSON),
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID),
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION),
  FOUNDRY_CAMPAIGN_LEGAL_NAME: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_LEGAL_NAME),
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_POSTAL_ADDRESS),
  FOUNDRY_CAMPAIGN_CONTACT_URL: (environment) =>
    isHttpsUrl(environment.FOUNDRY_CAMPAIGN_CONTACT_URL),
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: (environment) =>
    isHttpsUrl(environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL),
});

export type NewsletterSignupEnvironment = HumanAccessEnvironment &
  Readonly<{
    FOUNDRY_TURNSTILE_SITE_KEY?: string;
    FOUNDRY_TURNSTILE_SECRET?: string;
  }>;

export function readNewsletterSignupReadiness(
  environment: NewsletterSignupEnvironment,
  options: { localDevelopment?: boolean } = {},
): NewsletterSignupReadiness {
  if (options.localDevelopment === true) {
    return Object.freeze({
      state: "local_development",
      missingSettings: Object.freeze([]),
      setupGuide: emailDeliverySetupGuide,
    });
  }
  const missingSettings = newsletterSignupSettingNames.filter(
    (name) => !newsletterSignupSettingChecks[name](environment),
  );
  return Object.freeze({
    state: missingSettings.length === 0 ? "connected" : "not_configured",
    missingSettings: Object.freeze(missingSettings),
    setupGuide: emailDeliverySetupGuide,
  });
}

/**
 * The sender identity and legal footer a confirmation message must carry, or
 * `null` when a setting is missing. The domain treats `null` as "do not take
 * this address", which is the whole point of the check.
 */
export function readNewsletterConfirmationDelivery(
  environment: NewsletterSignupEnvironment,
): Readonly<{ senderIdentityId: string; legalFooter: string }> | null {
  const readiness = readNewsletterSignupReadiness(environment);
  if (readiness.state !== "connected") return null;
  try {
    const channel = readCampaignChannelConfiguration(
      environment,
      environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL ?? "",
    );
    return Object.freeze({
      senderIdentityId: channel.senderIdentityId,
      legalFooter: channel.complianceFooter.content,
    });
  } catch (error) {
    if (error instanceof CampaignChannelConfigurationError) return null;
    throw error;
  }
}

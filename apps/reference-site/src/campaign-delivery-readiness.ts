import type { NewsletterDeliveryHealth } from "@humber-foundry/application";

import type { HumanAccessEnvironment } from "./human-access-configuration";

/**
 * The document that tells an installer how to connect email delivery. The
 * readiness result carries this path so every screen points at one guide.
 */
export const campaignDeliverySetupGuide =
  "docs/operations/brevo-test-delivery-readiness.md";

/**
 * How one installation's email delivery is connected.
 *
 * `missingSettings` holds configuration names only. This result leaves the
 * server through the campaigns API and is meant to be shown on screen, so it
 * must never carry a secret value, a provider token or a personal email
 * address.
 *
 * - `local_development` — delivery is off because the site runs in local
 *   development. Nothing is sent and nothing needs to be installed.
 * - `not_configured` — at least one named setting is absent or invalid.
 * - `connected` — every named setting is installed. `providerHealth` then
 *   reports what the provider itself says about the credential and the sender
 *   identity. It stays `null` in the other two states, because there is no
 *   provider to ask.
 *
 * `connected` means the settings are installed. It does not mean a test was
 * delivered; that stays with per-campaign test readiness.
 */
export type CampaignDeliveryReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  missingSettings: ReadonlyArray<CampaignDeliverySettingName>;
  providerHealth: NewsletterDeliveryHealth | null;
  setupGuide: string;
}>;

/**
 * Every secret and provider setting an installation must hold before Foundry
 * can test or send a newsletter. The order is the order an installer works
 * through the setup document: the two signing secrets, then the provider
 * account.
 *
 * The campaign identity and compliance settings are absent from this list on
 * purpose. They are ordinary configuration rather than delivery secrets, and
 * the compliance footer they build is stored on every campaign revision, so
 * Foundry must never stand in for them.
 *
 * `FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON` is absent for a different reason.
 * The runtime treats an absent value as an `evaluation` account rather than a
 * fault, and per-campaign test readiness already reports that as
 * `evaluation_only`. Requiring it here would report an installation that sends
 * today as not configured.
 */
export const campaignDeliverySettingNames = Object.freeze([
  "FOUNDRY_NEWSLETTER_DELIVERY_SECRET",
  "FOUNDRY_SUBSCRIBER_IDENTITY_SECRET",
  "FOUNDRY_BREVO_API_KEY",
  "FOUNDRY_CAMPAIGN_TEST_PROOF_KEY",
  "FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN",
  "FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT",
  "FOUNDRY_BREVO_SENDERS_JSON",
  "FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON",
] as const);

/** One named delivery setting. */
export type CampaignDeliverySettingName =
  (typeof campaignDeliverySettingNames)[number];

/**
 * How one installation's sender details and email footer are set.
 *
 * This has the same shape as `CampaignDeliveryReadiness` so one component can
 * render either, but it answers a different question. Delivery readiness is
 * about the secrets that let Foundry reach the email provider. This is about
 * the name, postal address, contact address and unsubscribe address that must
 * appear at the bottom of every email, and about which sender the email comes
 * from.
 *
 * Foundry never invents any of them, so while one is absent no campaign can be
 * written, tested, scheduled or sent.
 *
 * `missingSettings` holds configuration names only, never a value.
 */
export type CampaignSenderReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  missingSettings: ReadonlyArray<CampaignSenderSettingName>;
  setupGuide: string;
}>;

/**
 * Every campaign identity and compliance setting an installation must hold
 * before Foundry can build the compliance footer it stores on a campaign
 * revision. The order is the order the setup document works through them: who
 * the email is from, then the four parts of the footer, then the footer's
 * version mark.
 */
export const campaignSenderSettingNames = Object.freeze([
  "FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID",
  "FOUNDRY_CAMPAIGN_LEGAL_NAME",
  "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
  "FOUNDRY_CAMPAIGN_CONTACT_URL",
  "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
  "FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION",
] as const);

/** One named campaign identity or compliance setting. */
export type CampaignSenderSettingName =
  (typeof campaignSenderSettingNames)[number];

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * An address a reader can open from inside an email. It must be absolute and
 * `https://`, and must carry no username or password, because the footer is
 * sent to every recipient.
 */
function isAbsoluteHttpsAddress(value: string | undefined): boolean {
  if (!isPresent(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value!.trim());
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * Whether each named sender setting is installed and well formed. Each rule
 * matches `resolveCampaignChannel`, so a setting reported as installed here
 * cannot make the channel reader refuse.
 */
const campaignSenderSettingChecks: Readonly<
  Record<
    CampaignSenderSettingName,
    (environment: HumanAccessEnvironment) => boolean
  >
> = Object.freeze({
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID),
  FOUNDRY_CAMPAIGN_LEGAL_NAME: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_LEGAL_NAME),
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_POSTAL_ADDRESS),
  FOUNDRY_CAMPAIGN_CONTACT_URL: (environment) =>
    isAbsoluteHttpsAddress(environment.FOUNDRY_CAMPAIGN_CONTACT_URL),
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: (environment) =>
    isAbsoluteHttpsAddress(environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL),
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION),
});

/**
 * The names of the sender and footer settings this installation still needs,
 * in setup order. An empty list means the compliance footer can be built from
 * the installation's own values.
 */
export function listMissingCampaignSenderSettings(
  environment: HumanAccessEnvironment,
): ReadonlyArray<CampaignSenderSettingName> {
  return Object.freeze(
    campaignSenderSettingNames.filter(
      (name) => !campaignSenderSettingChecks[name](environment),
    ),
  );
}

/**
 * A secret is long enough when it holds at least 32 characters. The readers in
 * `human-access-configuration.ts` measure the untrimmed value, so this check
 * measures it the same way. A different rule here would report a setting as
 * installed that the reader then rejects.
 */
function isLongEnoughSecret(value: string | undefined): boolean {
  return isPresent(value) && value!.length >= 32;
}

/** A JSON object with at least one entry, such as the sender mapping. */
function isNonEmptyJsonObject(value: string | undefined): boolean {
  if (!isPresent(value)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value!);
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length > 0
  );
}

/**
 * Whether each named delivery setting is installed and well formed. Each rule
 * matches the reader that consumes the setting later, so a setting reported as
 * installed here cannot make the reader throw.
 *
 * This never reads a value into the result. It answers only yes or no per name.
 */
const campaignDeliverySettingChecks: Readonly<
  Record<
    CampaignDeliverySettingName,
    (environment: HumanAccessEnvironment) => boolean
  >
> = Object.freeze({
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: (environment) =>
    isLongEnoughSecret(environment.FOUNDRY_NEWSLETTER_DELIVERY_SECRET),
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: (environment) =>
    isLongEnoughSecret(environment.FOUNDRY_SUBSCRIBER_IDENTITY_SECRET),
  FOUNDRY_BREVO_API_KEY: (environment) =>
    isPresent(environment.FOUNDRY_BREVO_API_KEY),
  // The Brevo adapter refuses a proof key shorter than 32 characters, and the
  // runtime trims it before handing it over, so the trimmed length is what
  // decides. A looser rule here would report delivery as connected and then
  // fail when the adapter is built.
  FOUNDRY_CAMPAIGN_TEST_PROOF_KEY: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY) &&
    environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY!.trim().length >= 32,
  FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN: (environment) =>
    isPresent(environment.FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN) &&
    environment.FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN!.trim().length >= 32,
  FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT: (environment) =>
    /^[a-f0-9]{64}$/u.test(
      environment.FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT?.trim() ?? "",
    ),
  FOUNDRY_BREVO_SENDERS_JSON: (environment) =>
    isNonEmptyJsonObject(environment.FOUNDRY_BREVO_SENDERS_JSON),
  FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON: (environment) =>
    isNonEmptyJsonObject(environment.FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON),
});

/**
 * The names of the delivery settings this installation still needs, in setup
 * order. An empty list means every delivery setting is installed.
 */
export function listMissingCampaignDeliverySettings(
  environment: HumanAccessEnvironment,
): ReadonlyArray<CampaignDeliverySettingName> {
  return Object.freeze(
    campaignDeliverySettingNames.filter(
      (name) => !campaignDeliverySettingChecks[name](environment),
    ),
  );
}

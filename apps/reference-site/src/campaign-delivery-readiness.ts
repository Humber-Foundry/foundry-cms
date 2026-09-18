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
 * `missingSettings` holds configuration names only. The dashboard renders this
 * result and the campaigns API returns it, so it must never carry a secret
 * value, a provider token or a personal email address.
 *
 * - `local_development` — delivery is off because the site runs in local
 *   development. Nothing is sent and nothing needs to be installed.
 * - `not_configured` — at least one named setting is absent or invalid.
 * - `connected` — every named setting is installed. `providerHealth` then
 *   reports what the provider itself says about the credential and the sender
 *   identity.
 */
export type CampaignDeliveryReadiness = Readonly<{
  state: "connected" | "not_configured" | "local_development";
  connected: boolean;
  missingSettings: ReadonlyArray<string>;
  providerHealth: NewsletterDeliveryHealth | null;
  setupGuide: string;
}>;

/**
 * Every setting an installation must hold before Foundry can render, test and
 * send a newsletter. The order is the order an installer works through the
 * setup document: campaign identity and compliance first, then the two signing
 * secrets, then the provider account.
 */
export const campaignDeliverySettingNames = Object.freeze([
  "FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID",
  "FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION",
  "FOUNDRY_CAMPAIGN_LEGAL_NAME",
  "FOUNDRY_CAMPAIGN_POSTAL_ADDRESS",
  "FOUNDRY_CAMPAIGN_CONTACT_URL",
  "FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL",
  "FOUNDRY_NEWSLETTER_DELIVERY_SECRET",
  "FOUNDRY_SUBSCRIBER_IDENTITY_SECRET",
  "FOUNDRY_BREVO_API_KEY",
  "FOUNDRY_CAMPAIGN_TEST_PROOF_KEY",
  "FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN",
  "FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT",
  "FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON",
  "FOUNDRY_BREVO_SENDERS_JSON",
  "FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON",
] as const);

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
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

function isAbsoluteHttpsUrl(value: string | undefined): boolean {
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
    (typeof campaignDeliverySettingNames)[number],
    (environment: HumanAccessEnvironment) => boolean
  >
> = Object.freeze({
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID),
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION),
  FOUNDRY_CAMPAIGN_LEGAL_NAME: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_LEGAL_NAME),
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_POSTAL_ADDRESS),
  FOUNDRY_CAMPAIGN_CONTACT_URL: (environment) =>
    isAbsoluteHttpsUrl(environment.FOUNDRY_CAMPAIGN_CONTACT_URL),
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL: (environment) =>
    isAbsoluteHttpsUrl(environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL),
  FOUNDRY_NEWSLETTER_DELIVERY_SECRET: (environment) =>
    isLongEnoughSecret(environment.FOUNDRY_NEWSLETTER_DELIVERY_SECRET),
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET: (environment) =>
    isLongEnoughSecret(environment.FOUNDRY_SUBSCRIBER_IDENTITY_SECRET),
  FOUNDRY_BREVO_API_KEY: (environment) =>
    isPresent(environment.FOUNDRY_BREVO_API_KEY),
  FOUNDRY_CAMPAIGN_TEST_PROOF_KEY: (environment) =>
    isPresent(environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY),
  FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN: (environment) =>
    isPresent(environment.FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN) &&
    environment.FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN!.trim().length >= 32,
  FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT: (environment) =>
    /^[a-f0-9]{64}$/u.test(
      environment.FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT?.trim() ?? "",
    ),
  // Absent evidence is not an error for the runtime: it classifies the account
  // as `evaluation`. Delivery still cannot report ready without it, so the
  // installer is told the setting is missing.
  FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON: (environment) =>
    isNonEmptyJsonObject(environment.FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON),
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
): ReadonlyArray<string> {
  return Object.freeze(
    campaignDeliverySettingNames.filter(
      (name) => !campaignDeliverySettingChecks[name](environment),
    ),
  );
}

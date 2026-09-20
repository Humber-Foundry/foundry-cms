import {
  campaignChannelNotConfigured,
  configuredCampaignChannel,
  type CampaignChannelConfigurationState,
} from "@humber-foundry/application";

import {
  campaignDeliverySetupGuide,
  listMissingCampaignSenderSettings,
  type CampaignSenderReadiness,
  type CampaignSenderSettingName,
} from "./campaign-delivery-readiness";
import type {
  HumanAccessEnvironment,
} from "./human-access-configuration";
import { newsletterUnsubscribePlaceholder } from "./newsletter-unsubscribe-token";

/**
 * What one installation's sender settings say, in the two shapes its callers
 * need: `channel` for the application layer, `readiness` for a screen.
 *
 * Both come from one reading of the settings, so the screen can never name a
 * different set of missing settings from the one the application refused on.
 */
export type CampaignChannelResolution = Readonly<{
  channel: CampaignChannelConfigurationState;
  readiness: CampaignSenderReadiness;
}>;

/**
 * The unsubscribe address with the token marker in it, or an empty string when
 * the installation has not set a usable address.
 *
 * An address that cannot be parsed is a configuration fault. Returning the
 * empty string lets the reader below name it like any other absent setting,
 * rather than raising a bare URL error out of the address parser.
 */
function unsubscribePlaceholderFor(
  environment: HumanAccessEnvironment,
): string {
  try {
    return newsletterUnsubscribePlaceholder(
      environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL ?? "",
    );
  } catch {
    return "";
  }
}

/**
 * The sender identity and compliance footer for one installation, or the typed
 * value that says which settings are still absent.
 *
 * This never throws for an absent setting and never stands in a value. The
 * footer is stored on every campaign revision and is read by whoever receives
 * the email, so a placeholder here could later be sent as the legal name and
 * postal address. The caller gets a value it has to read before it can reach
 * the configuration.
 *
 * Every caller that needs this reads it here — the Newsletter page and API,
 * the MCP campaign runtime, and the scheduled worker — so one rule decides for
 * all of them.
 */
export function resolveCampaignChannel(
  environment: HumanAccessEnvironment,
): CampaignChannelResolution {
  const unsubscribePlaceholder = unsubscribePlaceholderFor(environment);
  const missingSettings: ReadonlyArray<CampaignSenderSettingName> =
    listMissingCampaignSenderSettings(environment);
  if (missingSettings.length > 0 || unsubscribePlaceholder === "") {
    // The two rules agree on every setting, so an empty list here can only
    // mean an unsubscribe address that parses but cannot carry the token.
    const missing =
      missingSettings.length > 0
        ? missingSettings
        : Object.freeze(["FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL" as const]);
    return Object.freeze({
      channel: campaignChannelNotConfigured(missing),
      readiness: Object.freeze({
        state: "not_configured" as const,
        missingSettings: missing,
        setupGuide: campaignDeliverySetupGuide,
      }),
    });
  }
  const setting = (name: CampaignSenderSettingName): string =>
    (environment[name] ?? "").trim();
  const legalName = setting("FOUNDRY_CAMPAIGN_LEGAL_NAME");
  const postalAddress = setting("FOUNDRY_CAMPAIGN_POSTAL_ADDRESS");
  const contactUrl = new URL(
    setting("FOUNDRY_CAMPAIGN_CONTACT_URL"),
  ).toString();
  return Object.freeze({
    channel: configuredCampaignChannel(
      Object.freeze({
        senderIdentityId: setting("FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID"),
        complianceFooter: Object.freeze({
          version: setting("FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION"),
          content:
            `${legalName} · ${postalAddress} · Contact: ${contactUrl} · ` +
            "Newsletter preferences",
          unsubscribePlaceholder,
        }),
        audienceDefinition: Object.freeze({
          id: "canonical-consent-and-suppression" as const,
          version: 1 as const,
        }),
      }),
    ),
    readiness: Object.freeze({
      state: "connected" as const,
      missingSettings: Object.freeze([]),
      setupGuide: campaignDeliverySetupGuide,
    }),
  });
}

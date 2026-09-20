import {
  campaignChannelNotConfigured,
  configuredCampaignChannel,
  type CampaignChannelConfigurationState,
} from "@humber-foundry/application";

import {
  listMissingCampaignSenderSettings,
} from "./campaign-delivery-readiness";
import type {
  HumanAccessEnvironment,
} from "./human-access-configuration";

/**
 * The sender identity and legal footer for one installation, or the typed
 * value that says which settings are still absent.
 *
 * This never throws for an absent setting and never stands in a value. The
 * footer is stored on every campaign revision and is read by whoever receives
 * the email, so a placeholder here could later be sent as the legal name and
 * postal address. The caller gets a value it has to read before it can reach
 * the configuration.
 *
 * `unsubscribePlaceholder` is the unsubscribe address with the token marker in
 * it. The caller builds it from `FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL`; an empty
 * string means that setting is absent or malformed, and it is then named like
 * any other absent setting.
 */
export function readCampaignChannelConfiguration(
  environment: HumanAccessEnvironment,
  unsubscribePlaceholder: string,
): CampaignChannelConfigurationState {
  const missingSettings = listMissingCampaignSenderSettings(environment);
  if (missingSettings.length > 0 || unsubscribePlaceholder.trim() === "") {
    return campaignChannelNotConfigured(
      missingSettings.length > 0
        ? missingSettings
        : ["FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL"],
    );
  }
  const legalName = environment.FOUNDRY_CAMPAIGN_LEGAL_NAME!.trim();
  const postalAddress = environment.FOUNDRY_CAMPAIGN_POSTAL_ADDRESS!.trim();
  const contactUrl = new URL(
    environment.FOUNDRY_CAMPAIGN_CONTACT_URL!.trim(),
  ).toString();
  return configuredCampaignChannel(
    Object.freeze({
      senderIdentityId:
        environment.FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID!.trim(),
      complianceFooter: Object.freeze({
        version: environment.FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION!.trim(),
        content:
          `${legalName} · ${postalAddress} · Contact: ${contactUrl} · ` +
          "Newsletter preferences",
        unsubscribePlaceholder: unsubscribePlaceholder.trim(),
      }),
      audienceDefinition: Object.freeze({
        id: "canonical-consent-and-suppression" as const,
        version: 1 as const,
      }),
    }),
  );
}

import type {
  CampaignChannelConfiguration,
} from "@humber-foundry/application";

import type {
  HumanAccessEnvironment,
} from "./human-access-configuration";

export class CampaignChannelConfigurationError extends Error {
  constructor() {
    super("campaign_channel_not_configured");
    this.name = "CampaignChannelConfigurationError";
  }
}

function requireSetting(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new CampaignChannelConfigurationError();
  }
  return value.trim();
}

function requireAbsoluteHttpsUrl(value: string | undefined): string {
  const normalized = requireSetting(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new CampaignChannelConfigurationError();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new CampaignChannelConfigurationError();
  }
  return parsed.toString();
}

export function readCampaignChannelConfiguration(
  environment: HumanAccessEnvironment,
  unsubscribePlaceholder: string,
): CampaignChannelConfiguration {
  const legalName = requireSetting(environment.FOUNDRY_CAMPAIGN_LEGAL_NAME);
  const postalAddress = requireSetting(
    environment.FOUNDRY_CAMPAIGN_POSTAL_ADDRESS,
  );
  const contactUrl = requireAbsoluteHttpsUrl(
    environment.FOUNDRY_CAMPAIGN_CONTACT_URL,
  );
  return Object.freeze({
    senderIdentityId: requireSetting(
      environment.FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID,
    ),
    complianceFooter: Object.freeze({
      version: requireSetting(
        environment.FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION,
      ),
      content:
        `${legalName} · ${postalAddress} · Contact: ${contactUrl} · ` +
        "Newsletter preferences",
      unsubscribePlaceholder: requireAbsoluteHttpsUrl(
        unsubscribePlaceholder,
      ),
    }),
    audienceDefinition: Object.freeze({
      id: "canonical-consent-and-suppression",
      version: 1,
    }),
  });
}

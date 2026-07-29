import type { CloudflareAccessConfiguration } from "./access-identity";
import { createCloudflareAccessEligibilitySynchronizer } from "./cloudflare-access-eligibility";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import type { PrivateMediaBucket } from "./r2-media-source-store";

export type HumanAccessEnvironment = Readonly<{
  FOUNDRY_ACCESS_ISSUER?: string;
  FOUNDRY_ACCESS_AUDIENCE?: string;
  FOUNDRY_ACCESS_ACCOUNT_ID?: string;
  FOUNDRY_ACCESS_APPLICATION_ID?: string;
  FOUNDRY_ACCESS_POLICY_ID?: string;
  FOUNDRY_ACCESS_LOGIN_METHOD_ID?: string;
  FOUNDRY_ACCESS_API_TOKEN?: string;
  FOUNDRY_CANONICAL_ORIGIN?: string;
  FOUNDRY_CSRF_SECRET?: string;
  FOUNDRY_SUBSCRIBER_IDENTITY_SECRET?: string;
  FOUNDRY_RENDERER_VERSION?: string;
  FOUNDRY_PRODUCTION_BASE?: string;
  FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID?: string;
  FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION?: string;
  FOUNDRY_CAMPAIGN_LEGAL_NAME?: string;
  FOUNDRY_CAMPAIGN_POSTAL_ADDRESS?: string;
  FOUNDRY_CAMPAIGN_CONTACT_URL?: string;
  FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL?: string;
  CF_VERSION_METADATA?: Readonly<{ id: string }>;
  FOUNDRY_DB?: D1DatabaseBinding;
  FOUNDRY_GITHUB_APP_ID?: string;
  FOUNDRY_GITHUB_INSTALLATION_ID?: string;
  FOUNDRY_GITHUB_PRIVATE_KEY?: string;
  FOUNDRY_GITHUB_OWNER?: string;
  FOUNDRY_GITHUB_REPOSITORY?: string;
  FOUNDRY_PRODUCTION_BRANCH?: string;
  FOUNDRY_PUBLIC_ORIGIN?: string;
  FOUNDRY_DEPLOYMENT_CHECK_NAME?: string;
  FOUNDRY_CLOUDFLARE_ACCOUNT_ID?: string;
  FOUNDRY_CLOUDFLARE_SCRIPT_TAG?: string;
  FOUNDRY_CLOUDFLARE_SCRIPT_NAME?: string;
  FOUNDRY_CLOUDFLARE_BUILD_TRIGGER_ID?: string;
  FOUNDRY_CLOUDFLARE_API_TOKEN?: string;
  FOUNDRY_PUBLICATION_SIGNING_SECRET?: string;
  FOUNDRY_MEDIA?: PrivateMediaBucket;
}>;

export class HumanAccessConfigurationError extends Error {
  constructor() {
    super("human_access_not_configured");
    this.name = "HumanAccessConfigurationError";
  }
}

function requireSetting(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new HumanAccessConfigurationError();
  }
  return value;
}

export function readAccessAssertionConfiguration(
  environment: HumanAccessEnvironment,
): CloudflareAccessConfiguration {
  return {
    issuer: requireSetting(environment.FOUNDRY_ACCESS_ISSUER),
    audience: requireSetting(environment.FOUNDRY_ACCESS_AUDIENCE),
  };
}

export function createAccessEligibilitySynchronizer(
  environment: HumanAccessEnvironment,
) {
  return createCloudflareAccessEligibilitySynchronizer({
    accountId: requireSetting(environment.FOUNDRY_ACCESS_ACCOUNT_ID),
    applicationId: requireSetting(
      environment.FOUNDRY_ACCESS_APPLICATION_ID,
    ),
    policyId: requireSetting(environment.FOUNDRY_ACCESS_POLICY_ID),
    loginMethodId: requireSetting(
      environment.FOUNDRY_ACCESS_LOGIN_METHOD_ID,
    ),
    apiToken: requireSetting(environment.FOUNDRY_ACCESS_API_TOKEN),
  });
}

export function createDeferredAccessEligibilitySynchronizer(
  environment: HumanAccessEnvironment,
): HumanAccessEligibilitySynchronizer {
  return {
    async replaceExactEmailEligibility(emails) {
      await createAccessEligibilitySynchronizer(
        environment,
      ).replaceExactEmailEligibility(emails);
    },
  };
}

export function readHumanMutationConfiguration(
  environment: HumanAccessEnvironment,
) {
  return {
    audience: requireSetting(environment.FOUNDRY_ACCESS_AUDIENCE),
    canonicalOrigin: requireSetting(environment.FOUNDRY_CANONICAL_ORIGIN),
    secret: requireSetting(environment.FOUNDRY_CSRF_SECRET),
  };
}

export function readSubscriberIdentityKeySecret(
  environment: HumanAccessEnvironment,
) {
  const secret = requireSetting(
    environment.FOUNDRY_SUBSCRIBER_IDENTITY_SECRET,
  );
  if (secret.length < 32) {
    throw new HumanAccessConfigurationError();
  }
  return secret;
}

function requireAbsoluteHttpsUrl(value: string | undefined): string {
  const normalized = requireSetting(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new HumanAccessConfigurationError();
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new HumanAccessConfigurationError();
  }
  return parsed.toString();
}

export function readCampaignChannelConfiguration(
  environment: HumanAccessEnvironment,
) {
  const legalName = requireSetting(environment.FOUNDRY_CAMPAIGN_LEGAL_NAME);
  const postalAddress = requireSetting(
    environment.FOUNDRY_CAMPAIGN_POSTAL_ADDRESS,
  );
  const contactUrl = requireAbsoluteHttpsUrl(
    environment.FOUNDRY_CAMPAIGN_CONTACT_URL,
  );
  const unsubscribeUrl = requireAbsoluteHttpsUrl(
    environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL,
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
        `Unsubscribe: ${unsubscribeUrl}`,
    }),
    audienceDefinition: Object.freeze({
      id: "canonical-consent-and-suppression" as const,
      version: 1 as const,
    }),
  });
}
import type { HumanAccessEligibilitySynchronizer } from "@foundry/application";

import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { HumanAccessEnvironment } from "./human-access-configuration";
import { resolvePrivatePreviewOrigin } from "./private-preview-origin";

export {
  HumanAccessConfigurationError,
} from "./human-access-configuration";
export type { HumanAccessEnvironment } from "./human-access-configuration";

export async function loadHumanAccessEnvironment(): Promise<HumanAccessEnvironment> {
  if (process.env.NODE_ENV === "development") {
    return {
      FOUNDRY_CANONICAL_ORIGIN: resolvePrivatePreviewOrigin(
        process.env.FOUNDRY_PRIVATE_PREVIEW_ORIGIN,
      ),
      FOUNDRY_CSRF_SECRET: "local-development-csrf-secret",
      FOUNDRY_SUBSCRIBER_IDENTITY_SECRET:
        "local-development-subscriber-identity-secret",
      FOUNDRY_ACCESS_AUDIENCE: "local-development-audience",
      FOUNDRY_CAMPAIGN_SENDER_IDENTITY_ID: "sender_primary",
      FOUNDRY_CAMPAIGN_COMPLIANCE_VERSION: "local-footer-v1",
      FOUNDRY_CAMPAIGN_LEGAL_NAME: "Foundry local development",
      FOUNDRY_CAMPAIGN_POSTAL_ADDRESS: "Local development only",
      FOUNDRY_CAMPAIGN_CONTACT_URL: "https://example.test/contact",
      FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL:
        "https://example.test/newsletter/unsubscribe",
      FOUNDRY_NEWSLETTER_DELIVERY_SECRET:
        "local-development-newsletter-delivery-secret",
    };
  }
  const { env } = await getCloudflareContext({ async: true });
  return env as HumanAccessEnvironment;
}

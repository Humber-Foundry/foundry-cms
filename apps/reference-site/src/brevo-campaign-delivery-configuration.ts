import { sha256CanonicalJson, sha256Text } from "@humber-foundry/application";

import type { HumanAccessEnvironment } from "./human-access-configuration";
import {
  brevoCampaignSenderFingerprint,
  type BrevoSenderConfiguration,
} from "./brevo-sender-fingerprint";

export type { BrevoSenderConfiguration };

export async function readBrevoCampaignDeliveryConfiguration(
  environment: HumanAccessEnvironment,
  senders: Readonly<Record<string, BrevoSenderConfiguration>>,
) {
  const installationProofKey =
    environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY?.trim() ?? "";
  const accountScopeFingerprint =
    environment.FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT?.trim() ?? "";
  const providerConfigurationFingerprint = await sha256CanonicalJson({
    version: "foundry.brevo-test-configuration.v3",
    accountScopeFingerprint,
    senders,
    installationProofKeyFingerprint: await sha256Text(installationProofKey),
    adapterVersion: "brevo-transactional-test-v3",
    webhookEvidenceVersion: "brevo-transactional-webhook-v1",
  });
  const senderFingerprints = Object.fromEntries(
    await Promise.all(
      Object.entries(senders).map(
        async ([logicalId, configured]) =>
          [
            logicalId,
            await brevoCampaignSenderFingerprint(logicalId, configured),
          ] as const,
      ),
    ),
  );
  return Object.freeze({
    providerConfigurationFingerprint,
    senderFingerprints: Object.freeze(senderFingerprints),
  });
}

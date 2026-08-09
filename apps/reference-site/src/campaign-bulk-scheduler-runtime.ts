import {
  AccessDeniedError,
  CampaignBulkDeliveryError,
  createCampaignBulkDeliveryApplication,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";

import {
  brevoBulkRecipientLimit,
  createBrevoCampaignBulkDeliveryAdapter,
} from "./brevo-campaign-bulk-delivery-adapter";
import { readBrevoCampaignDeliveryConfiguration } from "./brevo-campaign-delivery-configuration";
import { createCampaignBulkAudience } from "./campaign-bulk-audience";
import {
  createActiveOwnerCheck,
  createCampaignBulkSourceReader,
  createProviderSuppressionRecorder,
} from "./campaign-bulk-source";
import { createD1CampaignBulkStateStore } from "./d1-campaign-bulk-state-store";
import { createD1CampaignStore } from "./d1-campaign-store";
import { createD1CampaignTestDeliveryStore } from "./d1-campaign-test-delivery-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import type { HumanAccessEnvironment } from "./human-access-configuration";
import { readSubscriberIdentityKeySecret } from "./human-access-configuration";
import {
  createGitHubContentPublisher,
  readGitHubContentPublisherConfiguration,
} from "./github-content-publisher";

type DurableCampaignBulkEnvironment = HumanAccessEnvironment & {
  FOUNDRY_DB: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>;
};

export async function createDurableCampaignBulkDeliveryApplication(
  environment: DurableCampaignBulkEnvironment,
) {
  const siteId = installedSiteDefinition.site.id;
  const campaignStore = createD1CampaignStore(environment.FOUNDRY_DB);
  const testStore = createD1CampaignTestDeliveryStore(environment.FOUNDRY_DB);
  const subscriberStore = createD1SubscriberLedgerStore(environment.FOUNDRY_DB);
  const apiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
  const fingerprintKey =
    environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY?.trim() ?? "";
  const senders = JSON.parse(
    environment.FOUNDRY_BREVO_SENDERS_JSON ?? "{}",
  ) as Record<string, { id: number; email: string; name: string }>;
  const bulkConfiguration = await readBrevoCampaignDeliveryConfiguration(
    environment,
    senders,
  );

  const loadSource = createCampaignBulkSourceReader({
    siteId,
    campaignStore,
    testStore,
    senders: () => senders,
    senderFingerprints: () => bulkConfiguration.senderFingerprints,
    providerConfigurationFingerprint: () =>
      bulkConfiguration.providerConfigurationFingerprint,
  });
  const isActiveOwner = createActiveOwnerCheck({
    siteId,
    database: () => environment.FOUNDRY_DB,
  });

  const audience = createCampaignBulkAudience({
    siteId,
    store: subscriberStore,
  });

  return createCampaignBulkDeliveryApplication({
    siteId,
    store: createD1CampaignBulkStateStore(environment.FOUNDRY_DB),
    loadSource,
    authorizeOwner: async () => {
      throw new AccessDeniedError("capability_not_authorized");
    },
    identifyActor: () => "system:scheduler",
    validateOwnerAuthority: async (ownerActorId) =>
      (await isActiveOwner(ownerActorId)) ?? false,
    resolveAudience: audience.resolve,
    resolveAudienceByIds: audience.resolveByIds,
    applyProviderSuppression: createProviderSuppressionRecorder({
      siteId,
      store: subscriberStore,
      identityKeySecret: readSubscriberIdentityKeySecret(environment),
    }),
    artifactPublisher: createGitHubContentPublisher({
      configuration: readGitHubContentPublisherConfiguration(environment),
    }),
    adapter: createBrevoCampaignBulkDeliveryAdapter({
      apiKey,
      providerConfigurationFingerprint:
        bulkConfiguration.providerConfigurationFingerprint,
      senders,
    }),
    fingerprintKey,
    maximumAudienceRecipients: brevoBulkRecipientLimit,
  });
}

export async function runScheduledCampaignBulkDeliveries(
  environment: HumanAccessEnvironment,
) {
  if (environment.FOUNDRY_DB === undefined) {
    throw new Error("campaign_bulk_delivery_not_configured");
  }
  const application = await createDurableCampaignBulkDeliveryApplication({
    ...environment,
    FOUNDRY_DB: environment.FOUNDRY_DB,
  });
  for (
    let claimed = await application.scheduler.claimDue();
    claimed !== null;
    claimed = await application.scheduler.claimDue()
  ) {
    try {
      // The claim handed this worker the operation's lease; presenting it is
      // how the executor proves it is the holder.
      await application.scheduler.execute(claimed.id, claimed.leaseToken);
    } catch (error) {
      // The operation's durable state already records the outcome, but a
      // repeatedly failing schedule is invisible without a reason to look at.
      // Only the stable reason code and the operation identity are logged;
      // neither carries subscriber or credential material.
      console.error(
        "scheduled_campaign_delivery_failed",
        JSON.stringify({
          operationId: claimed.id,
          reason:
            error instanceof CampaignBulkDeliveryError
              ? error.code
              : "bulk_execution_failed",
        }),
      );
    }
  }
  await application.scheduler.reconcilePending();
}

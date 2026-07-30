import {
  createSubscriberIdentityKey,
  hmacSha256CanonicalJson,
  normalizeSubscriberEmail,
  type VerifiedCampaignDeliveryEvent,
} from "@foundry/application";
import { referenceSiteDefinition, type SiteId } from "@foundry/site-definition";

import {
  brevoBulkCorrelationId,
  normalizedBrevoEventType,
} from "./brevo-campaign-event-normalization";

import type { AuthenticatedBrevoBulkWebhookEvent } from "./brevo-test-webhook-runtime";
import { createDurableCampaignBulkDeliveryApplication } from "./campaign-bulk-scheduler-runtime";
import type { HumanAccessEnvironment } from "./human-access-configuration";
import { readSubscriberIdentityKeySecret } from "./human-access-configuration";

export async function normalizeAuthenticatedBrevoBulkWebhookEvent({
  event,
  siteId,
  identityKeySecret,
  fingerprintKey,
}: {
  event: AuthenticatedBrevoBulkWebhookEvent;
  siteId: SiteId;
  identityKeySecret: string;
  fingerprintKey: string;
}): Promise<VerifiedCampaignDeliveryEvent | null> {
  const type = normalizedBrevoEventType(event.eventType);
  if (type === null) return null;
  const email = normalizeSubscriberEmail(event.recipient);
  const recipientIdentityKey = await createSubscriberIdentityKey(
    email,
    identityKeySecret,
  );
  const providerCampaignId = brevoBulkCorrelationId(event.operationId);
  const stableIdentity = {
    siteId,
    provider: "brevo",
    operationId: event.operationId,
    providerCampaignId,
    providerMessageId: event.providerMessageId,
    providerSendProof: event.providerSendProof,
    recipientIdentityKey,
    type,
    providerOccurredAt: event.providerOccurredAt,
  };
  const payloadFingerprint = await hmacSha256CanonicalJson(fingerprintKey, {
    version: "foundry.brevo-bulk-webhook-payload.v1",
    ...stableIdentity,
  });
  const eventId = await hmacSha256CanonicalJson(fingerprintKey, {
    version: "foundry.brevo-bulk-webhook-event.v1",
    ...stableIdentity,
  });
  return Object.freeze({
    eventId,
    payloadFingerprint,
    siteId,
    operationId: event.operationId,
    providerCampaignId,
    providerMessageId: event.providerMessageId,
    providerSendProof: event.providerSendProof,
    recipientIdentityKey,
    type,
    occurredAt: event.providerOccurredAt ?? event.receivedAt,
    receivedAt: event.receivedAt,
    source: "webhook" as const,
  });
}

export async function createBrevoCampaignBulkWebhookIngestor(
  environment: HumanAccessEnvironment & {
    FOUNDRY_DB: NonNullable<HumanAccessEnvironment["FOUNDRY_DB"]>;
  },
) {
  const siteId = referenceSiteDefinition.site.id;
  const identityKeySecret = readSubscriberIdentityKeySecret(environment);
  const fingerprintKey =
    environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY?.trim() ?? "";
  if (fingerprintKey.length < 32) {
    throw new Error("campaign_bulk_webhook_proof_key_invalid");
  }
  const bulk = await createDurableCampaignBulkDeliveryApplication(environment);

  return async (event: AuthenticatedBrevoBulkWebhookEvent) => {
    const normalized = await normalizeAuthenticatedBrevoBulkWebhookEvent({
      event,
      siteId,
      identityKeySecret,
      fingerprintKey,
    });
    if (normalized === null) return;
    // Recording the event applies whatever suppression it implies, so this path
    // has nothing further to do.
    await bulk.commands.ingestVerifiedEvent(normalized);
  };
}

import {
  AccessDeniedError,
  CampaignValidationError,
  createSubscriberLedgerApplication,
  type CampaignBulkSource,
  type CampaignId,
  type CampaignStore,
  type CampaignSuppressionEventType,
  type CampaignTestDeliveryStore,
  type SubscriberLedgerStore,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1HumanAccessStore } from "./d1-human-access-store";

/**
 * What an authorization is checked against is one rule, not two. The Owner's
 * dashboard and the scheduler both read this module, so they cannot disagree
 * about which revision is current, which test evidence counts, or which sender
 * and provider configuration the artifact must still match.
 */
export function createCampaignBulkSourceReader({
  siteId,
  campaignStore,
  testStore,
  senders,
  senderFingerprints,
  providerConfigurationFingerprint,
  onResolved = () => {},
}: {
  siteId: SiteId;
  campaignStore: CampaignStore;
  testStore: CampaignTestDeliveryStore;
  senders: () => Readonly<Record<string, { email: string; name: string }>>;
  senderFingerprints: () => Readonly<Record<string, string>>;
  providerConfigurationFingerprint: () => string;
  /** Lets a caller mirror the resolved revision into development-only state. */
  onResolved?: (input: {
    campaignId: CampaignId;
    revisionId: string;
  }) => void;
}) {
  return async function loadSource(
    campaignId: CampaignId,
    testExecutionId: string,
  ): Promise<CampaignBulkSource> {
    const campaign = await campaignStore.findCampaign({ siteId, campaignId });
    if (campaign === null) {
      throw new CampaignValidationError("campaign_not_found");
    }
    const revision = await campaignStore.findRevision({
      siteId,
      campaignId,
      revisionNumber: campaign.version,
    });
    if (revision === null || revision.id !== campaign.currentRevisionId) {
      throw new CampaignValidationError("campaign_revision_not_found");
    }
    onResolved({ campaignId: campaign.id, revisionId: revision.id });
    const tested = await testStore.findByExecution({
      siteId,
      executionId: testExecutionId,
    });
    const confirmation =
      tested === null
        ? null
        : await testStore.findReceiptConfirmation({
            siteId,
            executionId: tested.executionId,
          });
    return {
      campaign,
      revision,
      evidence: tested?.evidence ?? null,
      confirmation,
      currentSenderFingerprint:
        senderFingerprints()[revision.senderIdentityId] ?? null,
      currentSender: senders()[revision.senderIdentityId] ?? null,
      currentProviderConfigurationFingerprint:
        providerConfigurationFingerprint(),
    };
  };
}

/**
 * Whether one stored actor is still an active Owner of this installation.
 * Authority is re-derived from D1 on every execution, so a removed or demoted
 * Owner's authorization stops being usable on the next command.
 */
export function createActiveOwnerCheck({
  siteId,
  database,
}: {
  siteId: SiteId;
  database: () => D1DatabaseBinding | null;
}) {
  return async function isActiveOwner(ownerActorId: string) {
    const binding = database();
    if (binding === null) return null;
    const memberships =
      await createD1HumanAccessStore(binding).listMemberships(siteId);
    return memberships.some(
      (membership) =>
        membership.id === ownerActorId &&
        membership.role === "owner" &&
        membership.status === "active",
    );
  };
}

/**
 * Apply a provider-reported negative subscriber state to the ledger. The ledger
 * application is constructed without any human capability, so this path can
 * record suppression and nothing else.
 */
export function createProviderSuppressionRecorder({
  siteId,
  store,
  identityKeySecret,
}: {
  siteId: SiteId;
  store: SubscriberLedgerStore;
  identityKeySecret: string;
}) {
  const ledger = createSubscriberLedgerApplication({
    siteId,
    store,
    identityKeySecret,
    authorize: async () => {
      throw new AccessDeniedError("capability_not_authorized");
    },
  });
  return async function applyProviderSuppression({
    providerEventId,
    recipientIdentityKey,
    reason,
    occurredAt,
  }: {
    providerEventId: string;
    recipientIdentityKey: string;
    reason: CampaignSuppressionEventType;
    occurredAt: string;
  }) {
    await ledger.provider.ingestSuppressionByIdentityKey({
      provider: "brevo",
      providerEventId,
      identityKey: recipientIdentityKey,
      reason,
      occurredAt,
    });
  };
}

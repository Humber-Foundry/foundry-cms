import "server-only";

import {
  AccessDeniedError,
  canonicalJson,
  createBlogPostRevisionId,
  createCampaignApplication,
  createCampaignBulkDeliveryApplication,
  createCampaignRevisionId,
  createCampaignTestDeliveryApplication,
  createInMemoryCampaignTestDeliveryStore,
  CampaignValidationError,
  createInMemoryCampaignBulkStateStore,
  createInMemoryCampaignStore,
  createInMemorySubscriberLedgerStore,
  createSubscriberLedgerAudienceResolver,
  sha256Text,
  type CampaignApplication,
  type CampaignBulkArtifactPublisher,
  type CampaignBulkDeliveryAdapter,
  type CampaignBulkDeliveryApplication,
  type CampaignBulkStateStore,
  type SubscriberLedgerStore,
  type CampaignTestDeliveryApplication,
  type CampaignTestDeliveryStore,
  type CampaignChannelConfiguration,
  type CampaignStore,
  type NewsletterDeliveryAdapter,
  type NewsletterProviderOwnershipEvidence,
} from "@humber-foundry/application";
import {
  type BlogPost,
  type SiteId,
} from "@humber-foundry/site-definition";
import { upgradeInstalledSiteDefinition } from "../foundry/site-definition";

import { readProviderOwnershipEvidence } from "./campaign-provider-ownership";
import { createD1CampaignStore } from "./d1-campaign-store";
import { createD1CampaignBulkStateStore } from "./d1-campaign-bulk-state-store";
import { createD1CampaignTestDeliveryStore } from "./d1-campaign-test-delivery-store";
import { createD1BrevoTestWebhookEvidenceStore } from "./d1-brevo-test-webhook-evidence-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import {
  loadHumanAccessRequestContext,
} from "./human-access-runtime";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import {
  readNewsletterDeliverySecret,
  readSubscriberIdentityKeySecret,
} from "./human-access-configuration";
import { readCampaignChannelConfiguration } from "./campaign-channel-configuration";
import { resolveContentReleaseInputs } from "./content-revision-runtime";
import { installedSite } from "../foundry/site-definition.server";
import {
  createSignedNewsletterDeliveryAdapter,
} from "./newsletter-unsubscribe-token";
import {
  createBrevoNewsletterDeliveryAdapter,
} from "./brevo-newsletter-delivery-adapter";
import {
  brevoBulkRecipientLimit,
  createBrevoCampaignBulkDeliveryAdapter,
} from "./brevo-campaign-bulk-delivery-adapter";
import {
  readBrevoCampaignDeliveryConfiguration,
} from "./brevo-campaign-delivery-configuration";
import { createCampaignBulkAudience } from "./campaign-bulk-audience";
import {
  createActiveOwnerCheck,
  createCampaignBulkSourceReader,
  createProviderSuppressionRecorder,
} from "./campaign-bulk-source";
import {
  createGitHubContentPublisher,
  readGitHubContentPublisherConfiguration,
} from "./github-content-publisher";

const localCampaignTestDeliveryStore =
  createInMemoryCampaignTestDeliveryStore();
const localCampaignStore = createInMemoryCampaignStore({
  cancelOpenTestDeliveries: (input) =>
    localCampaignTestDeliveryStore.cancelForCampaignEdit(input),
  persistTestReceiptConfirmation: async (confirmation) => {
    await localCampaignTestDeliveryStore.persistReceiptConfirmation(
      confirmation,
    );
  },
});
const localSubscriberStore = createInMemorySubscriberLedgerStore();
const localBulkCurrentRevisions = new Map<string, string>();
const localBulkActiveOwners = new Set(["membership-local-owner"]);
const localBulkActiveSubscribers = new Set<string>();
const localBulkStateStore = createInMemoryCampaignBulkStateStore({
  currentRevision: (campaignId) => {
    const revisionId = localBulkCurrentRevisions.get(campaignId);
    if (revisionId === undefined) {
      throw new Error("campaign_not_found");
    }
    return revisionId as ReturnType<typeof createCampaignRevisionId>;
  },
  activeOwners: localBulkActiveOwners,
  activeSubscribers: localBulkActiveSubscribers,
});
const developmentRendererCommit = "0000000000000000000000000000000000000000";
const developmentProviderOwnershipEvidence:
  NewsletterProviderOwnershipEvidence = Object.freeze({
    classification: "evaluation",
    evidenceId: "local-evaluation",
    accountScopeFingerprint: "0".repeat(64),
    verifiedAt: "1970-01-01T00:00:00.000Z",
  });
const developmentChannelConfiguration: CampaignChannelConfiguration = Object.freeze({
  senderIdentityId: "sender_primary",
  complianceFooter: Object.freeze({
    version: "local-footer-v1",
    content:
      "Foundry local development · Local development only · " +
      "Contact: https://example.test/contact · Newsletter preferences",
    unsubscribePlaceholder:
      "https://example.test/newsletter/unsubscribe" +
      "?token={{foundry.unsubscribe.token}}",
  }),
  audienceDefinition: Object.freeze({
    id: "canonical-consent-and-suppression" as const,
    version: 1 as const,
  }),
});

async function localPostRevision(
  siteId: SiteId,
  revisionId: string,
): Promise<BlogPost | null> {
  const definition =
    await installedSite.application.queries.getPublishedSite();
  for (const post of definition.blog.posts) {
    const contentHash = await sha256Text(canonicalJson(post));
    const candidate = await createBlogPostRevisionId(
      siteId,
      post.id,
      post.revision,
      contentHash,
    );
    if (candidate === revisionId) return post;
  }
  return null;
}

async function d1PostRevision(
  database: D1DatabaseBinding,
  siteId: SiteId,
  revisionId: string,
): Promise<BlogPost | null> {
  const row = await database
    .prepare(
      `SELECT cr.definition_json, bra.post_id, bra.post_revision
       FROM blog_post_render_artifacts bra
       JOIN content_revisions cr
         ON cr.workspace_id = bra.workspace_id
        AND cr.revision = bra.content_revision
       JOIN content_workspaces cw ON cw.workspace_id = cr.workspace_id
       WHERE cw.site_id = ?1 AND bra.post_revision_id = ?2
       ORDER BY bra.created_at DESC LIMIT 1`,
    )
    .bind(siteId, revisionId)
    .first<{
      definition_json: string;
      post_id: string;
      post_revision: number;
    }>();
  if (row === null) return null;
  const definition = upgradeInstalledSiteDefinition(JSON.parse(row.definition_json));
  return definition.blog.posts.find(
    (post) =>
      post.id === row.post_id && post.revision === row.post_revision,
  ) ?? null;
}

export async function loadCampaignRequestContext(
  requestHeaders: Headers,
): Promise<Readonly<{
  identity: Awaited<
    ReturnType<typeof loadHumanAccessRequestContext>
  >["identity"];
  application: CampaignApplication;
  testDelivery: CampaignTestDeliveryApplication;
  bulkDelivery: CampaignBulkDeliveryApplication;
}>> {
  const human = await loadHumanAccessRequestContext(requestHeaders);
  if (human.state !== "authorized") {
    throw new AccessDeniedError("capability_not_authorized");
  }
  let store: CampaignStore = localCampaignStore;
  let subscriberStore: SubscriberLedgerStore = localSubscriberStore;
  let bulkStateStore: CampaignBulkStateStore = localBulkStateStore;
  let resolveAudience = createSubscriberLedgerAudienceResolver({
    siteId: installedSite.application.siteId,
    store: localSubscriberStore,
  });
  let findPostRevision = localPostRevision;
  let rendererCommit = developmentRendererCommit;
  let channelConfiguration = developmentChannelConfiguration;
  let testDeliveryStore: CampaignTestDeliveryStore =
    localCampaignTestDeliveryStore;
  let recipientFingerprintKey =
    "foundry-development-recipient-fingerprint-key-v1";
  let testRecipients: Readonly<Record<string, string>> = {};
  let bulkFingerprintKey =
    "foundry-development-campaign-bulk-fingerprint-key-v1";
  let bulkProviderConfigurationFingerprint = "0".repeat(64);
  let bulkSenderFingerprints: Readonly<Record<string, string>> = {};
  let bulkSenders: Readonly<
    Record<string, { id: number; email: string; name: string }>
  > = {};
  let bulkAdapter: CampaignBulkDeliveryAdapter = {
    providerCampaignIdFor: (operationId) => `local-bulk-${operationId}`,
    async sendBulk() {
      return { outcome: "rejected", code: "provider_unavailable" };
    },
    async reconcileBulk() {
      return {
        outcome: "ambiguous",
        providerCampaignId: null,
        code: "provider_unavailable",
      };
    },
  };
  let bulkArtifactPublisher: CampaignBulkArtifactPublisher = {
    async publish() {
      return { outcome: "committed" as const, commitSha: "0".repeat(40) };
    },
    async reconcile() {
      return { outcome: "not_found" as const };
    },
  };
  let durableDatabase: D1DatabaseBinding | null = null;
  let subscriberIdentityKeySecret =
    "local-development-subscriber-identity-secret";
  let testAdapter: NewsletterDeliveryAdapter = {
    async capabilities() {
      return {
        provider: "brevo",
        configurationFingerprint: "0".repeat(64),
        senderConfigurationFingerprints: {},
        apiTestDelivery: "supported" as const,
        explicitRecipients: "supported" as const,
        ambiguousOutcomeReconciliation: "supported" as const,
        plainTextArtifact: "unsupported" as const,
      };
    },
    async health() {
      return {
        state: "unavailable" as const,
        credential: "unknown" as const,
        senderIdentity: "unknown" as const,
      };
    },
    async prepareTest() {
      return { outcome: "rejected" as const, code: "provider_unavailable" };
    },
    async sendTest() {
      return { outcome: "rejected" as const, code: "provider_unavailable" };
    },
    async reconcileTest() {
      return { outcome: "not_found" as const };
    },
  };
  let providerOwnershipEvidence = developmentProviderOwnershipEvidence;
  if (process.env.NODE_ENV !== "development") {
    const environment = await loadHumanAccessEnvironment();
    if (environment.FOUNDRY_DB === undefined) {
      throw new Error("campaign_database_unavailable");
    }
    rendererCommit = resolveContentReleaseInputs(environment).rendererVersion;
    const deliveryAdapter = createSignedNewsletterDeliveryAdapter({
      unsubscribeUrl:
        environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL ?? "",
      secret: readNewsletterDeliverySecret(environment),
    });
    channelConfiguration = readCampaignChannelConfiguration(
      environment,
      deliveryAdapter.unsubscribePlaceholder,
    );
    store = createD1CampaignStore(environment.FOUNDRY_DB);
    durableDatabase = environment.FOUNDRY_DB;
    subscriberIdentityKeySecret = readSubscriberIdentityKeySecret(environment);
    bulkStateStore = createD1CampaignBulkStateStore(environment.FOUNDRY_DB);
    testDeliveryStore = createD1CampaignTestDeliveryStore(
      environment.FOUNDRY_DB,
    );
    subscriberStore = createD1SubscriberLedgerStore(environment.FOUNDRY_DB);
    resolveAudience = createSubscriberLedgerAudienceResolver({
      siteId: installedSite.application.siteId,
      store: subscriberStore,
    });
    findPostRevision = (siteId, revisionId) =>
      d1PostRevision(environment.FOUNDRY_DB!, siteId, revisionId);
    const apiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
    const installationProofKey =
      environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY?.trim() ?? "";
    recipientFingerprintKey = installationProofKey;
    bulkFingerprintKey = installationProofKey;
    const webhookAuthenticationToken =
      environment.FOUNDRY_BREVO_WEBHOOK_AUTH_TOKEN?.trim() ?? "";
    const accountScopeFingerprint =
      environment.FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT?.trim() ?? "";
    if (webhookAuthenticationToken.length < 32) {
      throw new Error("brevo_webhook_authentication_token_invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(accountScopeFingerprint)) {
      throw new Error("brevo_account_scope_fingerprint_invalid");
    }
    providerOwnershipEvidence = readProviderOwnershipEvidence(
      environment.FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON,
      accountScopeFingerprint,
    );
    const senders = JSON.parse(
      environment.FOUNDRY_BREVO_SENDERS_JSON ?? "{}",
    ) as Record<string, { id: number; email: string; name: string }>;
    bulkSenders = senders;
    testRecipients = JSON.parse(
      environment.FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON ?? "{}",
    ) as Record<string, string>;
    const bulkConfiguration = await readBrevoCampaignDeliveryConfiguration(
      environment,
      senders,
    );
    bulkProviderConfigurationFingerprint =
      bulkConfiguration.providerConfigurationFingerprint;
    bulkSenderFingerprints = bulkConfiguration.senderFingerprints;
    testAdapter = createBrevoNewsletterDeliveryAdapter({
      apiKey,
      configurationFingerprint: bulkProviderConfigurationFingerprint,
      accountScopeFingerprint,
      installationProofKey,
      senders,
      webhookEvidence: createD1BrevoTestWebhookEvidenceStore({
        database: environment.FOUNDRY_DB,
        siteId: installedSite.application.siteId,
      }),
    });
    bulkAdapter = createBrevoCampaignBulkDeliveryAdapter({
      apiKey,
      providerConfigurationFingerprint: bulkProviderConfigurationFingerprint,
      senders,
    });
    bulkArtifactPublisher = createGitHubContentPublisher({
      configuration: readGitHubContentPublisherConfiguration(environment),
    });
  }
  const application = createCampaignApplication({
    siteId: installedSite.application.siteId,
    store,
    authorize: (actor, capability) =>
      human.application.queries.requireCapability({
        actor,
        capability:
          capability === "campaign.author"
            ? "content.write"
            : capability,
      }),
    identifyActor: () => human.membership.id,
    findPostRevision,
    resolveAudience,
    channelConfiguration,
    rendererVersion: rendererCommit,
    schemaVersion: "1.3.0",
  });
  const audience = createCampaignBulkAudience({
    siteId: installedSite.application.siteId,
    store: subscriberStore,
  });
  const isActiveOwner = createActiveOwnerCheck({
    siteId: installedSite.application.siteId,
    database: () => durableDatabase,
  });
  const loadBulkSource = createCampaignBulkSourceReader({
    siteId: installedSite.application.siteId,
    campaignStore: store,
    testStore: testDeliveryStore,
    senders: () => bulkSenders,
    senderFingerprints: () => bulkSenderFingerprints,
    providerConfigurationFingerprint: () =>
      bulkProviderConfigurationFingerprint,
    onResolved: ({ campaignId, revisionId }) => {
      if (durableDatabase === null) {
        localBulkCurrentRevisions.set(campaignId, revisionId);
      }
    },
  });
  const bulkDelivery = createCampaignBulkDeliveryApplication({
    siteId: installedSite.application.siteId,
    store: bulkStateStore,
    loadSource: loadBulkSource,
    authorizeOwner: (actor) =>
      human.application.queries.requireCapability({
        actor,
        capability: "campaign.bulk.authorize",
      }),
    identifyActor: () => human.membership.id,
    validateOwnerAuthority: async (ownerActorId) =>
      (await isActiveOwner(ownerActorId)) ??
      localBulkActiveOwners.has(ownerActorId),
    resolveAudience: async (revision) => {
      const recipients = await audience.resolve(revision);
      if (durableDatabase === null) {
        localBulkActiveSubscribers.clear();
        for (const recipient of recipients) {
          localBulkActiveSubscribers.add(recipient.subscriberId);
        }
      }
      return recipients;
    },
    resolveAudienceByIds: audience.resolveByIds,
    applyProviderSuppression: createProviderSuppressionRecorder({
      siteId: installedSite.application.siteId,
      store: subscriberStore,
      identityKeySecret: subscriberIdentityKeySecret,
    }),
    artifactPublisher: bulkArtifactPublisher,
    adapter: bulkAdapter,
    fingerprintKey: bulkFingerprintKey,
    maximumAudienceRecipients: brevoBulkRecipientLimit,
  });
  return {
    identity: human.identity,
    application,
    bulkDelivery,
    testDelivery: createCampaignTestDeliveryApplication({
      siteId: installedSite.application.siteId,
      campaignStore: store,
      store: testDeliveryStore,
      adapter: testAdapter,
      authorize: (actor, capability) =>
        human.application.queries.requireCapability({
          actor,
          capability:
            capability === "campaign.author"
              ? "content.write"
              : capability,
        }),
      identifyActor: () => human.membership.id,
      resolveAudience,
      activeRendererVersion: () => rendererCommit,
      resolveTestRecipients: async (recipientIds) => {
        const activeOwnerIds = new Set<string>(
          (
            await human.application.queries
              .listActiveOwnerIdsForTestDelivery({
                actor: human.identity,
              })
          ),
        );
        return recipientIds.map((id) => {
          if (!activeOwnerIds.has(id)) {
            throw new CampaignValidationError("test_recipient_forbidden");
          }
          const address = testRecipients[id];
          if (
            typeof address !== "string" ||
            address.trim() === ""
          ) {
            throw new CampaignValidationError("test_recipient_forbidden");
          }
          return { id, address: address.trim() };
        });
      },
      providerOwnershipEvidence,
      recipientFingerprintKey,
      replayTestCommand: ({
        actor,
        requestId,
        command,
        targetId,
        commandName,
      }) =>
        application.commands.replayTestCommand({
          actor,
          requestId,
          command,
          targetId,
          commandName,
        }),
      recordAcceptedTestCommand: ({
        actor,
        requestId,
        command,
        campaign,
        revision,
        beforeState,
        afterState,
        targetId,
        commandName,
      }) =>
        application.commands.recordAcceptedTestCommand({
          actor,
          requestId,
          command,
          campaign,
          revision,
          beforeState,
          afterState,
          targetId,
          commandName,
        }),
      recordAcceptedTestReceiptConfirmation: (input) =>
        application.commands.recordAcceptedTestReceiptConfirmation(input),
      recordRejectedCommand: ({
        actor,
        requestId,
        reason,
        command,
        targetId,
        beforeState,
        commandName,
      }) =>
        application.commands.recordRejectedCommand({
          actor,
          requestId,
          reason,
          command,
          targetId,
          beforeState,
          action: "campaign.test",
          commandName: commandName ?? "campaign.request_test",
        }),
    }),
  };
}

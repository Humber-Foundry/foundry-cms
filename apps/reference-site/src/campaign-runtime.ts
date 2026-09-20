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
  configuredCampaignChannel,
  type CampaignChannelConfigurationState,
  type CampaignRevision,
  type CampaignStore,
  type NewsletterDeliveryAdapter,
  type NewsletterDeliveryHealth,
  type NewsletterProviderOwnershipEvidence,
} from "@humber-foundry/application";
import {
  mediaAssetIdFromImageAddress,
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
  readSubscriberIdentityKeySecret,
  type HumanAccessEnvironment,
} from "./human-access-configuration";
import { readCampaignChannelConfiguration } from "./campaign-channel-configuration";
import {
  campaignDeliverySetupGuide,
  listMissingCampaignDeliverySettings,
  listMissingCampaignSenderSettings,
  type CampaignDeliveryReadiness,
  type CampaignSenderReadiness,
} from "./campaign-delivery-readiness";
import { resolveContentReleaseInputs } from "./content-revision-runtime";
import { installedSite } from "../foundry/site-definition.server";
import {
  newsletterUnsubscribePlaceholder,
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
  GitHubContentPublisherConfigurationError,
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

/** Every gallery asset one campaign revision's images reference. */
function collectCampaignImageAssetIds(
  revision: CampaignRevision,
  into: Set<string>,
): void {
  for (const image of [revision.headerImage, revision.shareImage]) {
    if (image === null || image === undefined) continue;
    const assetId = mediaAssetIdFromImageAddress(image.url);
    if (assetId !== null) into.add(assetId);
  }
  for (const block of revision.emailContent.children) {
    if (block.type !== "image") continue;
    const assetId = mediaAssetIdFromImageAddress(block.src);
    if (assetId !== null) into.add(assetId);
  }
}

/**
 * The gallery assets every stored campaign references through its header image,
 * share image or an inline body image. A campaign image is meant to be seen by
 * every recipient, so the public media route serves these assets alongside the
 * assets the published site references. This reads the same campaign store the
 * authoring runtime uses, without a human capability, because it exposes only
 * which assets are referenced, never any campaign content. See ADR-0014.
 */
export async function listCampaignReferencedMediaAssetIds(): Promise<
  ReadonlySet<string>
> {
  const siteId = installedSite.application.siteId;
  let store: CampaignStore = localCampaignStore;
  if (process.env.NODE_ENV !== "development") {
    const environment = await loadHumanAccessEnvironment();
    if (environment.FOUNDRY_DB === undefined) {
      throw new Error("campaign_database_unavailable");
    }
    store = createD1CampaignStore(environment.FOUNDRY_DB);
  }
  const campaigns = await store.listCampaigns(siteId);
  const ids = new Set<string>();
  for (const campaign of campaigns) {
    const revision = await store.findRevision({
      siteId,
      campaignId: campaign.id,
      revisionNumber: campaign.version,
    });
    if (revision !== null) collectCampaignImageAssetIds(revision, ids);
  }
  return ids;
}

const developmentRendererCommit = "0000000000000000000000000000000000000000";
const developmentProviderOwnershipEvidence:
  NewsletterProviderOwnershipEvidence = Object.freeze({
    classification: "evaluation",
    evidenceId: "local-evaluation",
    accountScopeFingerprint: "0".repeat(64),
    verifiedAt: "1970-01-01T00:00:00.000Z",
  });
const developmentChannelConfiguration: CampaignChannelConfigurationState =
  configuredCampaignChannel(
    Object.freeze({
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
    }),
  );

/**
 * The verified test address on file for one membership, or null.
 *
 * Who may receive a test and who may be offered one must never disagree, so
 * both the send path and the screen's list read this one function. It returns
 * the address to the caller that sends; no caller may put it on screen.
 */
function verifiedTestAddress(
  recipients: Readonly<Record<string, string>>,
  membershipId: string,
): string | null {
  const address = recipients[membershipId];
  return typeof address === "string" && address.trim() !== ""
    ? address.trim()
    : null;
}

/**
 * The campaign channel configuration for one installation.
 *
 * The compliance footer it builds is stored on every campaign revision and is
 * read by whoever receives the email, so it is always built from the
 * installation's own settings. Foundry never stands in for it, and it is built
 * the same way whether or not the delivery secrets are installed.
 *
 * The unsubscribe address needs the configured address only. The delivery
 * secret signs a real token later, at send time.
 *
 * An absent setting is a value, not a fault. The Newsletter page still loads
 * and names what is missing; writing and sending are refused instead.
 */
export function resolveCampaignChannelConfiguration(
  environment: HumanAccessEnvironment,
): CampaignChannelConfigurationState {
  let placeholder = "";
  try {
    placeholder = newsletterUnsubscribePlaceholder(
      environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL ?? "",
    );
  } catch {
    // An absent or malformed unsubscribe address is a configuration fault.
    // Passing the empty address on lets the channel reader name it the same
    // way it names every other absent compliance setting, rather than raising
    // a bare URL error.
    placeholder = "";
  }
  return readCampaignChannelConfiguration(environment, placeholder);
}

/**
 * The send-artifact publisher used when delivery is not configured. It fails
 * rather than reporting a commit. The local development publisher reports a
 * fake commit, which must never stand in for a real one outside development.
 */
const notConfiguredArtifactPublisher: CampaignBulkArtifactPublisher =
  Object.freeze({
    async publish() {
      return {
        outcome: "failed" as const,
        code: "newsletter_delivery_not_configured",
      };
    },
    async reconcile() {
      return { outcome: "not_found" as const };
    },
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

/**
 * What a caller needs to report delivery readiness: the settings-level answer,
 * and a way to ask the provider about its own health.
 */
export type CampaignDeliveryContext = Readonly<{
  /**
   * Whether email delivery is connected for this installation, and the names
   * of the settings it still needs. It never carries a setting's value.
   */
  delivery: CampaignDeliveryReadiness;
  /**
   * Whether this installation has set the sender identity and the legal
   * footer that must appear at the bottom of every email. Reported separately
   * from the delivery secrets, because they are separate settings with
   * separate consequences: without the footer nothing may be written or sent
   * at all, even when the provider is reachable.
   */
  senderDetails: CampaignSenderReadiness;
  /** What the delivery provider reports about its own credential and sender. */
  readDeliveryHealth: () => Promise<NewsletterDeliveryHealth>;
}>;

export async function loadCampaignRequestContext(
  requestHeaders: Headers,
): Promise<Readonly<CampaignDeliveryContext & {
  identity: Awaited<
    ReturnType<typeof loadHumanAccessRequestContext>
  >["identity"];
  application: CampaignApplication;
  testDelivery: CampaignTestDeliveryApplication;
  bulkDelivery: CampaignBulkDeliveryApplication;
  /**
   * The test recipients this installation has verified, by membership id only.
   * A test address is a person's own mailbox, so it is never returned, logged
   * or shown. `yours` names the signed-in person's own id when they are one of
   * them, which lets the screen offer "send a test to your own address" without
   * ever naming an address.
   */
  listTestRecipients(): Promise<
    Readonly<{ ids: ReadonlyArray<string>; yours: string | null }>
  >;
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
  let delivery: CampaignDeliveryReadiness = Object.freeze({
    state: "local_development" as const,
    missingSettings: Object.freeze([]),
    providerHealth: null,
    setupGuide: campaignDeliverySetupGuide,
  });
  let senderDetails: CampaignSenderReadiness = Object.freeze({
    state: "local_development" as const,
    missingSettings: Object.freeze([]),
    setupGuide: campaignDeliverySetupGuide,
  });
  if (process.env.NODE_ENV !== "development") {
    const environment = await loadHumanAccessEnvironment();
    // A missing database is a fault, not a missing delivery setting. Nothing
    // in the newsletter works without it, so it still stops the request.
    if (environment.FOUNDRY_DB === undefined) {
      throw new Error("campaign_database_unavailable");
    }
    const missingSettings = listMissingCampaignDeliverySettings(environment);
    delivery = Object.freeze({
      state:
        missingSettings.length === 0
          ? ("connected" as const)
          : ("not_configured" as const),
      missingSettings,
      providerHealth: null,
      setupGuide: campaignDeliverySetupGuide,
    });
    rendererCommit = resolveContentReleaseInputs(environment).rendererVersion;
    store = createD1CampaignStore(environment.FOUNDRY_DB);
    durableDatabase = environment.FOUNDRY_DB;
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
    channelConfiguration = resolveCampaignChannelConfiguration(environment);
    // The sender details are separate settings from the delivery secrets, so
    // they are reported under their own heading. The page loads either way.
    const missingSenderSettings =
      listMissingCampaignSenderSettings(environment);
    senderDetails = Object.freeze(
      channelConfiguration.state === "configured"
        ? {
            state: "connected" as const,
            missingSettings: Object.freeze([]),
            setupGuide: campaignDeliverySetupGuide,
          }
        : {
            state: "not_configured" as const,
            // The channel reader and this list apply the same rule to the same
            // settings. Naming the unsubscribe address covers the one case the
            // reader can still refuse with nothing else missing: an address
            // that parses but cannot carry the unsubscribe token.
            missingSettings:
              missingSenderSettings.length > 0
                ? missingSenderSettings
                : Object.freeze(["FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL" as const]),
            setupGuide: campaignDeliverySetupGuide,
          },
    );
    if (delivery.state !== "connected") {
      // Delivery is not configured. Writing and saving a campaign still work,
      // so the Newsletter page renders. Every provider adapter stays the
      // fail-closed one declared above, and the send-artifact publisher fails
      // rather than reporting a commit, so nothing can be sent from here.
      bulkArtifactPublisher = notConfiguredArtifactPublisher;
    } else {
      subscriberIdentityKeySecret =
        readSubscriberIdentityKeySecret(environment);
      const apiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
      const installationProofKey =
        environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY?.trim() ?? "";
      recipientFingerprintKey = installationProofKey;
      bulkFingerprintKey = installationProofKey;
      const accountScopeFingerprint =
        environment.FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT?.trim() ?? "";
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
      // Git publishing is configured separately from delivery. Without it a
      // send cannot commit its artifact, so the publisher fails rather than
      // stopping the Newsletter page from loading. Ticket #165 reports
      // publishing readiness on screen.
      try {
        bulkArtifactPublisher = createGitHubContentPublisher({
          configuration: readGitHubContentPublisherConfiguration(environment),
        });
      } catch (error) {
        if (!(error instanceof GitHubContentPublisherConfigurationError)) {
          throw error;
        }
        bulkArtifactPublisher = notConfiguredArtifactPublisher;
      }
    }
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
    siteCanonicalOrigin: installedSite.definition.site.canonicalOrigin,
    rendererVersion: rendererCommit,
    schemaVersion: "1.7.0",
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
    // An Editor writes campaigns, so an Editor may read where a campaign has
    // got to. Reading grants nothing; only `authorizeOwner` above admits the
    // Owner commands.
    authorizeRead: (actor) =>
      human.application.queries.requireCapability({
        actor,
        capability: "content.write",
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
    // A suppression is written under the installation's subscriber identity
    // secret. Without that secret the fingerprint would not match the same
    // subscriber later, so this refuses rather than writing one that cannot be
    // matched.
    applyProviderSuppression:
      delivery.state === "not_configured"
        ? async () => {
            throw new Error("newsletter_delivery_not_configured");
          }
        : createProviderSuppressionRecorder({
            siteId: installedSite.application.siteId,
            store: subscriberStore,
            identityKeySecret: subscriberIdentityKeySecret,
          }),
    artifactPublisher: bulkArtifactPublisher,
    adapter: bulkAdapter,
    channelConfiguration,
    fingerprintKey: bulkFingerprintKey,
    maximumAudienceRecipients: brevoBulkRecipientLimit,
  });
  return {
    identity: human.identity,
    application,
    delivery,
    senderDetails,
    readDeliveryHealth: () => testAdapter.health(),
    bulkDelivery,
    listTestRecipients: async () => {
      const ownerIds =
        await human.application.queries.listActiveOwnerIdsForTestDelivery({
          actor: human.identity,
        });
      // An owner without a configured address cannot receive a test, so
      // offering them would promise a send that always fails.
      const ids = ownerIds.filter(
        (id) => verifiedTestAddress(testRecipients, id) !== null,
      );
      return Object.freeze({
        ids: Object.freeze(ids),
        yours: ids.includes(human.membership.id) ? human.membership.id : null,
      });
    },
    testDelivery: createCampaignTestDeliveryApplication({
      siteId: installedSite.application.siteId,
      campaignStore: store,
      store: testDeliveryStore,
      adapter: testAdapter,
      channelConfiguration,
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
          const address = activeOwnerIds.has(id)
            ? verifiedTestAddress(testRecipients, id)
            : null;
          if (address === null) {
            throw new CampaignValidationError("test_recipient_forbidden");
          }
          return { id, address };
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

/**
 * Whether email delivery is connected for this installation.
 *
 * This is a read-only report for the dashboard and for an agent. It names the
 * settings that are still missing and never returns a setting's value, a
 * provider token or a personal email address. When every setting is installed
 * it also reports what the provider says about its own credential and sender
 * identity; a provider that cannot be reached is reported as unavailable
 * rather than failing the whole request.
 */
export async function readCampaignDeliveryReadiness(
  context: CampaignDeliveryContext,
): Promise<CampaignDeliveryReadiness> {
  if (context.delivery.state !== "connected") return context.delivery;
  let providerHealth: NewsletterDeliveryHealth;
  try {
    providerHealth = await context.readDeliveryHealth();
  } catch {
    providerHealth = Object.freeze({
      state: "unavailable" as const,
      credential: "unknown" as const,
      senderIdentity: "unknown" as const,
    });
  }
  return Object.freeze({ ...context.delivery, providerHealth });
}

import "server-only";

import {
  AccessDeniedError,
  canonicalJson,
  createBlogPostRevisionId,
  createCampaignApplication,
  createCampaignTestDeliveryApplication,
  createInMemoryCampaignTestDeliveryStore,
  CampaignValidationError,
  createInMemoryCampaignStore,
  createInMemorySubscriberLedgerStore,
  createSubscriberLedgerAudienceResolver,
  sha256Text,
  sha256CanonicalJson,
  type CampaignApplication,
  type CampaignTestDeliveryApplication,
  type CampaignTestDeliveryStore,
  type CampaignChannelConfiguration,
  type CampaignStore,
  type NewsletterDeliveryAdapter,
} from "@foundry/application";
import {
  upgradeSiteDefinition,
  type BlogPost,
  type SiteId,
} from "@foundry/site-definition";

import { createD1CampaignStore } from "./d1-campaign-store";
import { createD1CampaignTestDeliveryStore } from "./d1-campaign-test-delivery-store";
import type { D1DatabaseBinding } from "./d1-human-access-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import {
  loadHumanAccessRequestContext,
} from "./human-access-runtime";
import { loadHumanAccessEnvironment } from "./human-access-environment";
import {
  readNewsletterDeliverySecret,
} from "./human-access-configuration";
import { readCampaignChannelConfiguration } from "./campaign-channel-configuration";
import { resolveContentReleaseInputs } from "./content-revision-runtime";
import { referenceSiteApplication } from "./reference-installation";
import {
  createSignedNewsletterDeliveryAdapter,
} from "./newsletter-unsubscribe-token";
import {
  createBrevoNewsletterDeliveryAdapter,
} from "./brevo-newsletter-delivery-adapter";

const localCampaignStore = createInMemoryCampaignStore();
const localCampaignTestDeliveryStore =
  createInMemoryCampaignTestDeliveryStore();
const localSubscriberStore = createInMemorySubscriberLedgerStore();
const developmentRendererCommit = "0000000000000000000000000000000000000000";
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
    await referenceSiteApplication.queries.getPublishedSite();
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
  const definition = upgradeSiteDefinition(JSON.parse(row.definition_json));
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
}>> {
  const human = await loadHumanAccessRequestContext(requestHeaders);
  if (human.state !== "authorized") {
    throw new AccessDeniedError("capability_not_authorized");
  }
  let store: CampaignStore = localCampaignStore;
  let resolveAudience = createSubscriberLedgerAudienceResolver({
    siteId: referenceSiteApplication.siteId,
    store: localSubscriberStore,
  });
  let findPostRevision = localPostRevision;
  let rendererCommit = developmentRendererCommit;
  let channelConfiguration = developmentChannelConfiguration;
  let testDeliveryStore: CampaignTestDeliveryStore =
    localCampaignTestDeliveryStore;
  let testRecipients: Readonly<Record<string, string>> = {};
  let testAdapter: NewsletterDeliveryAdapter = {
    async capabilities() {
      return {
        provider: "brevo",
        configurationFingerprint: "0".repeat(64),
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
    async sendTest() {
      return { outcome: "rejected" as const, code: "provider_unavailable" };
    },
    async reconcileTest() {
      return { outcome: "not_found" as const };
    },
  };
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
    testDeliveryStore = createD1CampaignTestDeliveryStore(
      environment.FOUNDRY_DB,
    );
    resolveAudience = createSubscriberLedgerAudienceResolver({
      siteId: referenceSiteApplication.siteId,
      store: createD1SubscriberLedgerStore(environment.FOUNDRY_DB),
    });
    findPostRevision = (siteId, revisionId) =>
      d1PostRevision(environment.FOUNDRY_DB!, siteId, revisionId);
    const apiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
    const accountScopeFingerprint =
      environment.FOUNDRY_BREVO_ACCOUNT_SCOPE_FINGERPRINT?.trim() ?? "";
    if (!/^[a-f0-9]{64}$/u.test(accountScopeFingerprint)) {
      throw new Error("brevo_account_scope_fingerprint_invalid");
    }
    const senderIds = JSON.parse(
      environment.FOUNDRY_BREVO_SENDER_IDS_JSON ?? "{}",
    ) as Record<string, number>;
    testRecipients = JSON.parse(
      environment.FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON ?? "{}",
    ) as Record<string, string>;
    const configurationFingerprint = await sha256CanonicalJson({
      version: "foundry.brevo-test-configuration.v1",
      accountScopeFingerprint,
      senderIds,
      adapterVersion: "brevo-test-v1",
    });
    testAdapter = createBrevoNewsletterDeliveryAdapter({
      apiKey,
      configurationFingerprint,
      senderIds,
    });
  }
  const application = createCampaignApplication({
    siteId: referenceSiteApplication.siteId,
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
  return {
    identity: human.identity,
    application,
    testDelivery: createCampaignTestDeliveryApplication({
      siteId: referenceSiteApplication.siteId,
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
      resolveTestRecipients: async (recipientIds) =>
        recipientIds.map((id) => {
          const address = testRecipients[id];
          if (address === undefined) {
            throw new CampaignValidationError("test_recipient_forbidden");
          }
          return { id, address };
        }),
      recordRejectedCommand: ({
        actor,
        requestId,
        reason,
        command,
        targetId,
        beforeState,
      }) =>
        application.commands.recordRejectedCommand({
          actor,
          requestId,
          reason,
          command,
          targetId,
          beforeState,
          action: "campaign.test",
          commandName: "campaign.request_test",
        }),
    }),
  };
}

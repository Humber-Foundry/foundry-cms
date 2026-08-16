import {
  CampaignValidationError,
  createCampaignApplication,
  createCampaignTestDeliveryApplication,
  createSubscriberLedgerAudienceResolver,
  type CampaignActor,
  type CampaignApplication,
  type CampaignAudienceDefinition,
  type CampaignAuthor,
  type CampaignChannelConfiguration,
  type CampaignStore,
  type CampaignTestDeliveryApplication,
  type CampaignTestDeliveryStore,
  type McpCampaignRuntime,
  type McpConnectionPrincipal,
  type NewsletterDeliveryAdapter,
  type NewsletterProviderOwnershipEvidence,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "../foundry/site-definition";
import { type SiteId } from "@humber-foundry/site-definition";

import { createBrevoNewsletterDeliveryAdapter } from "./brevo-newsletter-delivery-adapter";
import { readProviderOwnershipEvidence } from "./campaign-provider-ownership";
import { readBrevoCampaignDeliveryConfiguration } from "./brevo-campaign-delivery-configuration";
import { readCampaignChannelConfiguration } from "./campaign-channel-configuration";
import { createD1BrevoTestWebhookEvidenceStore } from "./d1-brevo-test-webhook-evidence-store";
import { createD1CampaignStore } from "./d1-campaign-store";
import { createD1CampaignTestDeliveryStore } from "./d1-campaign-test-delivery-store";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
import { createSignedNewsletterDeliveryAdapter } from "./newsletter-unsubscribe-token";
import {
  HumanAccessConfigurationError,
  readNewsletterDeliverySecret,
  type HumanAccessEnvironment,
} from "./human-access-configuration";

/**
 * The MCP campaign path builds the same campaign and test-delivery
 * applications the human path builds, from the same installation building
 * blocks. It differs only in the actor: an MCP connection carries no human
 * role, so `authorize` here trusts the scope already checked at the MCP tool
 * boundary and never consults human membership. The one authority an agent
 * must never hold — choosing test recipients — stays in this module, which
 * sends only to the Owner-configured verified recipients.
 */

type OwnerMembership = Readonly<{
  id: string;
  role: string;
  status: string;
}>;

export type McpCampaignHumanStore = Readonly<{
  listMemberships(siteId: SiteId): Promise<ReadonlyArray<OwnerMembership>>;
}>;

function mcpCampaignActorId(principal: McpConnectionPrincipal): string {
  return `mcp-${principal.actorId}`;
}

/**
 * The campaign command layer is human-actor-typed, but the `authorize` and
 * `identifyActor` shims this module installs read only the actor id captured in
 * their closure — never the actor value the command is called with. One unused
 * sentinel makes that explicit rather than dressing a connection principal up
 * as a human identity that no code reads.
 */
const mcpUnusedCampaignActor = Object.freeze({}) as unknown as CampaignActor;

/**
 * The expensive, actor-independent pieces of one installation: the stores,
 * provider adapter, channel configuration, and the Owner-recipient lookup.
 * Built once per runtime instance and shared by every tool call, which only
 * differ by connection principal.
 */
type CampaignInstallationParts = Readonly<{
  siteId: SiteId;
  store: CampaignStore;
  testDeliveryStore: CampaignTestDeliveryStore;
  adapter: NewsletterDeliveryAdapter;
  channelConfiguration: CampaignChannelConfiguration;
  resolveAudience(
    definition: CampaignAudienceDefinition,
  ): Promise<Readonly<{ eligibleSubscriberCount: number }>>;
  providerOwnershipEvidence: NewsletterProviderOwnershipEvidence;
  recipientFingerprintKey: string;
  rendererVersion: string;
  testRecipients: Readonly<Record<string, string>>;
  listActiveOwnerIds(): Promise<ReadonlyArray<string>>;
}>;

async function loadInstallationParts(
  environment: HumanAccessEnvironment,
  humanStore: McpCampaignHumanStore,
): Promise<CampaignInstallationParts> {
  const database = environment.FOUNDRY_DB;
  if (database === undefined) {
    throw new HumanAccessConfigurationError();
  }
  const siteId = installedSiteDefinition.site.id;
  const { resolveContentReleaseInputs } = await import(
    "./content-revision-runtime"
  );
  const rendererVersion =
    resolveContentReleaseInputs(environment).rendererVersion;
  const deliveryAdapter = createSignedNewsletterDeliveryAdapter({
    unsubscribeUrl: environment.FOUNDRY_CAMPAIGN_UNSUBSCRIBE_URL ?? "",
    secret: readNewsletterDeliverySecret(environment),
  });
  const channelConfiguration = readCampaignChannelConfiguration(
    environment,
    deliveryAdapter.unsubscribePlaceholder,
  );
  const store = createD1CampaignStore(database);
  const testDeliveryStore = createD1CampaignTestDeliveryStore(database);
  const subscriberStore = createD1SubscriberLedgerStore(database);
  const resolveAudience = createSubscriberLedgerAudienceResolver({
    siteId,
    store: subscriberStore,
  });
  const apiKey = environment.FOUNDRY_BREVO_API_KEY?.trim() ?? "";
  const installationProofKey =
    environment.FOUNDRY_CAMPAIGN_TEST_PROOF_KEY?.trim() ?? "";
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
  const providerOwnershipEvidence = readProviderOwnershipEvidence(
    environment.FOUNDRY_BREVO_PROVISIONING_EVIDENCE_JSON,
    accountScopeFingerprint,
  );
  const senders = JSON.parse(
    environment.FOUNDRY_BREVO_SENDERS_JSON ?? "{}",
  ) as Record<string, { id: number; email: string; name: string }>;
  const testRecipients = JSON.parse(
    environment.FOUNDRY_CAMPAIGN_TEST_RECIPIENTS_JSON ?? "{}",
  ) as Record<string, string>;
  const bulkConfiguration = await readBrevoCampaignDeliveryConfiguration(
    environment,
    senders,
  );
  const adapter = createBrevoNewsletterDeliveryAdapter({
    apiKey,
    configurationFingerprint:
      bulkConfiguration.providerConfigurationFingerprint,
    accountScopeFingerprint,
    installationProofKey,
    senders,
    webhookEvidence: createD1BrevoTestWebhookEvidenceStore({
      database,
      siteId,
    }),
  });

  return Object.freeze({
    siteId,
    store,
    testDeliveryStore,
    adapter,
    channelConfiguration,
    resolveAudience,
    providerOwnershipEvidence,
    recipientFingerprintKey: installationProofKey,
    rendererVersion,
    testRecipients,
    async listActiveOwnerIds() {
      return (await humanStore.listMemberships(siteId))
        .filter(
          (membership) =>
            membership.role === "owner" && membership.status === "active",
        )
        .map((membership) => membership.id);
    },
  });
}

type BoundApplications = Readonly<{
  application: CampaignApplication;
  testDelivery: CampaignTestDeliveryApplication;
}>;

function bindApplications(
  parts: CampaignInstallationParts,
  actorId: string,
): BoundApplications {
  function authorize(): Promise<CampaignAuthor> {
    // The MCP scope was verified at the tool boundary. This is the campaign
    // authorization for an MCP actor, which never carries a human role.
    return Promise.resolve({ id: actorId });
  }
  const application = createCampaignApplication({
    siteId: parts.siteId,
    store: parts.store,
    authorize,
    identifyActor: () => actorId,
    // MCP never derives a campaign from a post, so the post lookup and the
    // site address that would make a post share image absolute are unused.
    findPostRevision: async () => null,
    resolveAudience: parts.resolveAudience,
    channelConfiguration: parts.channelConfiguration,
    siteCanonicalOrigin: "",
    rendererVersion: parts.rendererVersion,
    schemaVersion: "1.4.0",
  });
  const testDelivery = createCampaignTestDeliveryApplication({
    siteId: parts.siteId,
    campaignStore: parts.store,
    store: parts.testDeliveryStore,
    adapter: parts.adapter,
    authorize,
    identifyActor: () => actorId,
    resolveAudience: parts.resolveAudience,
    activeRendererVersion: () => parts.rendererVersion,
    resolveTestRecipients: async (recipientIds) => {
      const activeOwnerIds = new Set(await parts.listActiveOwnerIds());
      return recipientIds.map((id) => {
        if (!activeOwnerIds.has(id)) {
          throw new CampaignValidationError("test_recipient_forbidden");
        }
        const address = parts.testRecipients[id];
        if (typeof address !== "string" || address.trim() === "") {
          throw new CampaignValidationError("test_recipient_forbidden");
        }
        return { id, address: address.trim() };
      });
    },
    providerOwnershipEvidence: parts.providerOwnershipEvidence,
    recipientFingerprintKey: parts.recipientFingerprintKey,
    replayTestCommand: (input) => application.commands.replayTestCommand(input),
    recordAcceptedTestCommand: (input) =>
      application.commands.recordAcceptedTestCommand(input),
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
  });
  return { application, testDelivery };
}

export function createMcpCampaignRuntime({
  environment,
  humanStore,
}: {
  environment: HumanAccessEnvironment;
  humanStore: McpCampaignHumanStore;
}): McpCampaignRuntime {
  let parts: Promise<CampaignInstallationParts> | null = null;
  function load() {
    parts ??= loadInstallationParts(environment, humanStore);
    return parts;
  }

  async function configuredTestRecipientIds(
    installation: CampaignInstallationParts,
  ): Promise<ReadonlyArray<string>> {
    const activeOwnerIds = await installation.listActiveOwnerIds();
    return activeOwnerIds.filter((id) => {
      const address = installation.testRecipients[id];
      return typeof address === "string" && address.trim() !== "";
    });
  }

  return {
    async createStandalone({ principal, requestId, editable }) {
      const installation = await load();
      const { application } = bindApplications(
        installation,
        mcpCampaignActorId(principal),
      );
      return application.commands.createStandalone({
        actor: mcpUnusedCampaignActor,
        requestId,
        input: editable,
      });
    },
    async edit({ principal, requestId, campaignId, expectedVersion, editable }) {
      const installation = await load();
      const { application } = bindApplications(
        installation,
        mcpCampaignActorId(principal),
      );
      return application.commands.edit({
        actor: mcpUnusedCampaignActor,
        requestId,
        campaignId,
        expectedVersion,
        input: editable,
      });
    },
    async getCampaign({ principal, campaignId }) {
      const installation = await load();
      const { application } = bindApplications(
        installation,
        mcpCampaignActorId(principal),
      );
      const campaign = await application.queries.getCampaign({
        actor: mcpUnusedCampaignActor,
        campaignId,
      });
      const revision = await application.queries.getRevision({
        actor: mcpUnusedCampaignActor,
        campaignId,
        revisionNumber: campaign.version,
      });
      return { campaign, revision };
    },
    async requestTest({ principal, requestId, campaignId }) {
      const installation = await load();
      const actorId = mcpCampaignActorId(principal);
      const { testDelivery } = bindApplications(installation, actorId);
      const testRecipientIds = await configuredTestRecipientIds(installation);
      // A repeat of the same request id resolves to the same execution. The
      // pre-existing operation, if any, tells the agent this call replayed a
      // prior test rather than starting a new one.
      const priorOperation = await installation.testDeliveryStore.findByRequest({
        siteId: installation.siteId,
        actorId,
        requestId,
      });
      const operation = await testDelivery.commands.requestTest({
        actor: mcpUnusedCampaignActor,
        requestId,
        campaignId,
        testRecipientIds,
      });
      return { operation, replayed: priorOperation !== null };
    },
    async testReadiness({ principal, campaignId }) {
      const installation = await load();
      const { testDelivery } = bindApplications(
        installation,
        mcpCampaignActorId(principal),
      );
      return testDelivery.queries.readiness({
        actor: mcpUnusedCampaignActor,
        campaignId,
      });
    },
  };
}

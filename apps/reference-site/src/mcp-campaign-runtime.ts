import {
  campaignBulkStateReport,
  CampaignValidationError,
  createCampaignApplication,
  createCampaignTestDeliveryApplication,
  createSubscriberLedgerAudienceResolver,
  type CampaignActor,
  type CampaignApplication,
  type CampaignAudienceDefinition,
  type CampaignAuthor,
  type CampaignChannelConfigurationState,
  type CampaignScheduleProposalApplication,
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
import { resolveCampaignChannel } from "./campaign-channel-configuration";
import { environmentWithStoredSenderDetails } from "./stored-sender-details";
import { createD1BrevoTestWebhookEvidenceStore } from "./d1-brevo-test-webhook-evidence-store";
import { createD1CampaignBulkStateStore } from "./d1-campaign-bulk-state-store";
import { createD1CampaignScheduleProposalStore } from "./d1-campaign-schedule-proposal-store";
import { createD1CampaignStore } from "./d1-campaign-store";
import { createD1CampaignTestDeliveryStore } from "./d1-campaign-test-delivery-store";
import { readBlogPostTimeZoneDatabaseVersion } from "./blog-post-operations-runtime";
import { createCampaignScheduleRequests } from "./campaign-schedule-request-application";
import { createD1SubscriberLedgerStore } from "./d1-subscriber-ledger-store";
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
  channelConfiguration: CampaignChannelConfigurationState;
  resolveAudience(
    definition: CampaignAudienceDefinition,
  ): Promise<Readonly<{ eligibleSubscriberCount: number }>>;
  providerOwnershipEvidence: NewsletterProviderOwnershipEvidence;
  recipientFingerprintKey: string;
  rendererVersion: string;
  testRecipients: Readonly<Record<string, string>>;
  listActiveOwnerIds(): Promise<ReadonlyArray<string>>;
  bulkStateStore: ReturnType<typeof createD1CampaignBulkStateStore>;
  scheduleProposals: CampaignScheduleProposalApplication;
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
  // This is read before anything else that needs a campaign setting. The
  // compliance footer is stored on every campaign revision and is read by
  // whoever receives the email. Foundry never invents one, so an MCP client
  // may neither write nor read a campaign until the installation sets these
  // settings, and the reason is the same word the Newsletter page and the
  // scheduled worker report. Reading it first also keeps a malformed
  // unsubscribe address from raising a bare URL error out of the address
  // parser instead of this named reason.
  // A sender detail the Owner saved in Settings wins over the environment
  // variable of the same name, so an app reads the same footer the dashboard
  // shows (ADR-0048).
  const channelConfiguration = resolveCampaignChannel(
    await environmentWithStoredSenderDetails(environment, siteId),
  ).channel;
  if (channelConfiguration.state !== "configured") {
    throw new Error(channelConfiguration.reason);
  }
  // The unsubscribe token is signed with this secret at send time. Reading it
  // here keeps the MCP surface refusing to start without it, as it already
  // refuses without the Brevo webhook token and the account-scope
  // fingerprint. It is read after the channel so an installation with no
  // compliance footer gets the named reason rather than this one.
  readNewsletterDeliverySecret(environment);
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

  const bulkStateStore = createD1CampaignBulkStateStore(database);
  // A schedule request is a proposal and nothing else, so it needs only the
  // campaign it names and whether a send is already set for it. It never
  // reads the audience, the sender identity or the provider.
  const scheduleProposals = createCampaignScheduleRequests({
    siteId,
    campaigns: store,
    bulkState: bulkStateStore,
    proposals: createD1CampaignScheduleProposalStore(database),
    timeZoneDatabaseVersion: () =>
      readBlogPostTimeZoneDatabaseVersion(environment),
  });

  return Object.freeze({
    siteId,
    store,
    bulkStateStore,
    scheduleProposals,
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
    schemaVersion: "1.7.0",
  });
  const testDelivery = createCampaignTestDeliveryApplication({
    siteId: parts.siteId,
    campaignStore: parts.store,
    store: parts.testDeliveryStore,
    adapter: parts.adapter,
    channelConfiguration: parts.channelConfiguration,
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
    async listCampaigns({ principal }) {
      const installation = await load();
      const { application } = bindApplications(
        installation,
        mcpCampaignActorId(principal),
      );
      return application.queries.listCampaigns({
        actor: mcpUnusedCampaignActor,
      });
    },
    async campaignStatus({ principal, campaignId }) {
      const installation = await load();
      const { application } = bindApplications(
        installation,
        mcpCampaignActorId(principal),
      );
      // The campaign is read through the campaign application, so a campaign
      // this site does not hold is refused the same way every other campaign
      // tool refuses one.
      const campaign = await application.queries.getCampaign({
        actor: mcpUnusedCampaignActor,
        campaignId,
      });
      return {
        campaign,
        bulkState: campaignBulkStateReport(
          await installation.bulkStateStore.findCampaignBulkState({
            siteId: installation.siteId,
            campaignId,
          }),
        ),
        pendingScheduleRequest:
          await installation.scheduleProposals.queries.pending({ campaignId }),
      };
    },
    async requestSchedule({
      principal,
      campaignId,
      resolvedTime,
      idempotencyKey,
      authority,
    }) {
      const installation = await load();
      return installation.scheduleProposals.commands.proposeSchedule({
        actorId: mcpCampaignActorId(principal),
        campaignId,
        resolvedTime,
        idempotencyKey,
        authority,
      });
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

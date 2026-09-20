import type {
  CampaignBulkResolvedTime,
  CampaignBulkStateReport,
} from "./campaign-bulk-delivery";
import { campaignSenderDetailsNotConfiguredReason } from "./campaign-channel-state";
import {
  CampaignScheduleProposalError,
  mcpCampaignOperationScopes,
  resolveCampaignScheduleTime,
  type CampaignScheduleProposal,
  type McpCampaignOperation,
  type McpCampaignOperationAuthority,
} from "./campaign-schedule-proposals";
import {
  CampaignConflictError,
  CampaignIdempotencyError,
  CampaignNotFoundError,
  CampaignValidationError,
  type Campaign,
  type CampaignCallToAction,
  type CampaignEditableInput,
  type CampaignId,
  type CampaignRevision,
} from "./campaign-types";
import type { CampaignTestDeliveryOperation } from "./campaign-test-delivery";
import { AccessDeniedError } from "./human-access";
import {
  McpReadError,
  mcpCampaignDraftScope,
  mcpCampaignTestScope,
  mcpPublicationScheduleScope,
  type McpConnectionPrincipal,
  type McpExecutionContext,
  type McpReadAuditEvent,
} from "./mcp-read";

/**
 * The campaign, test-delivery and analytics applications are authored against a
 * human identity. The MCP boundary never carries a human role, so the runtime
 * adapts an `McpConnectionPrincipal` into those human-typed calls and owns the
 * one capability an agent must never hold: choosing test recipients. The MCP
 * layer passes no recipient identifier in and reads none back; the runtime
 * sends only to the Owner-configured verified recipients.
 */
export type McpCampaignRuntime = Readonly<{
  createStandalone(input: {
    principal: McpConnectionPrincipal;
    requestId: string;
    editable: CampaignEditableInput;
  }): Promise<McpCampaignRevisionOutcome>;
  edit(input: {
    principal: McpConnectionPrincipal;
    requestId: string;
    campaignId: CampaignId;
    expectedVersion: number;
    editable: CampaignEditableInput;
  }): Promise<McpCampaignRevisionOutcome>;
  getCampaign(input: {
    principal: McpConnectionPrincipal;
    campaignId: CampaignId;
  }): Promise<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>;
  requestTest(input: {
    principal: McpConnectionPrincipal;
    requestId: string;
    campaignId: CampaignId;
  }): Promise<
    Readonly<{ operation: CampaignTestDeliveryOperation; replayed: boolean }>
  >;
  testReadiness(input: {
    principal: McpConnectionPrincipal;
    campaignId: CampaignId;
  }): Promise<McpCampaignTestReadiness>;
  /**
   * Every campaign of this site, newest first, each with the revision that is
   * current now. It carries no audience, no sender identity and no count of
   * people.
   */
  listCampaigns(input: {
    principal: McpConnectionPrincipal;
  }): Promise<
    ReadonlyArray<Readonly<{ campaign: Campaign; revision: CampaignRevision }>>
  >;
  /**
   * Where one campaign has got to: the Owner's approval of a tested email, a
   * send that is set, a send that has run, and a schedule request waiting for
   * a person. Counts only; never who is in the audience.
   */
  campaignStatus(input: {
    principal: McpConnectionPrincipal;
    campaignId: CampaignId;
  }): Promise<
    Readonly<{
      campaign: Campaign;
      bulkState: CampaignBulkStateReport;
      pendingScheduleRequest: CampaignScheduleProposal | null;
    }>
  >;
  /**
   * Record one schedule request under the connection's own authority. It
   * creates no schedule and sends nothing.
   */
  requestSchedule(input: {
    principal: McpConnectionPrincipal;
    campaignId: CampaignId;
    resolvedTime: Omit<CampaignBulkResolvedTime, "timeZoneDatabaseVersion">;
    idempotencyKey: string;
    authority: McpCampaignOperationAuthority;
  }): Promise<CampaignScheduleProposal>;
}>;

export type McpCampaignRevisionOutcome = Readonly<{
  campaign: Campaign;
  revision: CampaignRevision;
  replayed: boolean;
}>;

export type McpCampaignTestReadiness = Readonly<{
  state:
    | "evaluation_only"
    | "provider_unhealthy"
    | "live_test_required"
    | "owner_confirmation_required"
    | "ready";
  testDeliveryReady: boolean;
  provider: string;
  configurationFingerprint: string;
  ownershipEvidenceId: string;
  acceptedAt?: string;
}>;

export type McpCampaignEditableInput = Readonly<{
  subject: string;
  previewText: string;
  callToAction: CampaignCallToAction;
  emailContent: CampaignEditableInput["emailContent"];
}>;

type McpCampaignApplicationBase = Readonly<{
  executeScoped<Result>(input: {
    principal: McpConnectionPrincipal;
    operation: string;
    auditInput: unknown;
    requiredScopes: ReadonlyArray<string>;
    context: McpExecutionContext;
    run(
      context: McpExecutionContext,
      audit: McpReadAuditEvent,
    ): Promise<Result>;
  }): Promise<unknown>;
}>;

/**
 * The one sentence an agent reads for the one reason every path in the
 * product reports while an installation has not set its sender details and
 * email footer (ADR-0030). It names what the site owner must do, not the
 * internal setting names.
 */
const campaignSenderDetailsNotConfiguredMessage =
  "The site owner must set the sender details in the dashboard before this can be used.";

/**
 * Maps a domain rejection onto the stable MCP error contract. Campaign
 * commands report every rejection through a small set of typed errors, so the
 * agent sees the same code for the same policy decision no matter which
 * command raised it. `requiredScope` is the scope the calling tool gates on,
 * so a denial reports the scope that operation needs rather than a fixed one.
 */
function campaignError(
  error: unknown,
  requiredScope:
    | typeof mcpCampaignDraftScope
    | typeof mcpCampaignTestScope
    | typeof mcpPublicationScheduleScope,
): McpReadError {
  if (error instanceof McpReadError) return error;
  if (error instanceof CampaignScheduleProposalError) {
    return campaignScheduleRequestError(error, requiredScope);
  }
  // The MCP campaign runtime refuses to build at all while the sender
  // details are absent (ADR-0030 §5), and `createCampaignApplication` itself
  // refuses the same way if a caller ever reaches it first. Both report this
  // exact word, so this check catches either path with the same sentence and
  // the same named reason, instead of the generic refusal below.
  if (
    error instanceof Error &&
    error.message === campaignSenderDetailsNotConfiguredReason
  ) {
    return new McpReadError(
      "VALIDATION_FAILED",
      campaignSenderDetailsNotConfiguredMessage,
      { reason: campaignSenderDetailsNotConfiguredReason },
    );
  }
  if (error instanceof CampaignConflictError) {
    return new McpReadError(
      "STALE_REVISION",
      "The campaign changed since the expected version.",
    );
  }
  if (error instanceof CampaignNotFoundError) {
    return new McpReadError(
      "OBJECT_NOT_FOUND",
      "The requested campaign was not found.",
    );
  }
  if (error instanceof CampaignIdempotencyError) {
    return error.code === "campaign_idempotency_key_reused"
      ? new McpReadError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key was already used for different input.",
        )
      : new McpReadError(
          "VALIDATION_FAILED",
          "The campaign command arguments are invalid.",
        );
  }
  if (error instanceof CampaignValidationError) {
    return new McpReadError(
      "VALIDATION_FAILED",
      "The campaign command is not valid in the current state.",
    );
  }
  if (error instanceof AccessDeniedError) {
    return new McpReadError(
      "INSUFFICIENT_SCOPE",
      "The connection does not grant the required campaign scope.",
      { requiredScopes: [requiredScope] },
    );
  }
  return new McpReadError(
    "TEMPORARILY_UNAVAILABLE",
    "The request could not be completed safely.",
  );
}

/**
 * Turn a refused schedule request into the tool error an agent acts on.
 *
 * Every refusal carries the command's own named reason, so an agent branches
 * on the same word twice in a row for the same refusal, and a site owner
 * reads the same sentence. See ADR-0039.
 */
function campaignScheduleRequestError(
  error: CampaignScheduleProposalError,
  requiredScope: string,
): McpReadError {
  if (
    error.code === "mcp_schedule_authority_required" ||
    error.code === "human_authority_required"
  ) {
    return new McpReadError(
      "INSUFFICIENT_SCOPE",
      "The connection no longer grants permission to ask for a send time.",
      { requiredScopes: [requiredScope], reason: error.code },
    );
  }
  if (error.code === "schedule_request_idempotency_key_reused") {
    return new McpReadError(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different send time.",
      { reason: error.code },
    );
  }
  if (error.code === "campaign_not_found") {
    return new McpReadError(
      "OBJECT_NOT_FOUND",
      "The requested campaign was not found.",
      { reason: error.code },
    );
  }
  if (error.code === "campaign_send_already_scheduled") {
    return new McpReadError(
      "VALIDATION_FAILED",
      "A send is already set for this campaign, so there is nothing to ask for.",
      { reason: error.code },
    );
  }
  if (error.code === "schedule_request_idempotency_key_invalid") {
    return new McpReadError(
      "VALIDATION_FAILED",
      "The idempotency key is not a shape this command accepts.",
      { reason: error.code },
    );
  }
  return new McpReadError(
    "VALIDATION_FAILED",
    "The send time asked for is not one this campaign can take.",
    { reason: error.code },
  );
}

function campaignScheduleRequestResult(proposal: CampaignScheduleProposal) {
  return {
    requestId: proposal.id,
    campaignId: proposal.campaignId,
    sendAt: proposal.executeAtUtc,
    reportingTimeZone: proposal.ianaTimeZone,
    state: "pending_human_approval" as const,
  };
}

function revisionResult(outcome: McpCampaignRevisionOutcome) {
  return {
    campaignId: outcome.campaign.id,
    version: outcome.campaign.version,
    lifecycleState: outcome.campaign.lifecycleState,
    revisionNumber: outcome.revision.revisionNumber,
    provenance: { kind: outcome.revision.provenance.kind },
    replayed: outcome.replayed,
  };
}

/**
 * A campaign document read exposes only the agent-editable content and stable
 * identifiers. It never carries the audience definition, sender identity,
 * compliance footer, or an eligible-recipient count, so a draft read cannot
 * become an indirect route to audience membership.
 */
function campaignDocument(campaign: Campaign, revision: CampaignRevision) {
  return {
    campaignId: campaign.id,
    version: campaign.version,
    lifecycleState: campaign.lifecycleState,
    revisionNumber: revision.revisionNumber,
    provenance: { kind: revision.provenance.kind },
    subject: revision.subject,
    previewText: revision.previewText,
    // A revision stored before campaign images existed has no such
    // field. The result schema requires one, so read it as absent.
    headerImage: revision.headerImage ?? null,
    shareImage: revision.shareImage ?? null,
    callToAction: revision.callToAction,
    emailContent: revision.emailContent,
    schemaVersion: revision.schemaVersion,
    rendererVersion: revision.rendererVersion,
    createdAt: revision.createdAt,
  };
}

export function createMcpCampaignApplication({
  base,
  runtime,
}: {
  base: McpCampaignApplicationBase;
  runtime: McpCampaignRuntime;
}) {
  return Object.freeze({
    createCampaign(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        idempotencyKey: string;
        subject: string;
        previewText: string;
        headerImage?: CampaignEditableInput["headerImage"];
        shareImage?: CampaignEditableInput["shareImage"];
        callToAction: CampaignCallToAction;
        emailContent: CampaignEditableInput["emailContent"];
      }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.campaign.create",
        auditInput: input,
        requiredScopes: [mcpCampaignDraftScope],
        context,
        async run(execution) {
          try {
            const outcome = await execution.run(() =>
              runtime.createStandalone({
                principal,
                requestId: input.idempotencyKey,
                editable: {
                  subject: input.subject,
                  previewText: input.previewText,
                  headerImage: input.headerImage ?? null,
                  shareImage: input.shareImage ?? null,
                  callToAction: input.callToAction,
                  emailContent: input.emailContent,
                },
              }),
            );
            return revisionResult(outcome);
          } catch (error) {
            throw campaignError(error, mcpCampaignDraftScope);
          }
        },
      });
    },
    editCampaign(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        campaignId: CampaignId;
        expectedVersion: number;
        idempotencyKey: string;
        subject: string;
        previewText: string;
        headerImage?: CampaignEditableInput["headerImage"];
        shareImage?: CampaignEditableInput["shareImage"];
        callToAction: CampaignCallToAction;
        emailContent: CampaignEditableInput["emailContent"];
      }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.campaign.edit",
        auditInput: input,
        requiredScopes: [mcpCampaignDraftScope],
        context,
        async run(execution) {
          try {
            const outcome = await execution.run(() =>
              runtime.edit({
                principal,
                requestId: input.idempotencyKey,
                campaignId: input.campaignId,
                expectedVersion: input.expectedVersion,
                editable: {
                  subject: input.subject,
                  previewText: input.previewText,
                  headerImage: input.headerImage ?? null,
                  shareImage: input.shareImage ?? null,
                  callToAction: input.callToAction,
                  emailContent: input.emailContent,
                },
              }),
            );
            return revisionResult(outcome);
          } catch (error) {
            throw campaignError(error, mcpCampaignDraftScope);
          }
        },
      });
    },
    getCampaign(
      principal: McpConnectionPrincipal,
      input: Readonly<{ campaignId: CampaignId }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.campaign.get",
        auditInput: input,
        requiredScopes: [mcpCampaignDraftScope],
        context,
        async run(execution) {
          try {
            const { campaign, revision } = await execution.run(() =>
              runtime.getCampaign({ principal, campaignId: input.campaignId }),
            );
            return campaignDocument(campaign, revision);
          } catch (error) {
            throw campaignError(error, mcpCampaignDraftScope);
          }
        },
      });
    },
    listCampaigns(
      principal: McpConnectionPrincipal,
      input: Readonly<Record<string, never>>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.campaign.list",
        auditInput: input,
        requiredScopes: [mcpCampaignDraftScope],
        context,
        async run(execution) {
          try {
            const campaigns = await execution.run(() =>
              runtime.listCampaigns({ principal }),
            );
            return {
              campaigns: campaigns.map(({ campaign, revision }) => ({
                campaignId: campaign.id,
                version: campaign.version,
                lifecycleState: campaign.lifecycleState,
                subject: revision.subject,
                createdAt: campaign.createdAt,
                updatedAt: campaign.updatedAt,
              })),
            };
          } catch (error) {
            throw campaignError(error, mcpCampaignDraftScope);
          }
        },
      });
    },
    /**
     * Where one campaign has got to, in states, times and counts.
     *
     * It reports the Owner's approval as a state and never its fingerprint or
     * its test execution id, and it reports how many people a send reached
     * without ever naming one.
     */
    campaignStatus(
      principal: McpConnectionPrincipal,
      input: Readonly<{ campaignId: CampaignId }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.campaign.status",
        auditInput: input,
        requiredScopes: [mcpCampaignDraftScope],
        context,
        async run(execution) {
          try {
            const status = await execution.run(() =>
              runtime.campaignStatus({
                principal,
                campaignId: input.campaignId,
              }),
            );
            const { authorization, schedule, sendOperation } =
              status.bulkState;
            return {
              campaignId: status.campaign.id,
              version: status.campaign.version,
              lifecycleState: status.campaign.lifecycleState,
              ownerApproval:
                authorization === null
                  ? null
                  : {
                      state: authorization.state,
                      approvedAt: authorization.authorizedAt,
                    },
              sendSchedule:
                schedule === null
                  ? null
                  : {
                      state: schedule.state,
                      sendAt: schedule.executeAtUtc,
                      reportingTimeZone: schedule.ianaTimeZone,
                    },
              send:
                sendOperation === null
                  ? null
                  : {
                      state: sendOperation.state,
                      attempt: sendOperation.attempt,
                      // A count of people, never a person.
                      recipientCount: sendOperation.recipientCount,
                      updatedAt: sendOperation.updatedAt,
                    },
              scheduleRequest:
                status.pendingScheduleRequest === null
                  ? null
                  : campaignScheduleRequestResult(
                      status.pendingScheduleRequest,
                    ),
            };
          } catch (error) {
            throw campaignError(error, mcpCampaignDraftScope);
          }
        },
      });
    },
    /**
     * Ask a person to send one newsletter at a named time.
     *
     * This records a request and nothing else. No schedule exists until an
     * Owner confirms a delivered test of that exact email, approves it, and
     * sets the send in the dashboard. An agent never sends. See ADR-0039.
     */
    requestSchedule(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        campaignId: CampaignId;
        sendAt: string;
        reportingTimeZone: string;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      const operation: McpCampaignOperation =
        "foundry.campaign.schedule_request";
      const requiredScopes = [mcpCampaignOperationScopes[operation]];
      return base.executeScoped({
        principal,
        operation,
        auditInput: input,
        requiredScopes,
        context,
        async run(execution) {
          try {
            const proposal = await execution.run(() =>
              runtime.requestSchedule({
                principal,
                campaignId: input.campaignId,
                resolvedTime: resolveCampaignScheduleTime(
                  input.sendAt,
                  input.reportingTimeZone,
                ),
                idempotencyKey: input.idempotencyKey,
                authority: {
                  kind: "mcp",
                  connectionId: principal.connectionId,
                  actorId: principal.actorId,
                  operation,
                  requiredScopes,
                } satisfies McpCampaignOperationAuthority,
              }),
            );
            return campaignScheduleRequestResult(proposal);
          } catch (error) {
            throw campaignError(error, mcpPublicationScheduleScope);
          }
        },
      });
    },
    requestTest(
      principal: McpConnectionPrincipal,
      input: Readonly<{ campaignId: CampaignId; idempotencyKey: string }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.campaign.request_test",
        auditInput: input,
        requiredScopes: [mcpCampaignTestScope],
        context,
        async run(execution) {
          try {
            const { operation, replayed } = await execution.run(() =>
              runtime.requestTest({
                principal,
                requestId: input.idempotencyKey,
                campaignId: input.campaignId,
              }),
            );
            return {
              executionId: operation.executionId,
              state: operation.state,
              replayed,
            };
          } catch (error) {
            throw campaignError(error, mcpCampaignTestScope);
          }
        },
      });
    },
    testReadiness(
      principal: McpConnectionPrincipal,
      input: Readonly<{ campaignId: CampaignId }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.campaign.test_readiness",
        auditInput: input,
        requiredScopes: [mcpCampaignTestScope],
        context,
        async run(execution) {
          try {
            const readiness = await execution.run(() =>
              runtime.testReadiness({
                principal,
                campaignId: input.campaignId,
              }),
            );
            return {
              state: readiness.state,
              testDeliveryReady: readiness.testDeliveryReady,
              provider: readiness.provider,
              configurationFingerprint: readiness.configurationFingerprint,
              ownershipEvidenceId: readiness.ownershipEvidenceId,
              ...(readiness.acceptedAt === undefined
                ? {}
                : { acceptedAt: readiness.acceptedAt }),
            };
          } catch (error) {
            throw campaignError(error, mcpCampaignTestScope);
          }
        },
      });
    },
  });
}

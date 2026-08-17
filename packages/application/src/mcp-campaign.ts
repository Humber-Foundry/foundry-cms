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
 * Maps a domain rejection onto the stable MCP error contract. Campaign
 * commands report every rejection through a small set of typed errors, so the
 * agent sees the same code for the same policy decision no matter which
 * command raised it. `requiredScope` is the scope the calling tool gates on,
 * so a denial reports the scope that operation needs rather than a fixed one.
 */
function campaignError(
  error: unknown,
  requiredScope: typeof mcpCampaignDraftScope | typeof mcpCampaignTestScope,
): McpReadError {
  if (error instanceof McpReadError) return error;
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

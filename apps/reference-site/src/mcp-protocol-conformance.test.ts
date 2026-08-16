import { describe, expect, it } from "vitest";
import {
  registerSchema,
  unregisterSchema,
  validate as validateSchema,
  type SchemaObject,
} from "@hyperjump/json-schema/draft-2020-12";

import {
  McpReadError,
  mcpAnalyticsReadScope,
  mcpCampaignDraftScope,
  mcpCampaignTestScope,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  mcpInitialScope,
  mcpPublicationPublishScope,
  mcpPublicationScheduleScope,
  type McpConnectionPrincipal,
} from "@humber-foundry/application";
import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { createRequestExecutionContext } from "./mcp-http-support";
import { createMcpProtocolRuntime } from "./mcp-protocol-runtime";
import {
  createMcpToolRegistry,
  type McpReadApplication,
} from "./mcp-tool-registry";

const observedAt = "2026-08-07T12:00:00.000Z";
const workspaceId = "workspace_conformance";
const campaignId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const approvalId = `approval_${"a".repeat(32)}`;
const scheduleId = "schedule_0123abcd-4567-89ab-cdef-0123456789ab";
const contentHash = "a".repeat(64);
const previewArtifact = "b".repeat(64);
const productionBase = `git:${"a".repeat(40)}@content:${"b".repeat(64)}`;

function envelope(result: unknown) {
  return {
    contractVersion: "foundry.mcp.v1",
    invocationId: "invocation-real-emission",
    result,
    meta: { replayed: false, observedAt },
  };
}

const draftResult = {
  workspaceId,
  revision: 1,
  contentHash,
  schemaVersion: referenceSiteDefinition.schemaVersion,
  validation: { valid: true, issues: [] },
};
const canonicalRevision = {
  ...draftResult,
  definition: referenceSiteDefinition,
  rendererVersion: "renderer-conformance",
  productionBase,
  createdAt: observedAt,
  createdBy: "mcp-agent-conformance",
};

const results: Record<string, unknown> = {
  "foundry.site.get": {
    siteId: referenceSiteDefinition.site.id,
    displayName: referenceSiteDefinition.site.name,
    canonicalUrl: "https://foundry.example",
    locale: "en-CA",
    timeZone: "America/Vancouver",
    schemaVersion: referenceSiteDefinition.schemaVersion,
    liveRelease: null,
  },
  "foundry.content.list": { items: [], nextCursor: null },
  "foundry.content.get": {
    kind: "page",
    contentId: referenceSiteDefinition.home.id,
    revision: 1,
    contentHash,
    liveGitSha: "a".repeat(40),
    lastModified: observedAt,
    document: referenceSiteDefinition.home,
  },
  "foundry.workspace.open": { ...draftResult, replayed: false },
  "foundry.workspace.get": {
    workspaceId,
    manifest: {
      siteId: referenceSiteDefinition.site.id,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      rendererVersion: "renderer-conformance",
      productionBase,
    },
    base: { ...canonicalRevision, revision: 0 },
    current: canonicalRevision,
    state: {
      status: "draft",
      baseRevision: 0,
      currentRevision: 1,
      contentHash,
    },
  },
  "foundry.content.patch": {
    ...draftResult,
    replayed: false,
    previewArtifact,
  },
  "foundry.design.patch": {
    ...draftResult,
    replayed: false,
    previewArtifact,
  },
  "foundry.preview.prepare": {
    ...draftResult,
    previewId: "preview-conformance",
    previewArtifact,
    approvalStatus: "pending_human_review",
    replayed: false,
    humanReviewUrl: "https://foundry.example/dash/review/preview-conformance",
  },
  "foundry.publication.request": {
    operationId: `publish_${"b".repeat(32)}`,
    state: "requested",
    replayed: false,
  },
  "foundry.publication.schedule": {
    operationId: scheduleId,
    state: "scheduled",
    replayed: false,
  },
  "foundry.publication.status": {
    operationId: `publish_${"b".repeat(32)}`,
    state: "committed",
    replayed: false,
  },
  "foundry.publication.cancel": {
    operationId: scheduleId,
    state: "cancelled",
    replayed: false,
  },
  "foundry.campaign.create": {
    campaignId,
    version: 1,
    lifecycleState: "draft",
    revisionNumber: 1,
    provenance: { kind: "standalone" },
    replayed: false,
  },
  "foundry.campaign.edit": {
    campaignId,
    version: 2,
    lifecycleState: "draft",
    revisionNumber: 2,
    provenance: { kind: "standalone" },
    replayed: false,
  },
  "foundry.campaign.get": {
    campaignId,
    version: 1,
    lifecycleState: "draft",
    revisionNumber: 1,
    provenance: { kind: "standalone" },
    subject: "Public campaign copy",
    previewText: "A safe preview",
    // Filled rather than null, so the emission proves the share-image shape
    // validates and not only the absent case.
    shareImage: { url: "https://example.test/card.png", alt: "A card" },
    callToAction: { label: "Read", href: "/blog/update" },
    emailContent: { version: "1.0.0", type: "document", children: [] },
    schemaVersion: referenceSiteDefinition.schemaVersion,
    rendererVersion: "renderer-conformance",
    createdAt: observedAt,
  },
  "foundry.campaign.request_test": {
    executionId: "33333333-3333-4333-8333-333333333333",
    state: "accepted",
    replayed: false,
  },
  "foundry.campaign.test_readiness": {
    state: "ready",
    testDeliveryReady: true,
    provider: "configured-provider",
    configurationFingerprint: "c".repeat(64),
    ownershipEvidenceId: "ownership-conformance",
    acceptedAt: observedAt,
  },
  "foundry.analytics.read": {
    view: "overview",
    data: {
      schemaVersion: "foundry.analytics.v1",
      siteId: referenceSiteDefinition.site.id,
    },
  },
};

const campaignInput = {
  idempotencyKey,
  subject: "Public campaign copy",
  previewText: "A safe preview",
  callToAction: { label: "Read", href: "/blog/update" },
  emailContent: { version: "1.0.0", type: "document", children: [] },
};
const inputs: Record<string, unknown> = {
  "foundry.site.get": {},
  "foundry.content.list": { kind: null, limit: 10, cursor: null },
  "foundry.content.get": {
    kind: "page",
    contentId: referenceSiteDefinition.home.id,
  },
  "foundry.workspace.open": { expectedRevision: 0, idempotencyKey },
  "foundry.workspace.get": { workspaceId },
  "foundry.content.patch": {
    workspaceId,
    expectedRevision: 0,
    idempotencyKey,
    operations: [
      {
        op: "set",
        field: `${referenceSiteDefinition.site.id}.name`,
        value: "Updated public site name",
      },
    ],
  },
  "foundry.design.patch": {
    workspaceId,
    expectedRevision: 0,
    idempotencyKey,
    operations: [
      { op: "set_token", token: "typography.heading", value: "editorial" },
    ],
  },
  "foundry.preview.prepare": {
    workspaceId,
    expectedRevision: 1,
    idempotencyKey,
  },
  "foundry.publication.request": {
    workspaceId,
    revision: 1,
    approvalId,
    idempotencyKey,
  },
  "foundry.publication.schedule": {
    workspaceId,
    revision: 1,
    approvalId,
    publishAt: "2026-08-08T12:00:00Z",
    reportingTimeZone: "America/Vancouver",
    idempotencyKey,
  },
  "foundry.publication.status": {
    workspaceId,
    revision: 1,
    operationId: `publish_${"b".repeat(32)}`,
  },
  "foundry.publication.cancel": {
    workspaceId,
    revision: 1,
    scheduleId,
    idempotencyKey,
  },
  "foundry.campaign.create": campaignInput,
  "foundry.campaign.edit": {
    ...campaignInput,
    campaignId,
    expectedVersion: 1,
  },
  "foundry.campaign.get": { campaignId },
  "foundry.campaign.request_test": { campaignId, idempotencyKey },
  "foundry.campaign.test_readiness": { campaignId },
  "foundry.analytics.read": {
    view: "overview",
    range: { fromLocalDate: "2026-07-10", toLocalDate: "2026-08-06" },
    limit: null,
  },
};

describe("MCP protocol-wrapper emission conformance", () => {
  it("independently validates protocol-wrapper success and business-error emissions for all 18 descriptors", async () => {
    let failingTool: string | null = null;
    const emit = (name: string) => async () => {
      if (failingTool === name) {
        throw new McpReadError(
          "OBJECT_NOT_FOUND",
          "PRIVATE-IDENTITY-PROVIDER-CANARY",
        );
      }
      return envelope(results[name]);
    };
    const application = {
      getSite: emit("foundry.site.get"),
      listContent: emit("foundry.content.list"),
      getContent: emit("foundry.content.get"),
      openWorkspace: emit("foundry.workspace.open"),
      getWorkspace: emit("foundry.workspace.get"),
      patchContent: emit("foundry.content.patch"),
      patchDesign: emit("foundry.design.patch"),
      preparePreview: emit("foundry.preview.prepare"),
      requestPublication: emit("foundry.publication.request"),
      schedulePublication: emit("foundry.publication.schedule"),
      publicationStatus: emit("foundry.publication.status"),
      cancelPublicationSchedule: emit("foundry.publication.cancel"),
      createCampaign: emit("foundry.campaign.create"),
      editCampaign: emit("foundry.campaign.edit"),
      getCampaign: emit("foundry.campaign.get"),
      requestTest: emit("foundry.campaign.request_test"),
      testReadiness: emit("foundry.campaign.test_readiness"),
      readAnalytics: emit("foundry.analytics.read"),
    } as unknown as McpReadApplication;
    const principal: McpConnectionPrincipal = {
      connectionId: "connection-protocol-conformance",
      actorId: "actor-protocol-conformance",
      clientId: "https://client.example/protocol-conformance.json",
      siteId: referenceSiteDefinition.site.id,
      scopes: [
        mcpInitialScope,
        mcpContentDraftScope,
        mcpDesignDraftScope,
        mcpPublicationPublishScope,
        mcpPublicationScheduleScope,
        mcpCampaignDraftScope,
        mcpCampaignTestScope,
        mcpAnalyticsReadScope,
      ],
    };
    const registry = createMcpToolRegistry(application);
    const protocol = createMcpProtocolRuntime({
      canonicalOrigin: "https://foundry.example",
      siteId: principal.siteId,
      siteName: "Foundry",
      store: {
        async consumeRateLimit() {
          return true;
        },
      },
      readApplication: application,
      cursors: {
        async encode() {
          return "unused";
        },
        async decode() {
          throw new Error("unused");
        },
      },
      now: () => new Date(observedAt),
    });
    async function call(name: string) {
      const execution = createRequestExecutionContext(5_000, () => {});
      try {
        const response = await protocol.handle(
          new Request("https://foundry.example/api/foundry-mcp", {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "mcp-protocol-version": "2025-11-25",
              "mcp-session-id": "session-protocol-conformance",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: `call:${name}`,
              method: "tools/call",
              params: { name, arguments: inputs[name] },
            }),
          }),
          async () => ({
            principal,
            sessionState: "valid",
            async issueSessionId() {
              return "unused";
            },
          }),
          execution.context,
        );
        const body = (await response.json()) as {
          result: { isError: boolean; structuredContent: unknown };
        };
        return body.result;
      } finally {
        execution.dispose();
      }
    }

    for (const descriptor of registry.list(principal)) {
      const uri = `https://conformance.foundry.invalid/emission/${descriptor.name}`;
      registerSchema(
        JSON.parse(JSON.stringify(descriptor.outputSchema)) as SchemaObject,
        uri,
        "https://json-schema.org/draft/2020-12/schema",
      );
      try {
        failingTool = null;
        const success = await call(descriptor.name);
        expect(success.isError, descriptor.name).toBe(false);
        expect(
          (await validateSchema(uri, success.structuredContent as never)).valid,
          `${descriptor.name} success`,
        ).toBe(true);

        failingTool = descriptor.name;
        const failure = await call(descriptor.name);
        expect(failure.isError, descriptor.name).toBe(true);
        expect(
          (await validateSchema(uri, failure.structuredContent as never)).valid,
          `${descriptor.name} error`,
        ).toBe(true);
        expect(JSON.stringify(failure)).not.toContain(
          "PRIVATE-IDENTITY-PROVIDER-CANARY",
        );
      } finally {
        unregisterSchema(uri);
      }
    }
  });
});

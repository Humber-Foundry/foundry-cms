import { describe, expect, it } from "vitest";

import {
  createRichTextDocumentFromPlainText,
  listEditableSiteFields,
  referenceSiteDefinition,
} from "@foundry/site-definition";

import {
  ContentWorkspaceAccessError,
  createCanonicalPreviewArtifactHash,
  createContentActorId,
  createContentRevisionApplication,
  createContentWorkspaceId,
  createInMemoryContentRevisionStore,
  createInMemoryPublishedSiteRepository,
  createMcpDraftApplication,
  createMcpReadApplication,
  createPublishedSiteBundle,
  createSiteApplication,
  McpReadError,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  mcpInitialScope,
  type ContentRevisionApplication,
  type ContentWorkspaceId,
  type McpConnectionPrincipal,
  type McpReadAuditEvent,
} from "./index";

const now = "2026-07-29T20:00:00.000Z";
const productionBase = "a".repeat(40);
const rendererVersion = "renderer-55";

function principal(
  scopes: ReadonlyArray<string>,
  siteId = referenceSiteDefinition.site.id,
): McpConnectionPrincipal {
  return {
    connectionId: "connection-55",
    actorId: "agent-55",
    clientId: "https://client.example/mcp.json",
    siteId,
    scopes,
  };
}

function fixture(scopes: ReadonlyArray<string>) {
  const activePrincipal = principal(scopes);
  const workspaces = new Map<ContentWorkspaceId, ContentRevisionApplication>();
  const workspaceByKey = new Map<string, ContentWorkspaceId>();
  const audit: string[] = [];
  const auditEvents: McpReadAuditEvent[] = [];
  const previewScopesEvaluated: string[][] = [];
  const previews = new Map<
    string,
    Readonly<{ requestHash: string; previewId: string }>
  >();
  const failures = new Map<
    string,
    Readonly<{
      inputHash: string;
      observedAt: string;
      error: Readonly<{
        code: McpReadError["code"];
        message: string;
        latestRevision: number | null;
        conflictResource: string | null;
      }>;
    }>
  >();
  let deploymentCurrent = true;
  const read = createMcpReadApplication({
    site: createSiteApplication({
      siteId: referenceSiteDefinition.site.id,
      publishedSites: createInMemoryPublishedSiteRepository([
        createPublishedSiteBundle(referenceSiteDefinition),
      ]),
    }),
    siteMetadata: {
      canonicalUrl: "https://foundry.example",
      locale: "en-CA",
      timeZone: "America/Vancouver",
      async getLiveRelease() {
        return null;
      },
    },
    connections: {
      async findCurrentConnection(input) {
        return input.connectionId === activePrincipal.connectionId &&
          input.siteId === activePrincipal.siteId
          ? { ...activePrincipal, status: "active" as const }
          : null;
      },
      async recordInvocation(event) {
        auditEvents.push(event);
        audit.push(`${event.operation}:${event.outcome}`);
      },
    },
    cursors: {
      async encode() {
        return "cursor";
      },
      async decode() {
        throw new Error("unused");
      },
    },
    createInvocationId: () => `invocation-${audit.length + 1}`,
    now: () => now,
  });
  const drafts = createMcpDraftApplication({
    base: read,
    runtime: {
      async replayMutation({ principal: replayPrincipal, audit: event }) {
        const key =
          `${replayPrincipal.siteId}:${replayPrincipal.actorId}:` +
          `${event.operation}:${event.idempotencyKey}`;
        const failure = failures.get(key);
        if (failure === undefined) return null;
        if (failure.inputHash !== event.inputHash) {
          throw new McpReadError(
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was reused.",
          );
        }
        audit.push(`${event.operation}:denied`);
        throw new McpReadError(
          failure.error.code,
          failure.error.message,
          {
            observedAt: failure.observedAt,
            latestRevision:
              failure.error.latestRevision ?? undefined,
            conflictResource:
              failure.error.conflictResource ?? undefined,
            replayed: true,
            auditRecorded: true,
          },
        );
      },
      async recordMutationFailure({
        principal: failurePrincipal,
        audit: event,
        error,
      }) {
        const key =
          `${failurePrincipal.siteId}:${failurePrincipal.actorId}:` +
          `${event.operation}:${event.idempotencyKey}`;
        failures.set(key, {
          inputHash: event.inputHash,
          observedAt: event.occurredAt,
          error,
        });
        audit.push(`${event.operation}:denied`);
        return {
          error,
          observedAt: event.occurredAt,
          replayed: false,
        };
      },
      async open({ actorId, idempotencyKey }) {
        let workspaceId = workspaceByKey.get(idempotencyKey);
        if (workspaceId === undefined) {
          workspaceId = createContentWorkspaceId(
            `workspace_mcp_${workspaceByKey.size + 1}`,
          );
          workspaceByKey.set(idempotencyKey, workspaceId);
        }
        let application = workspaces.get(workspaceId);
        if (application === undefined) {
          application = createContentRevisionApplication({
            siteDefinition: referenceSiteDefinition,
            store: createInMemoryContentRevisionStore(),
            workspaceId,
            actorId,
            rendererVersion,
            productionBase,
            now: () => now,
          });
          workspaces.set(workspaceId, application);
        }
        return application;
      },
      async load({ actorId, workspaceId }) {
        const application = workspaces.get(workspaceId);
        if (application === undefined) {
          throw new ContentWorkspaceAccessError();
        }
        await application.queries.getCurrent();
        expect(actorId).toEqual(createContentActorId("mcp-agent-55"));
        return {
          ...application,
          queries: {
            ...application.queries,
            async isRevisionCurrent(revision) {
              return deploymentCurrent &&
                application.queries.isRevisionCurrent(revision);
            },
          },
        };
      },
      humanReviewUrl(previewId) {
        return `https://foundry.example/dash/review/${previewId}`;
      },
      async replayPreview(input) {
        const key = `${input.principal.connectionId}:${input.idempotencyKey}`;
        const existing = previews.get(key);
        if (existing === undefined) return null;
        if (existing.requestHash !== input.requestHash) {
          throw new McpReadError(
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was reused.",
          );
        }
        return { previewId: existing.previewId, replayed: true };
      },
      async preparePreview(input) {
        previewScopesEvaluated.push([...input.audit.scopesEvaluated]);
        const key = `${input.principal.connectionId}:${input.idempotencyKey}`;
        const existing = previews.get(key);
        if (existing !== undefined) {
          if (existing.requestHash !== input.requestHash) {
            throw new McpReadError(
              "IDEMPOTENCY_KEY_REUSED",
              "The idempotency key was reused.",
            );
          }
          return { previewId: existing.previewId, replayed: true };
        }
        const previewId = `preview-${previews.size + 1}`;
        previews.set(key, { requestHash: input.requestHash, previewId });
        return { previewId, replayed: false };
      },
    },
  });
  return {
    application: Object.assign(read, drafts),
    activePrincipal,
    audit,
    auditEvents,
    driftDeployment() {
      deploymentCurrent = false;
    },
    previewScopesEvaluated,
    workspaces,
  };
}

const context = {
  throwIfExpired() {},
  run: <Result>(operation: () => Promise<Result>) => operation(),
  finishDurably: <Result>(operation: () => Promise<Result>) => operation(),
};

function resultOf<Result>(value: unknown): Result {
  return (value as { result: Result }).result;
}

describe("MCP canonical draft application", () => {
  it("requires an explicit one-site draft scope and rejects cross-site work", async () => {
    const readOnly = fixture([mcpInitialScope]);
    await expect(
      readOnly.application.openWorkspace(
        readOnly.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-read-only-0001",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope],
    });

    const scoped = fixture([mcpInitialScope, mcpContentDraftScope]);
    const foreign = principal(
      [mcpInitialScope, mcpContentDraftScope],
      "site_foreign" as typeof referenceSiteDefinition.site.id,
    );
    await expect(
      scoped.application.openWorkspace(
        foreign,
        {
          expectedRevision: 0,
          idempotencyKey: "open-foreign-site-1",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });

    const contentWorkspace = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await scoped.application.openWorkspace(
        scoped.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-content-scope-1",
        },
        context,
      ),
    );
    await expect(
      scoped.application.patchDesign(
        scoped.activePrincipal,
        {
          workspaceId: contentWorkspace.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "deny-design-scope-1",
          operations: [
            {
              op: "set_token",
              token: "colour.accent",
              value: "clay",
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpDesignDraftScope],
    });
  });

  it("returns canonical workspace state and immutable revision data for recovery", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpContentDraftScope,
    ]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-resource-recovery-1",
        },
        context,
      ),
    );
    await fixtureValue.application.patchContent(
      fixtureValue.activePrincipal,
      {
        workspaceId: opened.workspaceId,
        expectedRevision: 0,
        idempotencyKey: "patch-resource-recovery-1",
        operations: [{
          op: "set",
          field: `${referenceSiteDefinition.site.id}.name`,
          value: "Concurrent canonical name",
        }],
      },
      context,
    );

    const workspace = resultOf<{
      manifest: {
        siteId: string;
        schemaVersion: string;
        rendererVersion: string;
        productionBase: string;
      };
      base: {
        revision: number;
        definition: typeof referenceSiteDefinition;
      };
      current: {
        revision: number;
        definition: typeof referenceSiteDefinition;
      };
      state: {
        status: string;
        baseRevision: number;
        currentRevision: number;
        contentHash: string;
      };
    }>(
      await fixtureValue.application.getWorkspace(
        fixtureValue.activePrincipal,
        opened.workspaceId,
        context,
      ),
    );
    expect(workspace).toMatchObject({
      manifest: {
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: referenceSiteDefinition.schemaVersion,
        rendererVersion,
        productionBase,
      },
      base: {
        revision: 0,
        definition: referenceSiteDefinition,
      },
      current: {
        revision: 1,
        definition: {
          site: { name: "Concurrent canonical name" },
        },
      },
      state: {
        status: "draft",
        baseRevision: 0,
        currentRevision: 1,
      },
    });
    const currentRevision = resultOf<{ contentHash: string }>(
      await fixtureValue.application.getWorkspaceRevision(
        fixtureValue.activePrincipal,
        opened.workspaceId,
        1,
        context,
      ),
    );
    expect(workspace.state.contentHash).toBe(currentRevision.contentHash);

    await expect(
      fixtureValue.application.getWorkspaceRevision(
        fixtureValue.activePrincipal,
        opened.workspaceId,
        0,
        context,
      ),
    ).resolves.toMatchObject({
      result: {
        workspaceId: opened.workspaceId,
        revision: 0,
        definition: referenceSiteDefinition,
        rendererVersion,
        productionBase,
        createdAt: now,
        createdBy: expect.any(String),
      },
    });
  });

  it("uses revision CAS and actor-bound idempotency for every draft mutation", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpContentDraftScope,
    ]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-content-draft-1",
        },
        context,
      ),
    );
    const input = {
      workspaceId: opened.workspaceId,
      expectedRevision: 0,
      idempotencyKey: "patch-content-name-1",
      operations: [
        {
          op: "set" as const,
          field: `${referenceSiteDefinition.site.id}.name`,
          value: "One canonical edit",
        },
      ],
    };
    const first = await fixtureValue.application.patchContent(
      fixtureValue.activePrincipal,
      input,
      context,
    );
    const replay = await fixtureValue.application.patchContent(
      fixtureValue.activePrincipal,
      input,
      context,
    );
    expect(first).toMatchObject({
      result: { revision: 1, replayed: false },
      meta: { replayed: false },
    });
    expect(replay).toMatchObject({
      result: { revision: 1, replayed: true },
      meta: { replayed: true },
    });
    const advanced = resultOf<{ revision: number }>(
      await fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        {
          ...input,
          expectedRevision: 1,
          idempotencyKey: "patch-content-name-2",
          operations: [
            { ...input.operations[0]!, value: "A later canonical edit" },
          ],
        },
        context,
      ),
    );
    expect(advanced.revision).toBe(2);
    await expect(
      fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        input,
        context,
      ),
    ).resolves.toMatchObject({
      result: { revision: 1, replayed: true },
      meta: { replayed: true },
    });
    await expect(
      fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-content-draft-1",
        },
        context,
      ),
    ).resolves.toMatchObject({
      result: { revision: 0, replayed: true },
      meta: { replayed: true },
    });
    const staleInput = {
      ...input,
      idempotencyKey: "stale-content-name-1",
    };
    await expect(
      fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        staleInput,
        context,
      ),
    ).rejects.toMatchObject({
      code: "STALE_REVISION",
      latestRevision: 2,
      conflictResource:
        `foundry://workspaces/${opened.workspaceId}/revisions/2`,
      replayed: false,
    });
    await expect(
      fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        staleInput,
        context,
      ),
    ).rejects.toMatchObject({
      code: "STALE_REVISION",
      latestRevision: 2,
      conflictResource:
        `foundry://workspaces/${opened.workspaceId}/revisions/2`,
      replayed: true,
    });
    await expect(
      fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        {
          ...input,
          operations: [{ ...input.operations[0]!, value: "Changed intent" }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("accepts canonical rich-text data and rejects malformed nodes as validation errors", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpContentDraftScope,
    ]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-rich-text-draft",
        },
        context,
      ),
    );
    const field = listEditableSiteFields(referenceSiteDefinition).find(
      ({ format, group }) =>
        format === "richText" && group !== "Design",
    )!.path;
    await expect(
      fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "patch-rich-text-01",
          operations: [{
            op: "set",
            field,
            format: "richText",
            value: createRichTextDocumentFromPlainText("Canonical copy."),
          }],
        },
        context,
      ),
    ).resolves.toMatchObject({
      result: { revision: 1, validation: { valid: true, issues: [] } },
    });
    await expect(
      fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 1,
          idempotencyKey: "patch-rich-text-02",
          operations: [{
            op: "set",
            field,
            format: "richText",
            value: {
              version: "1.0.0",
              type: "document",
              children: [{ type: "script" }],
            } as never,
          }],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("produces the same canonical revision, validation, hash and preview artifact as a human edit", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpContentDraftScope,
    ]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-parity-draft-1",
        },
        context,
      ),
    );
    const field = `${referenceSiteDefinition.site.id}.description`;
    const mcp = resultOf<{
      revision: number;
      contentHash: string;
      validation: unknown;
      previewArtifact: string;
    }>(
      await fixtureValue.application.patchContent(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "patch-parity-text-1",
          operations: [
            { op: "set", field, value: "Shared canonical meaning." },
          ],
        },
        context,
      ),
    );

    const humanActor = createContentActorId("membership-human-55");
    const human = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      workspaceId: createContentWorkspaceId("workspace_human_55"),
      actorId: humanActor,
      rendererVersion,
      productionBase,
      now: () => now,
    });
    await human.commands.create({
      actorId: humanActor,
      workspaceId: human.workspaceId,
      idempotencyKey: "open-human-parity-1",
    });
    const humanRevision = await human.commands.save({
      actorId: humanActor,
      workspaceId: human.workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      edits: [{ path: field, value: "Shared canonical meaning." }],
      idempotencyKey: "patch-human-parity-1",
    });

    expect({
      revision: mcp.revision,
      contentHash: mcp.contentHash,
      validation: mcp.validation,
      previewArtifact: mcp.previewArtifact,
    }).toEqual({
      revision: humanRevision.revision,
      contentHash: humanRevision.inputs.contentHash,
      validation: { valid: true, issues: [] },
      previewArtifact:
        await createCanonicalPreviewArtifactHash(humanRevision),
    });
  });

  it("limits design writes to registered tokens and variants and never creates approval", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpDesignDraftScope,
    ]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-design-draft-1",
        },
        context,
      ),
    );
    const patched = resultOf<{ revision: number }>(
      await fixtureValue.application.patchDesign(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "patch-design-token-1",
          operations: [
            {
              op: "set_token",
              token: "colour.accent",
              value: "clay",
            },
          ],
        },
        context,
      ),
    );
    const preview = resultOf<{
      approvalStatus: string;
      humanReviewUrl: string;
    }>(
      await fixtureValue.application.preparePreview(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: patched.revision,
          idempotencyKey: "prepare-design-view-1",
        },
        context,
      ),
    );
    expect(preview).toMatchObject({
      approvalStatus: "pending_human_review",
      humanReviewUrl:
        "https://foundry.example/dash/review/preview-1",
    });
    await fixtureValue.application.patchDesign(
      fixtureValue.activePrincipal,
      {
        workspaceId: opened.workspaceId,
        expectedRevision: patched.revision,
        idempotencyKey: "patch-design-token-2",
        operations: [
          {
            op: "set_token",
            token: "colour.accent",
            value: "moss",
          },
        ],
      },
      context,
    );
    fixtureValue.driftDeployment();
    const replay = resultOf<{ previewId: string; replayed: boolean }>(
      await fixtureValue.application.preparePreview(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: patched.revision,
          idempotencyKey: "prepare-design-view-1",
        },
        context,
      ),
    );
    expect(replay).toMatchObject({
      previewId: "preview-1",
      replayed: true,
    });
    expect(preview).not.toHaveProperty("approvalId");
    await expect(
      fixtureValue.application.patchDesign(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: patched.revision,
          idempotencyKey: "patch-unknown-design-1",
          operations: [
            {
              op: "set_variant",
              componentId: "unknown-component",
              value: "javascript:alert(1)",
            },
          ],
        },
        context,
      ),
    ).rejects.toBeInstanceOf(McpReadError);
  });

  it("requires every draft scope represented by a mixed preview", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpContentDraftScope,
      mcpDesignDraftScope,
    ]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-mixed-preview-1",
        },
        context,
      ),
    );
    await fixtureValue.application.patchContent(
      fixtureValue.activePrincipal,
      {
        workspaceId: opened.workspaceId,
        expectedRevision: 0,
        idempotencyKey: "mixed-preview-content-1",
        operations: [{
          op: "set",
          field: `${referenceSiteDefinition.site.id}.description`,
          value: "Mixed preview content.",
        }],
      },
      context,
    );
    await fixtureValue.application.patchDesign(
      fixtureValue.activePrincipal,
      {
        workspaceId: opened.workspaceId,
        expectedRevision: 1,
        idempotencyKey: "mixed-preview-design-1",
        operations: [{
          op: "set_token",
          token: "colour.accent",
          value: "clay",
        }],
      },
      context,
    );
    const narrowPrincipal = principal([
      mcpInitialScope,
      mcpDesignDraftScope,
    ]);
    await expect(
      fixtureValue.application.getWorkspace(
        narrowPrincipal,
        opened.workspaceId,
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [
        mcpContentDraftScope,
        mcpDesignDraftScope,
      ],
    });
    await expect(
      fixtureValue.application.getWorkspaceRevision(
        narrowPrincipal,
        opened.workspaceId,
        2,
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [
        mcpContentDraftScope,
        mcpDesignDraftScope,
      ],
    });
    await expect(
      fixtureValue.application.getWorkspace(
        fixtureValue.activePrincipal,
        opened.workspaceId,
        context,
      ),
    ).resolves.toMatchObject({
      result: { state: { currentRevision: 2 } },
    });
    await expect(
      fixtureValue.application.getWorkspaceRevision(
        fixtureValue.activePrincipal,
        opened.workspaceId,
        2,
        context,
      ),
    ).resolves.toMatchObject({
      result: { revision: 2 },
    });
    for (const operation of [
      "foundry.workspace.get",
      "foundry.workspace.revision.get",
    ]) {
      expect(fixtureValue.auditEvents).toContainEqual(
        expect.objectContaining({
          operation,
          outcome: "allowed",
          scopesEvaluated: [
            mcpContentDraftScope,
            mcpDesignDraftScope,
          ],
        }),
      );
    }

    await expect(
      fixtureValue.application.preparePreview(
        narrowPrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 2,
          idempotencyKey: "mixed-preview-prepare-1",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [
        mcpContentDraftScope,
        mcpDesignDraftScope,
      ],
    });
    expect(fixtureValue.auditEvents).toContainEqual(
      expect.objectContaining({
        operation: "foundry.preview.prepare",
        outcome: "denied",
        scopesEvaluated: [
          mcpContentDraftScope,
          mcpDesignDraftScope,
        ],
      }),
    );
    await expect(
      fixtureValue.application.preparePreview(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 2,
          idempotencyKey: "mixed-preview-prepare-2",
        },
        context,
      ),
    ).resolves.toMatchObject({
      result: {
        revision: 2,
        approvalStatus: "pending_human_review",
      },
    });
    expect(fixtureValue.previewScopesEvaluated).toContainEqual([
      mcpContentDraftScope,
      mcpDesignDraftScope,
    ]);
  });

  it("rejects and replays preview preparation after deployment drift", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpContentDraftScope,
    ]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "open-preview-drift-1",
        },
        context,
      ),
    );
    await fixtureValue.application.patchContent(
      fixtureValue.activePrincipal,
      {
        workspaceId: opened.workspaceId,
        expectedRevision: 0,
        idempotencyKey: "patch-preview-drift-1",
        operations: [{
          op: "set",
          field: `${referenceSiteDefinition.site.id}.description`,
          value: "Preview created before deployment drift.",
        }],
      },
      context,
    );
    fixtureValue.driftDeployment();
    const input = {
      workspaceId: opened.workspaceId,
      expectedRevision: 1,
      idempotencyKey: "prepare-preview-drift-1",
    };

    await expect(
      fixtureValue.application.preparePreview(
        fixtureValue.activePrincipal,
        input,
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      replayed: false,
    });
    await expect(
      fixtureValue.application.preparePreview(
        fixtureValue.activePrincipal,
        input,
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      replayed: true,
    });
  });
});

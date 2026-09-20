import { describe, expect, it } from "vitest";

import {
  createRichTextDocumentFromPlainText,
  createSiteId,
  findPageById,
  homePage,
  isMintedPageId,
  listEditableSiteFields,
  mintedPageId,
  referenceSiteDefinition,
} from "@humber-foundry/site-definition";

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
  mcpRestructureScopes,
  sha256CanonicalJson,
  type McpMutationFailure,
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
  let activePrincipal = principal(scopes);
  const workspaces = new Map<ContentWorkspaceId, ContentRevisionApplication>();
  const workspaceByKey = new Map<string, ContentWorkspaceId>();
  const audit: string[] = [];
  const auditEvents: McpReadAuditEvent[] = [];
  // Failures discovered after a command is admitted go to the joined mutation
  // recorder rather than the read-audit list, so their evidence is captured
  // here to keep it assertable.
  const failureEvents: McpReadAuditEvent[] = [];
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
      error: McpMutationFailure;
    }>
  >();
  let deploymentCurrent = true;
  // The photos this site's media library already holds. An agent may name
  // one of these in a blog post and no other picture at all.
  const mediaLibrary = new Set<string>(["asset_open_day"]);
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
            reason: failure.error.reason ?? undefined,
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
        failureEvents.push(event);
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
      async mediaLibraryHoldsAsset({ assetId }) {
        return mediaLibrary.has(assetId);
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
    failureEvents,
    driftDeployment() {
      deploymentCurrent = false;
    },
    previewScopesEvaluated,
    setActivePrincipal(next: McpConnectionPrincipal) {
      activePrincipal = next;
    },
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

  it("generates isolated workspace and preview sequences with CAS and actor-bound replay", async () => {
    const generatedCases = ["name", "description"].flatMap((field) =>
      [false, true].map((previewReplayAfterActorDenials, offset) => ({
        field,
        previewReplayAfterActorDenials,
        suffix: `${field}-${offset}`,
      })),
    );
    expect(generatedCases).toHaveLength(4);
    for (const generated of generatedCases) {
      const value = fixture([mcpInitialScope, mcpContentDraftScope]);
      const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
        await value.application.openWorkspace(
          value.activePrincipal,
          {
            expectedRevision: 0,
            idempotencyKey: `generated-open-${generated.suffix}`,
          },
          context,
        ),
      );
      const input = {
        workspaceId: opened.workspaceId,
        expectedRevision: 0,
        idempotencyKey: `generated-patch-${generated.suffix}`,
        operations: [
          {
            op: "set" as const,
            field: `${referenceSiteDefinition.site.id}.${generated.field}`,
            value: `Generated canonical value ${generated.suffix}`,
          },
        ],
      };
      await value.application.patchContent(
        value.activePrincipal,
        input,
        context,
      );
      await expect(
        value.application.patchContent(value.activePrincipal, input, context),
      ).resolves.toMatchObject({
        result: { revision: 1, replayed: true },
        meta: { replayed: true },
      });
      await expect(
        value.application.patchContent(
          value.activePrincipal,
          {
            ...input,
            operations: [{ ...input.operations[0], value: "substituted" }],
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      await expect(
        value.application.patchContent(
          value.activePrincipal,
          {
            ...input,
            idempotencyKey: `generated-stale-${generated.suffix}`,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "STALE_REVISION", latestRevision: 1 });

      const preview = {
        workspaceId: opened.workspaceId,
        expectedRevision: 1,
        idempotencyKey: `generated-preview-${generated.suffix}`,
      };
      await value.application.preparePreview(
        value.activePrincipal,
        preview,
        context,
      );
      const assertPreviewReplay = () => expect(
        value.application.preparePreview(
          value.activePrincipal,
          preview,
          context,
        ),
      ).resolves.toMatchObject({
        result: { replayed: true },
        meta: { replayed: true },
      });
      if (!generated.previewReplayAfterActorDenials) {
        await assertPreviewReplay();
      }
      for (const actorId of [
        `agent-substituted-${generated.suffix}`,
        `agent-replay-${generated.suffix}`,
      ]) {
        const substituted = { ...value.activePrincipal, actorId };
        await expect(
          value.application.getWorkspace(
            substituted,
            opened.workspaceId,
            context,
          ),
        ).rejects.toBeInstanceOf(McpReadError);
        await expect(
          value.application.preparePreview(substituted, preview, context),
        ).rejects.toBeInstanceOf(McpReadError);
      }
      if (generated.previewReplayAfterActorDenials) {
        await assertPreviewReplay();
      }
    }
  });

  it("conceals a real foreign-site workspace and preview without changing state", async () => {
    const value = fixture([mcpInitialScope, mcpContentDraftScope]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await value.application.openWorkspace(
        value.activePrincipal,
        {
          expectedRevision: 0,
          idempotencyKey: "pairwise-site-workspace-open",
        },
        context,
      ),
    );
    const foreign = principal(
      [mcpInitialScope, mcpContentDraftScope],
      createSiteId("site_pairwise_foreign"),
    );
    value.setActivePrincipal(foreign);
    const beforeRevision = await value.workspaces
      .get(opened.workspaceId)!
      .queries.getCurrent();
    await expect(
      value.application.getWorkspace(foreign, opened.workspaceId, context),
    ).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    await expect(
      value.application.preparePreview(
        foreign,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "pairwise-site-preview",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "OBJECT_NOT_FOUND" });
    await expect(
      value.workspaces.get(opened.workspaceId)!.queries.getCurrent(),
    ).resolves.toEqual(beforeRevision);
    expect(value.auditEvents).toEqual([
      expect.objectContaining({
        siteId: foreign.siteId,
        outcome: "denied",
        reason: "OBJECT_NOT_FOUND",
      }),
    ]);
    expect(JSON.stringify(value.auditEvents)).not.toContain(opened.workspaceId);
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
    // The denial is recorded through the joined mutation recorder, not the
    // read-audit list, and it still carries the exact scopes evaluated.
    expect(fixtureValue.auditEvents).not.toContainEqual(
      expect.objectContaining({
        operation: "foundry.preview.prepare",
      }),
    );
    expect(fixtureValue.failureEvents).toContainEqual(
      expect.objectContaining({
        operation: "foundry.preview.prepare",
        outcome: "denied",
        reason: "INSUFFICIENT_SCOPE",
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

describe("MCP page tools", () => {
  async function openedDraft(scopes: ReadonlyArray<string>, key: string) {
    const fixtureValue = fixture(scopes);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        { expectedRevision: 0, idempotencyKey: key },
        context,
      ),
    );
    return { fixtureValue, workspaceId: opened.workspaceId };
  }

  function definitionOf(
    fixtureValue: ReturnType<typeof fixture>,
    workspaceId: ContentWorkspaceId,
  ) {
    return fixtureValue.workspaces
      .get(workspaceId)!
      .queries.getCurrent()
      .then(({ definition }) => definition);
  }

  it("adds, edits, copies and removes a page inside one draft", async () => {
    const { fixtureValue, workspaceId } = await openedDraft(
      [mcpInitialScope, mcpContentDraftScope],
      "open-page-journey-1",
    );
    const principalValue = fixtureValue.activePrincipal;

    const created = resultOf<{ pageId: string; revision: number }>(
      await fixtureValue.application.createPage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-create-journey-1",
          title: "About us",
          slug: "about-us",
          startingLayout: "introduction",
        },
        context,
      ),
    );
    expect(created.revision).toBe(1);
    expect(isMintedPageId(created.pageId)).toBe(true);
    const afterCreate = await definitionOf(fixtureValue, workspaceId);
    expect(findPageById(afterCreate, created.pageId)).toMatchObject({
      title: "About us",
      slug: "about-us",
    });

    // The new page's own fields are editable in the same draft, even though
    // the installed definition never held them.
    const patched = resultOf<{ revision: number }>(
      await fixtureValue.application.patchContent(
        principalValue,
        {
          workspaceId,
          expectedRevision: 1,
          idempotencyKey: "page-journey-patch-1",
          operations: [
            {
              op: "set",
              field: `${created.pageId}.seo.description`,
              value: "What this studio does and why.",
            },
          ],
        },
        context,
      ),
    );
    expect(patched.revision).toBe(2);
    expect(
      findPageById(
        await definitionOf(fixtureValue, workspaceId),
        created.pageId,
      )?.seo.description,
    ).toBe("What this studio does and why.");

    const renamed = resultOf<{ pageId: string }>(
      await fixtureValue.application.renamePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 2,
          idempotencyKey: "page-rename-journey-1",
          pageId: created.pageId,
          title: "Our approach",
          slug: "our-approach",
        },
        context,
      ),
    );
    expect(renamed.pageId).toBe(created.pageId);
    expect(
      findPageById(
        await definitionOf(fixtureValue, workspaceId),
        created.pageId,
      ),
    ).toMatchObject({ title: "Our approach", slug: "our-approach" });

    const copied = resultOf<{ pageId: string }>(
      await fixtureValue.application.duplicatePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 3,
          idempotencyKey: "page-duplicate-journey-1",
          pageId: created.pageId,
          title: "Our approach in detail",
          slug: "our-approach-in-detail",
        },
        context,
      ),
    );
    expect(copied.pageId).not.toBe(created.pageId);
    const afterCopy = await definitionOf(fixtureValue, workspaceId);
    expect(afterCopy.pages.map(({ slug }) => slug)).toEqual([
      "",
      "our-approach",
      "our-approach-in-detail",
    ]);
    // No two pages share a section id, so no two pages share a field path.
    const sectionIds = afterCopy.pages.flatMap(({ sections }) =>
      sections.map(({ id }) => id),
    );
    expect(new Set(sectionIds).size).toBe(sectionIds.length);

    const deleted = resultOf<{ pageId: string; revision: number }>(
      await fixtureValue.application.deletePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 4,
          idempotencyKey: "page-delete-journey-1",
          pageId: copied.pageId,
        },
        context,
      ),
    );
    expect(deleted).toMatchObject({ pageId: copied.pageId, revision: 5 });
    expect(
      findPageById(
        await definitionOf(fixtureValue, workspaceId),
        copied.pageId,
      ),
    ).toBeUndefined();
  });

  it("names the field a content edit was refused for", async () => {
    const { fixtureValue, workspaceId } = await openedDraft(
      [mcpInitialScope, mcpContentDraftScope],
      "open-page-field-refusal-1",
    );
    const principalValue = fixtureValue.activePrincipal;
    const missing = "page_0123456789abcdef0123.seo.description";

    await expect(
      fixtureValue.application.patchContent(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "patch-missing-field-1",
          operations: [{ op: "set", field: missing, value: "Words." }],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "content_field_not_editable",
      message: `This draft has no field at ${missing}.`,
    });

    // A design setting is in the draft, so the refusal says which tool
    // changes it rather than claiming the field does not exist.
    await expect(
      fixtureValue.application.patchContent(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "patch-design-field-1",
          operations: [
            { op: "set", field: "design.colour.accent", value: "moss" },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "design_field_not_content",
      message:
        "The field design.colour.accent is a design setting, not content. Use foundry.design.patch for a design change.",
    });

    await expect(
      fixtureValue.application.patchContent(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "patch-wrong-format-1",
          operations: [
            {
              op: "set",
              field: `${referenceSiteDefinition.site.id}.name`,
              value: createRichTextDocumentFromPlainText("Words."),
              format: "richText",
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "content_field_format_mismatch",
    });
  });

  it("carries a page the whole way on the content draft scope alone", async () => {
    const { fixtureValue, workspaceId } = await openedDraft(
      [mcpInitialScope, mcpContentDraftScope],
      "open-page-scope-journey-1",
    );
    const principalValue = fixtureValue.activePrincipal;

    // A starting point places sections, and a section carries a design
    // variant field. Those fields are new, not changed, so adding a page
    // stays a content change and the agent can still preview its own work.
    const created = resultOf<{ pageId: string }>(
      await fixtureValue.application.createPage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-create-scope-journey-1",
          title: "What we offer",
          slug: "what-we-offer",
          startingLayout: "what_you_offer",
        },
        context,
      ),
    );
    await expect(
      fixtureValue.application.getWorkspace(
        principalValue,
        workspaceId,
        context,
      ),
    ).resolves.toBeDefined();
    const prepared = resultOf<{ previewId: string }>(
      await fixtureValue.application.preparePreview(
        principalValue,
        {
          workspaceId,
          expectedRevision: 1,
          idempotencyKey: "page-preview-scope-journey-1",
        },
        context,
      ),
    );
    expect(prepared.previewId).toEqual(expect.any(String));
    expect(
      fixtureValue.previewScopesEvaluated.at(-1),
    ).toEqual([mcpContentDraftScope]);

    // Removing a page changes no field and removes many, so it is a content
    // change too rather than a revision that looks unchanged.
    await fixtureValue.application.deletePage(
      principalValue,
      {
        workspaceId,
        expectedRevision: 1,
        idempotencyKey: "page-delete-scope-journey-1",
        pageId: created.pageId,
      },
      context,
    );
    await fixtureValue.application.preparePreview(
      principalValue,
      {
        workspaceId,
        expectedRevision: 2,
        idempotencyKey: "page-preview-scope-journey-2",
      },
      context,
    );
    expect(
      fixtureValue.previewScopesEvaluated.at(-1),
    ).toEqual([mcpContentDraftScope]);
  });

  it("refuses a page operation with a named reason an agent can act on", async () => {
    const { fixtureValue, workspaceId } = await openedDraft(
      [mcpInitialScope, mcpContentDraftScope],
      "open-page-refusal-1",
    );
    const principalValue = fixtureValue.activePrincipal;
    const home = homePage(referenceSiteDefinition);

    await expect(
      fixtureValue.application.deletePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-delete-home-1",
          pageId: home.id,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_is_home",
      message:
        "The home page cannot be deleted. Every site needs a home page.",
    });

    // Sending that same refused request again says the same thing, because
    // the reason is recorded with the code and the message.
    await expect(
      fixtureValue.application.deletePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-delete-home-1",
          pageId: home.id,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_is_home",
      replayed: true,
    });

    await expect(
      fixtureValue.application.deletePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-delete-missing-1",
          pageId: mintedPageId("2".repeat(20)),
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_not_found",
    });

    await expect(
      fixtureValue.application.createPage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-create-reserved-1",
          title: "Blog",
          slug: "blog",
          startingLayout: "blank",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_slug_refused",
      message: "The site already uses /blog for something else. Choose another web address.",
    });

    // A rename is two ordinary field edits, so the field's own check refuses
    // it and the tool reports the field sentences under one named reason.
    await expect(
      fixtureValue.application.renamePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-rename-home-address-1",
          pageId: home.id,
          title: "Welcome",
          slug: "welcome",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_fields_refused",
      message:
        "The home page always sits at the top of the site, so its web address cannot change.",
    });
  });

  it("mints one page for a repeated create and refuses a stale base revision", async () => {
    const { fixtureValue, workspaceId } = await openedDraft(
      [mcpInitialScope, mcpContentDraftScope],
      "open-page-replay-1",
    );
    const principalValue = fixtureValue.activePrincipal;
    const input = {
      workspaceId,
      expectedRevision: 0,
      idempotencyKey: "page-create-replay-1",
      title: "Contact",
      slug: "contact-us",
      startingLayout: "blank",
    };

    const first = resultOf<{ pageId: string; replayed: boolean }>(
      await fixtureValue.application.createPage(
        principalValue,
        input,
        context,
      ),
    );
    const second = resultOf<{
      pageId: string;
      replayed: boolean;
      revision: number;
    }>(await fixtureValue.application.createPage(
      principalValue,
      input,
      context,
    ));
    expect(second).toMatchObject({
      pageId: first.pageId,
      replayed: true,
      revision: 1,
    });
    const definition = await definitionOf(fixtureValue, workspaceId);
    expect(definition.pages).toHaveLength(2);

    await expect(
      fixtureValue.application.createPage(
        principalValue,
        {
          ...input,
          idempotencyKey: "page-create-stale-1",
          slug: "contact-team",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "STALE_REVISION", latestRevision: 1 });
  });

  it("needs the content draft scope for every page operation", async () => {
    const { fixtureValue, workspaceId } = await openedDraft(
      [mcpInitialScope, mcpDesignDraftScope],
      "open-page-scope-1",
    );
    await expect(
      fixtureValue.application.createPage(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "page-create-unscoped-1",
          title: "Ideas",
          slug: "ideas",
          startingLayout: "blank",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope],
    });
  });

  it("adds nothing of its own to the page operation the dashboard calls", async () => {
    const { fixtureValue, workspaceId } = await openedDraft(
      [mcpInitialScope, mcpContentDraftScope],
      "open-page-parity-1",
    );
    const idempotencyKey = "page-create-parity-1";
    const mcp = resultOf<{
      pageId: string;
      revision: number;
      contentHash: string;
      validation: unknown;
      previewArtifact: string;
    }>(
      await fixtureValue.application.createPage(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey,
          title: "What we offer",
          slug: "what-we-offer",
          startingLayout: "what_you_offer",
        },
        context,
      ),
    );

    // `savePageMutation` in app/api/foundry-cms/revisions/route.ts is all the
    // dashboard does for a create: it calls `commands.createPage` with the
    // owner's actor and the body's title, address and starting point. The
    // same call is made here, so what is being compared is whether the MCP
    // tool adds anything of its own to that operation. It must not.
    const humanActor = createContentActorId("membership-human-55");
    const human = createContentRevisionApplication({
      siteDefinition: referenceSiteDefinition,
      store: createInMemoryContentRevisionStore(),
      workspaceId,
      actorId: humanActor,
      rendererVersion,
      productionBase,
      now: () => now,
    });
    await human.commands.create({
      actorId: humanActor,
      workspaceId,
      idempotencyKey: "open-human-page-parity-1",
    });
    const humanResult = await human.commands.createPage({
      actorId: humanActor,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 0,
      idempotencyKey: `mcp-${await sha256CanonicalJson({
        operation: "foundry.page.create",
        idempotencyKey,
      })}`,
      title: "What we offer",
      slug: "what-we-offer",
      startingLayout: "what_you_offer",
    });

    expect({
      pageId: mcp.pageId,
      revision: mcp.revision,
      contentHash: mcp.contentHash,
      validation: mcp.validation,
      previewArtifact: mcp.previewArtifact,
    }).toEqual({
      pageId: humanResult.pageId,
      revision: humanResult.revision.revision,
      contentHash: humanResult.revision.inputs.contentHash,
      validation: { valid: true, issues: [] },
      previewArtifact: await createCanonicalPreviewArtifactHash(
        humanResult.revision,
      ),
    });
    expect(
      findPageById(
        await definitionOf(fixtureValue, workspaceId),
        mcp.pageId,
      ),
    ).toEqual(
      findPageById(
        (await human.queries.getCurrent()).definition,
        humanResult.pageId,
      ),
    );

    // A real owner would not be holding the agent's idempotency key, so their
    // page gets a different id. Everything else about it is still the same
    // page, down to each section's own id built from that page id.
    const ownKeyResult = await human.commands.createPage({
      actorId: humanActor,
      workspaceId,
      schemaVersion: referenceSiteDefinition.schemaVersion,
      baseRevision: 1,
      idempotencyKey: "human-own-page-parity-key-1",
      title: "What we offer",
      slug: "what-we-offer-again",
      startingLayout: "what_you_offer",
    });
    const withOwnKey = findPageById(
      (await human.queries.getCurrent()).definition,
      ownKeyResult.pageId,
    )!;
    const fromAgent = findPageById(
      await definitionOf(fixtureValue, workspaceId),
      mcp.pageId,
    )!;
    expect(ownKeyResult.pageId).not.toBe(mcp.pageId);
    expect(
      JSON.parse(
        JSON.stringify({ ...withOwnKey, id: "", slug: "" }).replaceAll(
          ownKeyResult.pageId,
          "",
        ),
      ),
    ).toEqual(
      JSON.parse(
        JSON.stringify({ ...fromAgent, id: "", slug: "" }).replaceAll(
          mcp.pageId,
          "",
        ),
      ),
    );
  });
});

describe("MCP page restructure tool", () => {
  async function openedDraft(scopes: ReadonlyArray<string>, key: string) {
    const fixtureValue = fixture(scopes);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        { expectedRevision: 0, idempotencyKey: key },
        context,
      ),
    );
    return { fixtureValue, workspaceId: opened.workspaceId };
  }

  /** A draft with one page of the agent's own, at revision 1. */
  async function draftWithPage(scopes: ReadonlyArray<string>, key: string) {
    const { fixtureValue, workspaceId } = await openedDraft(scopes, key);
    const created = resultOf<{ pageId: string }>(
      await fixtureValue.application.createPage(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: `${key}-create`,
          title: "What we offer",
          slug: "what-we-offer",
          startingLayout: "what_you_offer",
        },
        context,
      ),
    );
    return { fixtureValue, workspaceId, pageId: created.pageId };
  }

  async function sectionsOf(
    fixtureValue: ReturnType<typeof fixture>,
    workspaceId: ContentWorkspaceId,
    pageId: string,
  ) {
    const { definition } = await fixtureValue.workspaces
      .get(workspaceId)!
      .queries.getCurrent();
    return findPageById(definition, pageId)!.sections;
  }

  it("changes the sections of a page the agent made inside the draft", async () => {
    const { fixtureValue, workspaceId, pageId } = await draftWithPage(
      [mcpInitialScope, mcpContentDraftScope],
      "open-restructure-1",
    );
    const result = resultOf<{
      pageId: string;
      revision: number;
      replayed: boolean;
      previewArtifact: string;
    }>(
      await fixtureValue.application.restructurePage(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 1,
          idempotencyKey: "restructure-1",
          pageId,
          operations: [
            { op: "add", sectionType: "proof", position: 1 },
            { op: "remove", sectionId: `${pageId}_services` },
          ],
        },
        context,
      ),
    );
    expect(result.pageId).toBe(pageId);
    expect(result.revision).toBe(2);
    expect(result.replayed).toBe(false);
    expect(result.previewArtifact).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      (await sectionsOf(fixtureValue, workspaceId, pageId)).map(
        ({ type }) => type,
      ),
    ).toEqual(["hero", "proof", "callToAction"]);
  });

  it("repeats the same answer when the same request is sent twice", async () => {
    const { fixtureValue, workspaceId, pageId } = await draftWithPage(
      [mcpInitialScope, mcpContentDraftScope],
      "open-restructure-replay",
    );
    const input = {
      workspaceId,
      expectedRevision: 1,
      idempotencyKey: "restructure-replay-1",
      pageId,
      operations: [
        { op: "duplicate" as const, sectionId: `${pageId}_services` },
      ],
    };
    const first = resultOf<{ revision: number }>(
      await fixtureValue.application.restructurePage(
        fixtureValue.activePrincipal,
        input,
        context,
      ),
    );
    const second = resultOf<{ revision: number; replayed: boolean }>(
      await fixtureValue.application.restructurePage(
        fixtureValue.activePrincipal,
        input,
        context,
      ),
    );
    expect(second.replayed).toBe(true);
    expect(second.revision).toBe(first.revision);
    expect(
      await sectionsOf(fixtureValue, workspaceId, pageId),
    ).toHaveLength(4);
  });

  it("needs the content draft scope, and the design scope only to choose a section style", async () => {
    const withContent = await draftWithPage(
      [mcpInitialScope, mcpContentDraftScope],
      "open-restructure-scope-1",
    );
    await expect(
      withContent.fixtureValue.application.restructurePage(
        withContent.fixtureValue.activePrincipal,
        {
          workspaceId: withContent.workspaceId,
          expectedRevision: 1,
          idempotencyKey: "restructure-scope-variant-1",
          pageId: withContent.pageId,
          operations: [
            {
              op: "set_variant",
              sectionId: `${withContent.pageId}_hero`,
              variant: "focused",
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope, mcpDesignDraftScope],
    });

    const designOnly = await openedDraft(
      [mcpInitialScope, mcpDesignDraftScope],
      "open-restructure-scope-2",
    );
    await expect(
      designOnly.fixtureValue.application.restructurePage(
        designOnly.fixtureValue.activePrincipal,
        {
          workspaceId: designOnly.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "restructure-scope-structure-1",
          pageId: "page_0123456789abcdef0123",
          operations: [{ op: "add", sectionType: "proof", position: 0 }],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope],
    });
  });

  it("styles a section on a page made inside the draft when both scopes are held", async () => {
    const { fixtureValue, workspaceId, pageId } = await draftWithPage(
      [mcpInitialScope, mcpContentDraftScope, mcpDesignDraftScope],
      "open-restructure-arrange",
    );
    await fixtureValue.application.restructurePage(
      fixtureValue.activePrincipal,
      {
        workspaceId,
        expectedRevision: 1,
        idempotencyKey: "restructure-arrange-1",
        pageId,
        operations: [
          { op: "set_variant", sectionId: `${pageId}_hero`, variant: "focused" },
          { op: "add", sectionType: "proof", position: 3, variant: "panel" },
        ],
      },
      context,
    );
    const sections = await sectionsOf(fixtureValue, workspaceId, pageId);
    expect(sections[0]!.type === "hero" && sections[0]!.variant).toBe(
      "focused",
    );
    expect(sections[3]!.type === "proof" && sections[3]!.variant).toBe(
      "panel",
    );
  });

  it("prepares a preview of the page it restructured, on the content scope alone", async () => {
    const { fixtureValue, workspaceId, pageId } = await draftWithPage(
      [mcpInitialScope, mcpContentDraftScope],
      "open-restructure-preview",
    );
    await fixtureValue.application.restructurePage(
      fixtureValue.activePrincipal,
      {
        workspaceId,
        expectedRevision: 1,
        idempotencyKey: "restructure-preview-1",
        pageId,
        operations: [{ op: "add", sectionType: "proof", position: 1 }],
      },
      context,
    );
    const prepared = resultOf<{
      previewId: string;
      humanReviewUrl: string;
      approvalStatus: string;
    }>(
      await fixtureValue.application.preparePreview(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 2,
          idempotencyKey: "restructure-preview-prepare-1",
        },
        context,
      ),
    );
    expect(prepared.previewId).toEqual(expect.any(String));
    // Preparing a preview never approves it; a person still has to.
    expect(prepared.approvalStatus).toBe("pending_human_review");
    expect(
      fixtureValue.previewScopesEvaluated.at(-1),
    ).toEqual([mcpContentDraftScope]);
  });

  it("copies a section with the style it already carries, on the content scope alone", async () => {
    const { fixtureValue, workspaceId, pageId } = await draftWithPage(
      [mcpInitialScope, mcpContentDraftScope, mcpDesignDraftScope],
      "open-restructure-copy-style",
    );
    await fixtureValue.application.restructurePage(
      fixtureValue.activePrincipal,
      {
        workspaceId,
        expectedRevision: 1,
        idempotencyKey: "restructure-copy-style-1",
        pageId,
        operations: [
          { op: "set_variant", sectionId: `${pageId}_hero`, variant: "focused" },
        ],
      },
      context,
    );
    // The agent names no style here, so the copy needs the content scope only,
    // the same as copying a whole page does. See ADR-0035.
    expect(
      mcpRestructureScopes([{ op: "duplicate", sectionId: `${pageId}_hero` }]),
    ).toEqual([mcpContentDraftScope]);
    await fixtureValue.application.restructurePage(
      fixtureValue.activePrincipal,
      {
        workspaceId,
        expectedRevision: 2,
        idempotencyKey: "restructure-copy-style-2",
        pageId,
        operations: [{ op: "duplicate", sectionId: `${pageId}_hero` }],
      },
      context,
    );
    const sections = await sectionsOf(fixtureValue, workspaceId, pageId);
    expect(sections[1]!.type === "hero" && sections[1]!.variant).toBe(
      "focused",
    );
  });

  it("refuses a restructure with a named reason an agent can act on", async () => {
    const { fixtureValue, workspaceId, pageId } = await draftWithPage(
      [mcpInitialScope, mcpContentDraftScope],
      "open-restructure-refusal",
    );
    const principalValue = fixtureValue.activePrincipal;
    const restructure = (
      idempotencyKey: string,
      operations: ReadonlyArray<unknown>,
      page: string = pageId,
    ) =>
      fixtureValue.application.restructurePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 1,
          idempotencyKey,
          pageId: page,
          operations: operations as never,
        },
        context,
      );

    await expect(
      restructure(
        "restructure-refusal-missing-page",
        [{ op: "add", sectionType: "proof", position: 0 }],
        mintedPageId("3".repeat(20)),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_not_found",
    });

    await expect(
      restructure("restructure-refusal-missing-section", [
        { op: "remove", sectionId: "not_a_section" },
      ]),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_section_not_found",
      message: "That section is not on this page.",
    });

    // Sending that same refused request again says the same thing.
    await expect(
      restructure("restructure-refusal-missing-section", [
        { op: "remove", sectionId: "not_a_section" },
      ]),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_section_not_found",
      replayed: true,
    });

    await expect(
      restructure("restructure-refusal-empty-page", [
        { op: "remove", sectionId: `${pageId}_hero` },
        { op: "remove", sectionId: `${pageId}_services` },
        { op: "remove", sectionId: `${pageId}_call_to_action` },
      ]),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "page_sections_refused",
    });
  });
});

describe("MCP design tool on a draft-made page", () => {
  it("styles a section the installed site never held, and names why it refuses", async () => {
    const fixtureValue = fixture([
      mcpInitialScope,
      mcpContentDraftScope,
      mcpDesignDraftScope,
    ]);
    const principalValue = fixtureValue.activePrincipal;
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        principalValue,
        { expectedRevision: 0, idempotencyKey: "open-design-draft-page-1" },
        context,
      ),
    );
    const created = resultOf<{ pageId: string }>(
      await fixtureValue.application.createPage(
        principalValue,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "design-draft-page-create-1",
          title: "What we offer",
          slug: "what-we-offer",
          startingLayout: "what_you_offer",
        },
        context,
      ),
    );
    // The section is on a page the installed site has never held, so an
    // enumeration built from the installed site could not have named it.
    await fixtureValue.application.patchDesign(
      principalValue,
      {
        workspaceId: opened.workspaceId,
        expectedRevision: 1,
        idempotencyKey: "design-draft-page-variant-1",
        operations: [
          {
            op: "set_variant",
            componentId: `${created.pageId}.${created.pageId}_hero`,
            value: "focused",
          },
        ],
      },
      context,
    );
    const { definition } = await fixtureValue.workspaces
      .get(opened.workspaceId)!
      .queries.getCurrent();
    const hero = findPageById(definition, created.pageId)!.sections[0]!;
    expect(hero.type === "hero" && hero.variant).toBe("focused");

    await expect(
      fixtureValue.application.patchDesign(
        principalValue,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 2,
          idempotencyKey: "design-draft-page-variant-2",
          operations: [
            {
              op: "set_variant",
              componentId: "no_such_section",
              value: "focused",
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "design_setting_not_found",
    });

    await expect(
      fixtureValue.application.patchDesign(
        principalValue,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 2,
          idempotencyKey: "design-draft-page-variant-3",
          operations: [
            {
              op: "set_variant",
              componentId: `${created.pageId}.${created.pageId}_hero`,
              value: "cards",
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "design_value_not_registered",
    });
  });
});

describe("MCP blog draft tools", () => {
  const post = {
    slug: "spring-open-day",
    title: "Spring open day",
    excerpt: "What to expect on the day.",
    seo: {
      title: "Spring open day",
      description: "What to expect on the day.",
      keywords: ["events", "spring"],
      shareImage: null,
    },
    mainImage: null,
    body: createRichTextDocumentFromPlainText("Doors open at ten."),
  } as const;

  async function openedDraft(key: string) {
    const fixtureValue = fixture([mcpInitialScope, mcpContentDraftScope]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        { expectedRevision: 0, idempotencyKey: key },
        context,
      ),
    );
    return { fixtureValue, workspaceId: opened.workspaceId };
  }

  function definitionOf(
    fixtureValue: ReturnType<typeof fixture>,
    workspaceId: ContentWorkspaceId,
  ) {
    return fixtureValue.workspaces
      .get(workspaceId)!
      .queries.getCurrent()
      .then(({ definition }) => definition);
  }

  it("writes a post, mints its id, and rewrites it in the same draft", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-1-00000000");
    const principalValue = fixtureValue.activePrincipal;

    const created = resultOf<{ postId: string; revision: number }>(
      await fixtureValue.application.createBlogPost(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "blog-create-1-000000",
          post,
        },
        context,
      ),
    );
    expect(created.revision).toBe(1);
    // The agent never chose this id. The tool minted it as a version 4
    // UUID, which is the only shape the blog accepts.
    expect(created.postId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const afterCreate = await definitionOf(fixtureValue, workspaceId);
    expect(
      afterCreate.blog.posts.find(({ id }) => id === created.postId),
    ).toMatchObject({
      slug: "spring-open-day",
      title: "Spring open day",
      targetVisibility: "public",
      revision: 1,
    });

    const updated = resultOf<{ postId: string; revision: number }>(
      await fixtureValue.application.updateBlogPost(
        principalValue,
        {
          workspaceId,
          expectedRevision: 1,
          idempotencyKey: "blog-update-1-000000",
          postId: created.postId,
          post: { ...post, title: "Spring open day, rescheduled" },
        },
        context,
      ),
    );
    expect(updated.postId).toBe(created.postId);
    expect(updated.revision).toBe(2);
    expect(
      (await definitionOf(fixtureValue, workspaceId)).blog.posts.find(
        ({ id }) => id === created.postId,
      )?.title,
    ).toBe("Spring open day, rescheduled");
  });

  it("refuses a picture the site does not hold, and names why", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-2-00000000");
    await expect(
      fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "blog-create-outside-picture",
          post: {
            ...post,
            mainImage: {
              url: "https://pictures.example/hero.jpg",
              alt: "Somewhere else",
            },
          },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "blog_media_not_in_library",
    });
  });

  it("refuses a media path for a photo the library does not hold", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-8-0000");
    await expect(
      fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "blog-create-unknown-photo",
          post: {
            ...post,
            mainImage: {
              url: "/api/media/asset_never_uploaded",
              alt: "Not there",
            },
          },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "blog_media_not_in_library",
    });
  });

  it("refuses a picture in the body that the library does not hold", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-9-0000");
    await expect(
      fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "blog-create-body-photo",
          post: {
            ...post,
            body: {
              ...post.body,
              children: [
                ...post.body.children,
                {
                  type: "image" as const,
                  src: "/api/media/asset_never_uploaded",
                  alt: "Not there",
                },
              ],
            },
          },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "blog_media_not_in_library",
    });
  });

  it("accepts a photo the media library already holds", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-3-00000000");
    const created = resultOf<{ postId: string }>(
      await fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "blog-create-own-picture",
          post: {
            ...post,
            mainImage: {
              url: "/api/media/asset_open_day",
              alt: "The workshop",
            },
          },
        },
        context,
      ),
    );
    expect(
      (await definitionOf(fixtureValue, workspaceId)).blog.posts.find(
        ({ id }) => id === created.postId,
      )?.mainImage,
    ).toEqual({ url: "/api/media/asset_open_day", alt: "The workshop" });
  });

  it("refuses a second post on a web address the draft already uses", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-4-00000000");
    await fixtureValue.application.createBlogPost(
      fixtureValue.activePrincipal,
      {
        workspaceId,
        expectedRevision: 0,
        idempotencyKey: "blog-create-first",
        post,
      },
      context,
    );
    await expect(
      fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 1,
          idempotencyKey: "blog-create-same-address",
          post: { ...post, title: "A different post" },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "slug_already_exists",
    });
  });

  it("refuses a post write without the content draft permission", async () => {
    const fixtureValue = fixture([mcpInitialScope, mcpDesignDraftScope]);
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await fixtureValue.application.openWorkspace(
        fixtureValue.activePrincipal,
        { expectedRevision: 0, idempotencyKey: "open-blog-5-00000000" },
        context,
      ),
    );
    await expect(
      fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        {
          workspaceId: opened.workspaceId,
          expectedRevision: 0,
          idempotencyKey: "blog-create-no-scope",
          post,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
      requiredScopes: [mcpContentDraftScope],
    });
  });

  it("answers a repeated write from its receipt instead of writing again", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-6-00000000");
    const request = {
      workspaceId,
      expectedRevision: 0,
      idempotencyKey: "blog-create-replay",
      post,
    } as const;
    const first = resultOf<{ postId: string; revision: number }>(
      await fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        request,
        context,
      ),
    );
    const second = resultOf<{
      postId: string;
      revision: number;
      replayed: boolean;
    }>(
      await fixtureValue.application.createBlogPost(
        fixtureValue.activePrincipal,
        request,
        context,
      ),
    );
    expect(second.replayed).toBe(true);
    expect(second.postId).toBe(first.postId);
    expect(second.revision).toBe(first.revision);
    expect(
      (await definitionOf(fixtureValue, workspaceId)).blog.posts.filter(
        ({ id }) => id === first.postId,
      ),
    ).toHaveLength(1);
  });

  it("refuses an update to a post the draft does not hold", async () => {
    const { fixtureValue, workspaceId } = await openedDraft("open-blog-7-00000000");
    await expect(
      fixtureValue.application.updateBlogPost(
        fixtureValue.activePrincipal,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "blog-update-missing",
          postId: "00000000-0000-4000-8000-00000000abcd",
          post,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "post_not_found",
    });
  });
});

describe("MCP page and blog acceptance journey", () => {
  it("restructures a page, writes a full post, and prepares a preview in one draft", async () => {
    // The acceptance criterion of issue #171: one agent, one draft, a page
    // whose sections it changed and a post it wrote from nothing, handed to a
    // person as a canonical preview.
    const value = fixture([mcpInitialScope, mcpContentDraftScope]);
    const principalValue = value.activePrincipal;
    const opened = resultOf<{ workspaceId: ContentWorkspaceId }>(
      await value.application.openWorkspace(
        principalValue,
        { expectedRevision: 0, idempotencyKey: "open-blog-journey-1" },
        context,
      ),
    );
    const workspaceId = opened.workspaceId;

    const page = resultOf<{ pageId: string; revision: number }>(
      await value.application.createPage(
        principalValue,
        {
          workspaceId,
          expectedRevision: 0,
          idempotencyKey: "journey-page-create-1",
          title: "News",
          slug: "news",
          startingLayout: "introduction",
        },
        context,
      ),
    );
    const restructured = resultOf<{ revision: number }>(
      await value.application.restructurePage(
        principalValue,
        {
          workspaceId,
          expectedRevision: page.revision,
          idempotencyKey: "journey-page-restructure-1",
          pageId: page.pageId,
          operations: [{ op: "add", sectionType: "proof", position: 1 }],
        },
        context,
      ),
    );

    const created = resultOf<{ postId: string; revision: number }>(
      await value.application.createBlogPost(
        principalValue,
        {
          workspaceId,
          expectedRevision: restructured.revision,
          idempotencyKey: "journey-blog-create-1",
          post: {
            slug: "open-day",
            title: "Open day",
            excerpt: "What to expect.",
            seo: {
              title: "Open day",
              description: "What to expect.",
              keywords: ["events"],
              shareImage: null,
            },
            mainImage: {
              url: "/api/media/asset_open_day",
              alt: "The workshop",
            },
            body: createRichTextDocumentFromPlainText("Doors open at ten."),
          },
        },
        context,
      ),
    );

    const { definition } = await value.workspaces
      .get(workspaceId)!
      .queries.getCurrent();
    expect(findPageById(definition, page.pageId)!.sections).toHaveLength(3);
    expect(
      definition.blog.posts.find(({ id }) => id === created.postId)?.title,
    ).toBe("Open day");

    const preview = resultOf<{ previewId: string; humanReviewUrl: string }>(
      await value.application.preparePreview(
        principalValue,
        {
          workspaceId,
          expectedRevision: created.revision,
          idempotencyKey: "journey-preview-1",
        },
        context,
      ),
    );
    expect(preview.previewId).toBeTruthy();
    // The preview is where the agent stops. Nothing here approves it.
    expect(preview.humanReviewUrl).toContain(preview.previewId);
  });
});

import {
  designContract,
  listEditableSiteFields,
  serializeRichTextDocument,
  type RichTextDocument,
  type SiteDefinition,
  type SiteDefinitionEdit,
  type SiteId,
} from "@foundry/site-definition";

import {
  ContentRevisionConflictError,
  ContentRevisionStaleError,
  createContentActorId,
  type ContentRevision,
  type ContentRevisionApplication,
  type ContentWorkspaceId,
  type SavedContentRevision,
} from "./content-revisions";
import { sha256CanonicalJson } from "./deterministic-hash";
import {
  McpReadError,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  type McpConnectionPrincipal,
  type McpExecutionContext,
  type McpReadAuditEvent,
} from "./mcp-read";

export type McpDraftRuntime = Readonly<{
  replayMutation(input: {
    principal: McpConnectionPrincipal;
    audit: McpReadAuditEvent & { idempotencyKey: string };
  }): Promise<
    | Readonly<{
        state: "succeeded";
        workspaceId: ContentWorkspaceId;
        revision: number;
        contentHash: string;
        resultHash: string;
        previewId: string | null;
      }>
    | null
  >;
  recordMutationFailure(input: {
    principal: McpConnectionPrincipal;
    audit: McpReadAuditEvent & { idempotencyKey: string };
    resultHash: string;
    error: Readonly<{
      code: McpReadError["code"];
      message: string;
      latestRevision: number | null;
      conflictResource: string | null;
    }>;
  }): Promise<
    Readonly<{
      error: Readonly<{
        code: McpReadError["code"];
        message: string;
        latestRevision: number | null;
        conflictResource: string | null;
      }>;
      observedAt: string;
      replayed: boolean;
    }>
  >;
  open(input: {
    principal: McpConnectionPrincipal;
    actorId: ReturnType<typeof createContentActorId>;
    idempotencyKey: string;
  }): Promise<ContentRevisionApplication>;
  load(input: {
    principal: McpConnectionPrincipal;
    actorId: ReturnType<typeof createContentActorId>;
    workspaceId: ContentWorkspaceId;
  }): Promise<ContentRevisionApplication>;
  humanReviewUrl(previewId: string): string;
  replayPreview(input: {
    principal: McpConnectionPrincipal;
    workspaceId: ContentWorkspaceId;
    revision: number;
    idempotencyKey: string;
    requestHash: string;
    artifactHash: string;
    contentHash: string;
    audit: McpReadAuditEvent & { idempotencyKey: string };
  }): Promise<Readonly<{ previewId: string; replayed: true }> | null>;
  preparePreview(input: {
    principal: McpConnectionPrincipal;
    workspaceId: ContentWorkspaceId;
    revision: number;
    idempotencyKey: string;
    requestHash: string;
    artifactHash: string;
    contentHash: string;
    audit: McpReadAuditEvent & { idempotencyKey: string };
  }): Promise<Readonly<{ previewId: string; replayed: boolean }>>;
}>;

export type McpContentPatchOperation =
  | Readonly<{
      op: "set";
      field: string;
      value: string;
      format?: "plainText";
    }>
  | Readonly<{
      op: "set";
      field: string;
      value: RichTextDocument;
      format: "richText";
    }>;

export type McpDesignPatchOperation =
  | Readonly<{
      op: "set_token";
      token: keyof typeof designContract.tokens;
      value: string;
    }>
  | Readonly<{
      op: "set_variant";
      componentId: string;
      value: string;
    }>;

type McpDraftApplicationBase = Readonly<{
  executeScoped<Result>(input: {
    principal: McpConnectionPrincipal;
    operation: string;
    auditInput: unknown;
    requiredScopes: ReadonlyArray<string>;
    successfulScopesEvaluated?: () => ReadonlyArray<string>;
    context: McpExecutionContext;
    joinedAudit?: boolean;
    recordJoinedFailure?: (
      audit: McpReadAuditEvent,
      error: McpReadError,
    ) => Promise<McpReadError | void>;
    run(
      context: McpExecutionContext,
      audit: McpReadAuditEvent,
    ): Promise<Result>;
  }): Promise<unknown>;
}>;

export function createMcpContentActorId(
  principal: McpConnectionPrincipal,
) {
  return createContentActorId(`mcp-${principal.actorId}`);
}

async function mutationStorageKey(operation: string, idempotencyKey: string) {
  return `mcp-${await sha256CanonicalJson({ operation, idempotencyKey })}`;
}

function assertSite(revision: ContentRevision, siteId: SiteId) {
  if (revision.definition.site.id !== siteId) {
    throw new McpReadError(
      "OBJECT_NOT_FOUND",
      "The requested object was not found.",
    );
  }
}

function revisionResult(revision: SavedContentRevision | ContentRevision) {
  return {
    workspaceId: revision.workspaceId,
    revision: revision.revision,
    contentHash: revision.inputs.contentHash,
    schemaVersion: revision.inputs.schemaVersion,
    validation: {
      valid: true as const,
      issues: [] as ReadonlyArray<never>,
    },
  };
}

function canonicalRevisionResource(revision: ContentRevision) {
  return {
    ...revisionResult(revision),
    definition: revision.definition,
    rendererVersion: revision.inputs.rendererVersion,
    productionBase: revision.inputs.productionBase,
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
  };
}

function workspaceResource(
  baseRevision: ContentRevision,
  currentRevision: ContentRevision,
) {
  return {
    workspaceId: currentRevision.workspaceId,
    manifest: {
      siteId: currentRevision.definition.site.id,
      schemaVersion: currentRevision.inputs.schemaVersion,
      rendererVersion: currentRevision.inputs.rendererVersion,
      productionBase: currentRevision.inputs.productionBase,
    },
    base: canonicalRevisionResource(baseRevision),
    current: canonicalRevisionResource(currentRevision),
    state: {
      status: "draft" as const,
      baseRevision: baseRevision.revision,
      currentRevision: currentRevision.revision,
      contentHash: currentRevision.inputs.contentHash,
    },
  };
}

export function mcpRevisionScopes(
  base: ContentRevision,
  revision: ContentRevision,
  fallback: typeof mcpContentDraftScope | typeof mcpDesignDraftScope,
) {
  return mcpDefinitionScopes(base.definition, revision.definition, fallback);
}

export function mcpDefinitionScopes(
  base: SiteDefinition,
  revision: SiteDefinition,
  fallback: typeof mcpContentDraftScope | typeof mcpDesignDraftScope,
) {
  const baseFields = new Map(
    listEditableSiteFields(base).map(({ path, value }) => [
      path,
      JSON.stringify(value),
    ]),
  );
  let contentChanged = false;
  let designChanged = false;
  for (const field of listEditableSiteFields(revision)) {
    if (baseFields.get(field.path) === JSON.stringify(field.value)) continue;
    if (field.group === "Design") designChanged = true;
    else contentChanged = true;
  }
  const scopes = [
    ...(contentChanged ? [mcpContentDraftScope] : []),
    ...(designChanged ? [mcpDesignDraftScope] : []),
  ];
  return scopes.length === 0 ? [fallback] : scopes;
}

export function requireMcpRevisionScopes(
  principal: McpConnectionPrincipal,
  requiredScopes: ReadonlyArray<string>,
) {
  if (requiredScopes.some((scope) => !principal.scopes.includes(scope))) {
    throw new McpReadError(
      "INSUFFICIENT_SCOPE",
      "The connection lacks a scope changed by this draft revision.",
      { requiredScopes },
    );
  }
}

function staleRevision(
  workspaceId: ContentWorkspaceId,
  latestRevision: number,
) {
  return new McpReadError(
    "STALE_REVISION",
    "The workspace revision changed.",
    {
      latestRevision,
      conflictResource:
        `foundry://workspaces/${workspaceId}/revisions/${latestRevision}`,
    },
  );
}

export async function createCanonicalPreviewArtifactHash(
  revision: ContentRevision,
) {
  return sha256CanonicalJson({
    revision: revision.revision,
    definition: revision.definition,
    contentHash: revision.inputs.contentHash,
    schemaVersion: revision.inputs.schemaVersion,
    rendererVersion: revision.inputs.rendererVersion,
    productionBase: revision.inputs.productionBase,
  });
}

function contentEdits(
  definition: SiteDefinition,
  operations: ReadonlyArray<McpContentPatchOperation>,
): ReadonlyArray<SiteDefinitionEdit> {
  const contentFields = new Map(
    listEditableSiteFields(definition)
      .filter(({ group }) => group !== "Design")
      .map((field) => [field.path, field]),
  );
  return operations.map(({ field, value, format }) => {
    const contract = contentFields.get(field);
    if (contract === undefined || contract.format !== (format ?? "plainText")) {
      throw new McpReadError(
        "VALIDATION_FAILED",
        "The content field is not editable through MCP.",
      );
    }
    if (contract.format !== "richText") {
      return { path: field, value: value as string };
    }
    try {
      return {
        path: field,
        format: "richText" as const,
        value: serializeRichTextDocument(value as RichTextDocument),
      };
    } catch {
      throw new McpReadError(
        "VALIDATION_FAILED",
        "The rich-text value is invalid.",
      );
    }
  }) as ReadonlyArray<SiteDefinitionEdit>;
}

function designEdits(
  definition: SiteDefinition,
  operations: ReadonlyArray<McpDesignPatchOperation>,
): ReadonlyArray<SiteDefinitionEdit> {
  const designFields = new Map(
    listEditableSiteFields(definition)
      .filter(({ group }) => group === "Design")
      .map((field) => [field.path, field]),
  );
  return operations.map((operation) => {
    const path =
      operation.op === "set_token"
        ? `design.${operation.token}`
        : `${operation.componentId}.variant`;
    const field = designFields.get(path);
    if (
      field === undefined ||
      field.format !== "plainText" ||
      field.values === undefined ||
      !field.values.includes(operation.value)
    ) {
      throw new McpReadError(
        "VALIDATION_FAILED",
        "The design command is outside the registered design contract.",
      );
    }
    return { path, value: operation.value };
  });
}

export function createMcpDraftApplication({
  base,
  runtime,
}: {
  base: McpDraftApplicationBase;
  runtime: McpDraftRuntime;
}) {
  async function load(
    principal: McpConnectionPrincipal,
    workspaceId: ContentWorkspaceId,
  ) {
    return runtime.load({
      principal,
      actorId: createMcpContentActorId(principal),
      workspaceId,
    });
  }

  function recordJoinedFailure(
    principal: McpConnectionPrincipal,
    idempotencyKey: string,
  ) {
    return async (audit: McpReadAuditEvent, error: McpReadError) => {
      const joinedAudit = { ...audit, idempotencyKey };
      const failure = {
        code: error.code,
        message: error.message,
        latestRevision: error.latestRevision,
        conflictResource: error.conflictResource,
      };
      const recorded = await runtime.recordMutationFailure({
        principal,
        audit: joinedAudit,
        resultHash: await sha256CanonicalJson(failure),
        error: failure,
      });
      return new McpReadError(
        recorded.error.code,
        recorded.error.message,
        {
          observedAt: recorded.observedAt,
          latestRevision: recorded.error.latestRevision ?? undefined,
          conflictResource:
            recorded.error.conflictResource ?? undefined,
          replayed: recorded.replayed,
          auditRecorded: true,
        },
      );
    };
  }

  return Object.freeze({
    openWorkspace(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        expectedRevision: 0;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      const draftScope = principal.scopes.includes(mcpDesignDraftScope)
        ? mcpDesignDraftScope
        : mcpContentDraftScope;
      return base.executeScoped({
        principal,
        operation: "foundry.workspace.open",
        auditInput: input,
        requiredScopes: [draftScope],
        context,
        joinedAudit: true,
        recordJoinedFailure: recordJoinedFailure(
          principal,
          input.idempotencyKey,
        ),
        async run(execution, audit) {
          const joinedAudit = {
            ...audit,
            idempotencyKey: input.idempotencyKey,
          };
          const replay = await execution.run(() =>
            runtime.replayMutation({ principal, audit: joinedAudit }),
          );
          if (replay !== null) {
            const replayApplication = await execution.run(() =>
              load(principal, replay.workspaceId),
            );
            const replayRevision = await execution.run(() =>
              replayApplication.queries.getRevisionWithBookmark(
                replay.revision,
              ),
            );
            if (replayRevision === null) {
              throw new McpReadError(
                "TEMPORARILY_UNAVAILABLE",
                "The replayed workspace result is unavailable.",
              );
            }
            assertSite(replayRevision, principal.siteId);
            return {
              ...revisionResult(replayRevision),
              replayed: true,
            };
          }
          const application = await execution.run(() =>
            runtime.open({
              principal,
              actorId: createMcpContentActorId(principal),
              idempotencyKey: input.idempotencyKey,
            }),
          );
          const created = await execution.run(() =>
            application.commands.createWithReplay({
              actorId: createMcpContentActorId(principal),
              workspaceId: application.workspaceId,
              idempotencyKey: input.idempotencyKey,
              joinedAudit,
            }),
          );
          const revision = created.revision;
          assertSite(revision, principal.siteId);
          if (revision.revision !== input.expectedRevision) {
            throw staleRevision(application.workspaceId, revision.revision);
          }
          return { ...revisionResult(revision), replayed: created.replayed };
        },
      });
    },
    getWorkspace(
      principal: McpConnectionPrincipal,
      workspaceId: ContentWorkspaceId,
      context: McpExecutionContext,
    ) {
      const draftScope = principal.scopes.includes(mcpDesignDraftScope)
        ? mcpDesignDraftScope
        : mcpContentDraftScope;
      let successfulScopesEvaluated: ReadonlyArray<string> = [draftScope];
      return base.executeScoped({
        principal,
        operation: "foundry.workspace.get",
        auditInput: { workspaceId },
        requiredScopes: [draftScope],
        successfulScopesEvaluated: () => successfulScopesEvaluated,
        context,
        async run(execution) {
          const application = await execution.run(() =>
            load(principal, workspaceId),
          );
          const currentRevision = await execution.run(() =>
            application.queries.getCurrent(),
          );
          assertSite(currentRevision, principal.siteId);
          const baseRevision = await execution.run(() =>
            application.queries.getRevision(0),
          );
          if (baseRevision === null) {
            throw new McpReadError(
              "TEMPORARILY_UNAVAILABLE",
              "The workspace base is unavailable.",
            );
          }
          assertSite(baseRevision, principal.siteId);
          const requiredScopes = mcpRevisionScopes(
            baseRevision,
            currentRevision,
            draftScope,
          );
          requireMcpRevisionScopes(principal, requiredScopes);
          successfulScopesEvaluated = requiredScopes;
          return workspaceResource(baseRevision, currentRevision);
        },
      });
    },
    getWorkspaceRevision(
      principal: McpConnectionPrincipal,
      workspaceId: ContentWorkspaceId,
      revisionNumber: number,
      context: McpExecutionContext,
    ) {
      const draftScope = principal.scopes.includes(mcpDesignDraftScope)
        ? mcpDesignDraftScope
        : mcpContentDraftScope;
      let successfulScopesEvaluated: ReadonlyArray<string> = [draftScope];
      return base.executeScoped({
        principal,
        operation: "foundry.workspace.revision.get",
        auditInput: { workspaceId, revision: revisionNumber },
        requiredScopes: [draftScope],
        successfulScopesEvaluated: () => successfulScopesEvaluated,
        context,
        async run(execution) {
          const application = await execution.run(() =>
            load(principal, workspaceId),
          );
          const revision = await execution.run(() =>
            application.queries.getRevision(revisionNumber),
          );
          if (revision === null) {
            throw new McpReadError(
              "OBJECT_NOT_FOUND",
              "The requested object was not found.",
            );
          }
          assertSite(revision, principal.siteId);
          const baseRevision = await execution.run(() =>
            application.queries.getRevision(0),
          );
          if (baseRevision === null) {
            throw new McpReadError(
              "TEMPORARILY_UNAVAILABLE",
              "The workspace base is unavailable.",
            );
          }
          assertSite(baseRevision, principal.siteId);
          const requiredScopes = mcpRevisionScopes(
            baseRevision,
            revision,
            draftScope,
          );
          requireMcpRevisionScopes(principal, requiredScopes);
          successfulScopesEvaluated = requiredScopes;
          return canonicalRevisionResource(revision);
        },
      });
    },
    patchContent(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        workspaceId: ContentWorkspaceId;
        expectedRevision: number;
        idempotencyKey: string;
        operations: ReadonlyArray<McpContentPatchOperation>;
      }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.content.patch",
        auditInput: input,
        requiredScopes: [mcpContentDraftScope],
        context,
        joinedAudit: true,
        recordJoinedFailure: recordJoinedFailure(
          principal,
          input.idempotencyKey,
        ),
        async run(execution, audit) {
          const joinedAudit = {
            ...audit,
            idempotencyKey: input.idempotencyKey,
          };
          const replay = await execution.run(() =>
            runtime.replayMutation({ principal, audit: joinedAudit }),
          );
          if (replay !== null) {
            const replayApplication = await execution.run(() =>
              load(principal, replay.workspaceId),
            );
            const replayRevision = await execution.run(() =>
              replayApplication.queries.getRevisionWithBookmark(
                replay.revision,
              ),
            );
            if (replayRevision === null) {
              throw new McpReadError(
                "TEMPORARILY_UNAVAILABLE",
                "The replayed content result is unavailable.",
              );
            }
            assertSite(replayRevision, principal.siteId);
            return {
              ...revisionResult(replayRevision),
              replayed: true,
              previewArtifact: await execution.run(() =>
                createCanonicalPreviewArtifactHash(replayRevision),
              ),
            };
          }
          const application = await execution.run(() =>
            load(principal, input.workspaceId),
          );
          const current = await execution.run(() =>
            application.queries.getCurrent(),
          );
          assertSite(current, principal.siteId);
          const storageKey = await execution.run(() =>
            mutationStorageKey(
              "foundry.content.patch",
              input.idempotencyKey,
            ),
          );
          let mutation;
          try {
            mutation = await execution.run(() =>
              application.commands.saveWithReplay({
                actorId: createMcpContentActorId(principal),
                workspaceId: input.workspaceId,
                schemaVersion: current.definition.schemaVersion,
                baseRevision: input.expectedRevision,
                edits: contentEdits(current.definition, input.operations),
                idempotencyKey: storageKey,
                joinedAudit,
              }),
            );
          } catch (error) {
            if (
              error instanceof ContentRevisionConflictError ||
              error instanceof ContentRevisionStaleError
            ) {
              const latest =
                error instanceof ContentRevisionConflictError
                  ? error.currentRevision
                  : (
                      await execution.run(() =>
                        application.queries.getCurrent()
                      )
                    ).revision;
              throw staleRevision(input.workspaceId, latest);
            }
            throw error;
          }
          const saved = mutation.revision;
          return {
            ...revisionResult(saved),
            replayed: mutation.replayed,
            previewArtifact: await execution.run(() =>
              createCanonicalPreviewArtifactHash(saved),
            ),
          };
        },
      });
    },
    patchDesign(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        workspaceId: ContentWorkspaceId;
        expectedRevision: number;
        idempotencyKey: string;
        operations: ReadonlyArray<McpDesignPatchOperation>;
      }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.design.patch",
        auditInput: input,
        requiredScopes: [mcpDesignDraftScope],
        context,
        joinedAudit: true,
        recordJoinedFailure: recordJoinedFailure(
          principal,
          input.idempotencyKey,
        ),
        async run(execution, audit) {
          const joinedAudit = {
            ...audit,
            idempotencyKey: input.idempotencyKey,
          };
          const replay = await execution.run(() =>
            runtime.replayMutation({ principal, audit: joinedAudit }),
          );
          if (replay !== null) {
            const replayApplication = await execution.run(() =>
              load(principal, replay.workspaceId),
            );
            const replayRevision = await execution.run(() =>
              replayApplication.queries.getRevisionWithBookmark(
                replay.revision,
              ),
            );
            if (replayRevision === null) {
              throw new McpReadError(
                "TEMPORARILY_UNAVAILABLE",
                "The replayed design result is unavailable.",
              );
            }
            assertSite(replayRevision, principal.siteId);
            return {
              ...revisionResult(replayRevision),
              replayed: true,
              previewArtifact: await execution.run(() =>
                createCanonicalPreviewArtifactHash(replayRevision),
              ),
            };
          }
          const application = await execution.run(() =>
            load(principal, input.workspaceId),
          );
          const current = await execution.run(() =>
            application.queries.getCurrent(),
          );
          assertSite(current, principal.siteId);
          const storageKey = await execution.run(() =>
            mutationStorageKey(
              "foundry.design.patch",
              input.idempotencyKey,
            ),
          );
          let mutation;
          try {
            mutation = await execution.run(() =>
              application.commands.saveWithReplay({
                actorId: createMcpContentActorId(principal),
                workspaceId: input.workspaceId,
                schemaVersion: current.definition.schemaVersion,
                baseRevision: input.expectedRevision,
                edits: designEdits(current.definition, input.operations),
                idempotencyKey: storageKey,
                joinedAudit,
              }),
            );
          } catch (error) {
            if (
              error instanceof ContentRevisionConflictError ||
              error instanceof ContentRevisionStaleError
            ) {
              const latest =
                error instanceof ContentRevisionConflictError
                  ? error.currentRevision
                  : (
                      await execution.run(() =>
                        application.queries.getCurrent()
                      )
                    ).revision;
              throw staleRevision(input.workspaceId, latest);
            }
            throw error;
          }
          const saved = mutation.revision;
          return {
            ...revisionResult(saved),
            replayed: mutation.replayed,
            previewArtifact: await execution.run(() =>
              createCanonicalPreviewArtifactHash(saved),
            ),
          };
        },
      });
    },
    preparePreview(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        workspaceId: ContentWorkspaceId;
        expectedRevision: number;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      const draftScope = principal.scopes.includes(mcpDesignDraftScope)
        ? mcpDesignDraftScope
        : mcpContentDraftScope;
      return base.executeScoped({
        principal,
        operation: "foundry.preview.prepare",
        auditInput: input,
        requiredScopes: [draftScope],
        context,
        joinedAudit: true,
        recordJoinedFailure: recordJoinedFailure(
          principal,
          input.idempotencyKey,
        ),
        async run(execution, audit) {
          const joinedAudit = {
            ...audit,
            idempotencyKey: input.idempotencyKey,
          };
          const application = await execution.run(() =>
            load(principal, input.workspaceId),
          );
          const revision = await execution.run(() =>
            application.queries.getRevisionWithBookmark(
              input.expectedRevision,
            ),
          );
          if (revision === null) {
            await execution.run(() =>
              runtime.replayMutation({ principal, audit: joinedAudit }),
            );
            const current = await execution.run(() =>
              application.queries.getCurrent(),
            );
            throw staleRevision(input.workspaceId, current.revision);
          }
          assertSite(revision, principal.siteId);
          const baseRevision = await execution.run(() =>
            application.queries.getRevision(0),
          );
          if (baseRevision === null) {
            throw new McpReadError(
              "TEMPORARILY_UNAVAILABLE",
              "The preview base is unavailable.",
            );
          }
          const requiredScopes = mcpRevisionScopes(
            baseRevision,
            revision,
            draftScope,
          );
          requireMcpRevisionScopes(principal, requiredScopes);
          const previewAudit = {
            ...joinedAudit,
            scopesEvaluated: requiredScopes,
          };
          const mutationReplay = await execution.run(() =>
            runtime.replayMutation({ principal, audit: previewAudit }),
          );
          if (mutationReplay !== null) {
            if (
              mutationReplay.previewId === null ||
              mutationReplay.workspaceId !== input.workspaceId ||
              mutationReplay.revision !== input.expectedRevision
            ) {
              throw new McpReadError(
                "TEMPORARILY_UNAVAILABLE",
                "The replayed preview result is unavailable.",
              );
            }
            return {
              previewId: mutationReplay.previewId,
              ...revisionResult(revision),
              previewArtifact: mutationReplay.resultHash,
              approvalStatus: "pending_human_review" as const,
              replayed: true,
              humanReviewUrl: runtime.humanReviewUrl(
                mutationReplay.previewId,
              ),
            };
          }
          const current = await execution.run(() =>
            application.queries.getCurrent(),
          );
          const artifact = await execution.run(() =>
            createCanonicalPreviewArtifactHash(revision),
          );
          const requestHash = await execution.run(() =>
            sha256CanonicalJson({
              workspaceId: input.workspaceId,
              expectedRevision: input.expectedRevision,
              artifact,
            }),
          );
          const replay = await execution.run(() =>
            runtime.replayPreview({
              principal,
              workspaceId: input.workspaceId,
              revision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
              requestHash,
              artifactHash: artifact,
              contentHash: revision.inputs.contentHash,
              audit: previewAudit,
            }),
          );
          if (replay !== null) {
            return {
              previewId: replay.previewId,
              ...revisionResult(revision),
              previewArtifact: artifact,
              approvalStatus: "pending_human_review" as const,
              replayed: true,
              humanReviewUrl: runtime.humanReviewUrl(replay.previewId),
            };
          }
          const revisionCurrent = await execution.run(() =>
            application.queries.isRevisionCurrent(revision),
          );
          if (!revisionCurrent) {
            throw new McpReadError(
              "VALIDATION_FAILED",
              "The preview revision no longer matches the current deployment.",
              { requiredScopes },
            );
          }
          if (current.revision !== input.expectedRevision) {
            throw staleRevision(input.workspaceId, current.revision);
          }
          const prepared = await execution.run(() =>
            runtime.preparePreview({
              principal,
              workspaceId: input.workspaceId,
              revision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
              requestHash,
              artifactHash: artifact,
              contentHash: revision.inputs.contentHash,
              audit: previewAudit,
            }),
          );
          return {
            previewId: prepared.previewId,
            ...revisionResult(revision),
            previewArtifact: artifact,
            approvalStatus: "pending_human_review" as const,
            replayed: prepared.replayed,
            humanReviewUrl: runtime.humanReviewUrl(prepared.previewId),
          };
        },
      });
    },
  });
}

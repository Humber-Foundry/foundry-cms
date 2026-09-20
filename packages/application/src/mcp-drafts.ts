import {
  designContract,
  listEditableSiteFields,
  serializeRichTextDocument,
  type RichTextDocument,
  type SiteDefinition,
  type SiteDefinitionEdit,
  type SiteId,
} from "@humber-foundry/site-definition";

import {
  ContentPageOperationError,
  ContentRevisionConflictError,
  ContentRevisionStaleError,
  ContentRevisionValidationError,
  createContentActorId,
  mintedContentPageId,
  type ContentRevision,
  type ContentRevisionApplication,
  type ContentWorkspaceId,
  type PageMutationCommand,
  type PageMutationResult,
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

/**
 * What a refused MCP draft mutation records and replays.
 *
 * `reason` is the named cause the agent branches on, such as `page_is_home`.
 * It is stored with the code and the message so that replaying the same
 * request reports the same refusal, word for word and reason for reason.
 */
export type McpMutationFailure = Readonly<{
  code: McpReadError["code"];
  message: string;
  reason: string | null;
  latestRevision: number | null;
  conflictResource: string | null;
}>;

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
    error: McpMutationFailure;
  }): Promise<
    Readonly<{
      error: McpMutationFailure;
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

/**
 * Which draft scopes a revision's own changes need.
 *
 * A field both sides hold is read by its group: a Design field means the
 * design changed, anything else means the content changed.
 *
 * A field only one side holds belongs to a record this draft added or removed,
 * such as a page. That is a content change whatever group the field is in. A
 * page an agent adds brings the design fields its sections start with, and
 * those are defaults the starting point placed rather than a design the agent
 * chose; no design that was already on the site changed. Changing one of them
 * afterwards still needs `foundry.design.patch`, which asks for the design
 * draft scope itself. See ADR-0034.
 */
function mcpDefinitionScopes(
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
  const revisionPaths = new Set<string>();
  for (const field of listEditableSiteFields(revision)) {
    revisionPaths.add(field.path);
    const before = baseFields.get(field.path);
    if (before === JSON.stringify(field.value)) continue;
    if (before !== undefined && field.group === "Design") designChanged = true;
    else contentChanged = true;
  }
  for (const path of baseFields.keys()) {
    if (!revisionPaths.has(path)) contentChanged = true;
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

/**
 * What every MCP page tool takes: the draft, the revision the agent read
 * before it decided, and the key that makes a retry safe. It is the same
 * front as `foundry.content.patch`, because a page operation is the same kind
 * of draft write.
 */
export type McpPageMutationInput = Readonly<{
  workspaceId: ContentWorkspaceId;
  expectedRevision: number;
  idempotencyKey: string;
}>;

export type McpCreatePageInput = McpPageMutationInput &
  Readonly<{ title: string; slug: string; startingLayout: string }>;

export type McpRenamePageInput = McpPageMutationInput &
  Readonly<{ pageId: string; title: string; slug: string }>;

export type McpDuplicatePageInput = McpPageMutationInput &
  Readonly<{ pageId: string; title: string; slug: string }>;

export type McpDeletePageInput = McpPageMutationInput &
  Readonly<{ pageId: string }>;

/**
 * The named reason for a page refusal the draft raised without a page
 * lifecycle code of its own. A rename is two ordinary field edits, so the
 * field's own check refuses it and reports one sentence per field. The agent
 * reads those sentences in the message and this word in `reason`.
 */
const pageFieldsRefusedReason = "page_fields_refused";

/**
 * The named reason for a content edit the draft has no field for, and for one
 * sent in the wrong format. An agent branches on these instead of reading the
 * sentence.
 */
const contentFieldNotEditableReason = "content_field_not_editable";
const contentFieldFormatReason = "content_field_format_mismatch";
const designFieldNotContentReason = "design_field_not_content";

/**
 * Turn a refused page operation into the tool error an agent acts on.
 *
 * The sentences come from the draft itself, which is the one place the page
 * rules are written (ADR-0033), so an agent and a site owner read the same
 * words. `reason` carries the stable code a program branches on.
 */
function pageRefusal(error: ContentRevisionValidationError): McpReadError {
  const sentences = Object.values(error.fields).join(" ");
  return new McpReadError(
    "VALIDATION_FAILED",
    sentences === "" ? "The page operation was refused." : sentences,
    {
      reason:
        error instanceof ContentPageOperationError
          ? error.code
          : pageFieldsRefusedReason,
    },
  );
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
  // Every field the draft holds, so a refusal can tell a path that is not
  // there from a path that is there but is a design setting.
  const draftFields = new Map(
    listEditableSiteFields(definition).map((field) => [field.path, field]),
  );
  return operations.map(({ field, value, format }) => {
    const contract = draftFields.get(field);
    if (contract === undefined) {
      // The draft's own field list is the answer, and the tool no longer
      // advertises one, so the refusal names the path it turned down.
      throw new McpReadError(
        "VALIDATION_FAILED",
        `This draft has no field at ${field}.`,
        { reason: contentFieldNotEditableReason },
      );
    }
    if (contract.group === "Design") {
      throw new McpReadError(
        "VALIDATION_FAILED",
        `The field ${field} is a design setting. Change it with foundry.design.patch.`,
        { reason: designFieldNotContentReason },
      );
    }
    if (contract.format !== (format ?? "plainText")) {
      throw new McpReadError(
        "VALIDATION_FAILED",
        format === "richText"
          ? `The field ${field} holds plain text, not rich text.`
          : `The field ${field} holds rich text. Send it with format "richText".`,
        { reason: contentFieldFormatReason },
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
      const failure: McpMutationFailure = {
        code: error.code,
        message: error.message,
        reason: error.reason,
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
          reason: recorded.error.reason ?? undefined,
          latestRevision: recorded.error.latestRevision ?? undefined,
          conflictResource:
            recorded.error.conflictResource ?? undefined,
          replayed: recorded.replayed,
          auditRecorded: true,
        },
      );
    };
  }

  /**
   * Run one page operation as an MCP tool call.
   *
   * Every page tool goes through here, so all four get the same draft scope,
   * the same replay handling, the same base-revision check and the same
   * refusal shape. The work itself is `run`, which calls the matching
   * application command; this adds nothing to what the dashboard does.
   *
   * `replayedPageId` names the page a stored receipt was for. A receipt
   * records the revision, not the page, so a create and a duplicate rebuild
   * the id they minted while a rename and a delete already know it.
   */
  function pageMutation<Input extends McpPageMutationInput>({
    principal,
    operation,
    input,
    context,
    run,
    replayedPageId,
  }: {
    principal: McpConnectionPrincipal;
    operation: string;
    input: Input;
    context: McpExecutionContext;
    run(
      application: ContentRevisionApplication,
      command: PageMutationCommand,
    ): Promise<PageMutationResult>;
    replayedPageId(
      workspaceId: ContentWorkspaceId,
      storageKey: string,
    ): Promise<string>;
  }) {
    return base.executeScoped({
      principal,
      operation,
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
        const storageKey = await execution.run(() =>
          mutationStorageKey(operation, input.idempotencyKey),
        );
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
              "The replayed page result is unavailable.",
            );
          }
          assertSite(replayRevision, principal.siteId);
          return {
            ...revisionResult(replayRevision),
            pageId: await execution.run(() =>
              replayedPageId(replay.workspaceId, storageKey),
            ),
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
        let mutation: PageMutationResult;
        try {
          mutation = await execution.run(() =>
            run(application, {
              actorId: createMcpContentActorId(principal),
              workspaceId: input.workspaceId,
              schemaVersion: current.definition.schemaVersion,
              baseRevision: input.expectedRevision,
              idempotencyKey: storageKey,
              joinedAudit,
            }),
          );
        } catch (error) {
          if (error instanceof ContentRevisionValidationError) {
            throw pageRefusal(error);
          }
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
          pageId: mutation.pageId,
          replayed: mutation.replayed,
          previewArtifact: await execution.run(() =>
            createCanonicalPreviewArtifactHash(saved),
          ),
        };
      },
    });
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
    createPage(
      principal: McpConnectionPrincipal,
      input: McpCreatePageInput,
      context: McpExecutionContext,
    ) {
      return pageMutation({
        principal,
        operation: "foundry.page.create",
        input,
        context,
        run: (application, command) =>
          application.commands.createPage({
            ...command,
            title: input.title,
            slug: input.slug,
            startingLayout: input.startingLayout,
          }),
        replayedPageId: (workspaceId, idempotencyKey) =>
          mintedContentPageId({ workspaceId, idempotencyKey }),
      });
    },
    renamePage(
      principal: McpConnectionPrincipal,
      input: McpRenamePageInput,
      context: McpExecutionContext,
    ) {
      return pageMutation({
        principal,
        operation: "foundry.page.rename",
        input,
        context,
        run: (application, command) =>
          application.commands.renamePage({
            ...command,
            pageId: input.pageId,
            title: input.title,
            slug: input.slug,
          }),
        replayedPageId: async () => input.pageId,
      });
    },
    duplicatePage(
      principal: McpConnectionPrincipal,
      input: McpDuplicatePageInput,
      context: McpExecutionContext,
    ) {
      return pageMutation({
        principal,
        operation: "foundry.page.duplicate",
        input,
        context,
        run: (application, command) =>
          application.commands.duplicatePage({
            ...command,
            pageId: input.pageId,
            title: input.title,
            slug: input.slug,
          }),
        replayedPageId: (workspaceId, idempotencyKey) =>
          mintedContentPageId({ workspaceId, idempotencyKey }),
      });
    },
    deletePage(
      principal: McpConnectionPrincipal,
      input: McpDeletePageInput,
      context: McpExecutionContext,
    ) {
      return pageMutation({
        principal,
        operation: "foundry.page.delete",
        input,
        context,
        run: (application, command) =>
          application.commands.deletePage({
            ...command,
            pageId: input.pageId,
          }),
        replayedPageId: async () => input.pageId,
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

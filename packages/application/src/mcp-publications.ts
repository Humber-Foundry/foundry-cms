import type { SiteId } from "@foundry/site-definition";

import {
  BlogPostOperationError,
  createBlogPostOperationsApplication,
  resolvePostPublicationInstant,
} from "./blog-post-operations";
import {
  ContentApprovalInvalidError,
  ContentPublicationIdempotencyError,
  ContentPublicationValidationError,
  createContentApprovalId,
  createContentPublicationApplication,
  createContentPublicationId,
} from "./content-publication";
import {
  createContentWorkspaceId,
  type ContentRevision,
  type ContentRevisionApplication,
  type ContentWorkspaceId,
} from "./content-revisions";
import { sha256CanonicalJson } from "./deterministic-hash";
import {
  createMcpContentActorId,
  mcpRevisionScopes,
  requireMcpRevisionScopes,
} from "./mcp-drafts";
import {
  McpReadError,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  mcpPublicationPublishScope,
  mcpPublicationScheduleScope,
  type McpConnectionGrant,
  type McpConnectionPrincipal,
  type McpExecutionContext,
  type McpReadAuditEvent,
} from "./mcp-read";

type ContentPublicationApplication = ReturnType<
  typeof createContentPublicationApplication
>;
type BlogPostOperationsApplication = ReturnType<
  typeof createBlogPostOperationsApplication
>;

type McpPublicationApplicationBase = Readonly<{
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
  loadConnection(
    principal: McpConnectionPrincipal,
    context: McpExecutionContext,
  ): Promise<McpConnectionGrant | null>;
}>;

export type McpPublicationAuditEvent = McpReadAuditEvent &
  Readonly<{
    idempotencyKey: string | null;
    workspaceId: ContentWorkspaceId;
    revision: number;
    approvalId: string | null;
    publicationId: string | null;
    scheduleId: string | null;
    resultHash: string;
    replayed: boolean;
  }>;

export type McpPublicationRuntime = Readonly<{
  loadRevision(input: {
    principal: McpConnectionPrincipal;
    workspaceId: ContentWorkspaceId;
  }): Promise<ContentRevisionApplication>;
  loadPublication(input: {
    principal: McpConnectionPrincipal;
    workspaceId: ContentWorkspaceId;
  }): Promise<ContentPublicationApplication>;
  loadBlogOperations(
    principal: McpConnectionPrincipal,
  ): Promise<BlogPostOperationsApplication>;
  recordInvocation(event: McpPublicationAuditEvent): Promise<void>;
}>;

type ExactRevision = Readonly<{
  application: ContentRevisionApplication;
  base: ContentRevision;
  revision: ContentRevision;
  requiredDraftScopes: ReadonlyArray<string>;
}>;

function draftFallback(principal: McpConnectionPrincipal) {
  return principal.scopes.includes(mcpDesignDraftScope)
    ? mcpDesignDraftScope
    : mcpContentDraftScope;
}

async function storageKey(
  operation: string,
  principal: McpConnectionPrincipal,
  idempotencyKey: string,
) {
  return `mcp-${await sha256CanonicalJson({
    actorId: principal.actorId,
    idempotencyKey,
    operation,
    siteId: principal.siteId,
  })}`;
}

function authenticCurrentGrant(
  current: McpConnectionGrant | null,
  principal: McpConnectionPrincipal,
  requiredScopes: ReadonlyArray<string>,
) {
  return (
    current !== null &&
    current.status === "active" &&
    current.connectionId === principal.connectionId &&
    current.actorId === principal.actorId &&
    current.clientId === principal.clientId &&
    current.siteId === principal.siteId &&
    requiredScopes.every(
      (scope) =>
        current.scopes.includes(scope) &&
        principal.scopes.includes(scope),
    )
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

function publicationError(error: unknown): McpReadError {
  if (error instanceof McpReadError) return error;
  if (error instanceof ContentApprovalInvalidError) {
    return new McpReadError(
      error.code === "approval_not_found"
        ? "APPROVAL_REQUIRED"
        : "APPROVAL_STALE",
      error.code === "approval_not_found"
        ? "An exact current human approval is required."
        : "The human approval is no longer current.",
    );
  }
  if (error instanceof ContentPublicationIdempotencyError) {
    return new McpReadError(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for different input.",
    );
  }
  if (error instanceof ContentPublicationValidationError) {
    if (error.code === "publication_authority_not_current") {
      return new McpReadError(
        "INSUFFICIENT_SCOPE",
        "The connection no longer grants publication publishing.",
        { requiredScopes: [mcpPublicationPublishScope] },
      );
    }
    return new McpReadError(
      error.code.includes("in_progress")
        ? "PUBLICATION_BUSY"
        : "VALIDATION_FAILED",
      "The publication command is not valid in the current state.",
    );
  }
  if (error instanceof BlogPostOperationError) {
    if (
      error.code === "approval_stale" ||
      error.code === "approval_required"
    ) {
      return new McpReadError(
        "APPROVAL_STALE",
        "The human approval is no longer current.",
      );
    }
    if (
      error.code === "mcp_schedule_authority_required" ||
      error.code === "human_authority_required"
    ) {
      return new McpReadError(
        "INSUFFICIENT_SCOPE",
        "The connection no longer grants publication scheduling.",
        { requiredScopes: [mcpPublicationScheduleScope] },
      );
    }
    if (error.code === "idempotency_key_conflict") {
      return new McpReadError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used for different input.",
      );
    }
    return new McpReadError(
      "VALIDATION_FAILED",
      "The publication schedule command is not valid.",
    );
  }
  return new McpReadError(
    "TEMPORARILY_UNAVAILABLE",
    "The request could not be completed safely.",
  );
}

function publicationResult(
  operationId: string,
  state: string,
  replayed: boolean,
) {
  return {
    operationId,
    state,
    statusResource: `foundry://publications/${operationId}`,
    replayed,
  };
}

export function createMcpPublicationApplication({
  base,
  runtime,
  now = () => new Date().toISOString(),
}: {
  base: McpPublicationApplicationBase;
  runtime: McpPublicationRuntime;
  now?: () => string;
}) {
  async function exactRevision(
    principal: McpConnectionPrincipal,
    workspaceId: ContentWorkspaceId,
    revisionNumber: number,
    context: McpExecutionContext,
  ): Promise<ExactRevision> {
    const application = await context.run(() =>
      runtime.loadRevision({ principal, workspaceId }),
    );
    const [revision, current, baseRevision] = await Promise.all([
      context.run(() => application.queries.getRevision(revisionNumber)),
      context.run(() => application.queries.getCurrent()),
      context.run(() => application.queries.getRevision(0)),
    ]);
    if (
      revision === null ||
      baseRevision === null ||
      current.revision !== revisionNumber ||
      current.inputs.contentHash !== revision.inputs.contentHash
    ) {
      throw staleRevision(workspaceId, current.revision);
    }
    if (
      revision.definition.site.id !== principal.siteId ||
      baseRevision.definition.site.id !== principal.siteId
    ) {
      throw new McpReadError(
        "OBJECT_NOT_FOUND",
        "The requested object was not found.",
      );
    }
    const requiredDraftScopes = mcpRevisionScopes(
      baseRevision,
      revision,
      draftFallback(principal),
    );
    requireMcpRevisionScopes(principal, requiredDraftScopes);
    return {
      application,
      base: baseRevision,
      revision,
      requiredDraftScopes,
    };
  }

  async function authorizedRevision(
    principal: McpConnectionPrincipal,
    workspaceId: ContentWorkspaceId,
    revisionNumber: number,
    context: McpExecutionContext,
  ): Promise<ExactRevision> {
    const application = await context.run(() =>
      runtime.loadRevision({ principal, workspaceId }),
    );
    const [revision, baseRevision] = await Promise.all([
      context.run(() => application.queries.getRevision(revisionNumber)),
      context.run(() => application.queries.getRevision(0)),
    ]);
    if (
      revision === null ||
      baseRevision === null ||
      revision.definition.site.id !== principal.siteId ||
      baseRevision.definition.site.id !== principal.siteId
    ) {
      throw new McpReadError(
        "OBJECT_NOT_FOUND",
        "The requested object was not found.",
      );
    }
    const requiredDraftScopes = mcpRevisionScopes(
      baseRevision,
      revision,
      draftFallback(principal),
    );
    requireMcpRevisionScopes(principal, requiredDraftScopes);
    return {
      application,
      base: baseRevision,
      revision,
      requiredDraftScopes,
    };
  }

  async function requireCurrentGrant(
    principal: McpConnectionPrincipal,
    requiredScopes: ReadonlyArray<string>,
    context: McpExecutionContext,
  ) {
    const current = await base.loadConnection(principal, context);
    if (!authenticCurrentGrant(current, principal, requiredScopes)) {
      throw new McpReadError(
        "INSUFFICIENT_SCOPE",
        "The connection no longer grants the required permissions.",
        { requiredScopes },
      );
    }
  }

  async function revisionForSite(
    principal: McpConnectionPrincipal,
    workspaceId: ContentWorkspaceId,
    revisionNumber: number,
    context: McpExecutionContext,
  ) {
    const application = await context.run(() =>
      runtime.loadRevision({ principal, workspaceId }),
    );
    const [revision, baseRevision] = await Promise.all([
      context.run(() => application.queries.getRevision(revisionNumber)),
      context.run(() => application.queries.getRevision(0)),
    ]);
    if (
      revision === null ||
      baseRevision === null ||
      revision.definition.site.id !== principal.siteId ||
      baseRevision.definition.site.id !== principal.siteId
    ) {
      throw new McpReadError(
        "OBJECT_NOT_FOUND",
        "The requested object was not found.",
      );
    }
    return revision;
  }

  function assertCurrentAuthority(
    principal: McpConnectionPrincipal,
    requiredScopes: ReadonlyArray<string>,
    context: McpExecutionContext,
  ) {
    return async () => {
      try {
        const current = await base.loadConnection(principal, context);
        return authenticCurrentGrant(
          current,
          principal,
          requiredScopes,
        );
      } catch {
        return false;
      }
    };
  }

  async function record(
    execution: McpExecutionContext,
    audit: McpReadAuditEvent,
    link: Omit<McpPublicationAuditEvent, keyof McpReadAuditEvent>,
  ) {
    await execution.finishDurably(() =>
      runtime.recordInvocation({ ...audit, ...link }),
    );
  }

  function recordJoinedFailure(input: {
    idempotencyKey: string;
    workspaceId: ContentWorkspaceId;
    revision: number;
    approvalId: string | null;
    publicationId?: string | null;
    scheduleId?: string | null;
  }) {
    return async (audit: McpReadAuditEvent, error: McpReadError) => {
      await runtime.recordInvocation({
        ...audit,
        outcome: "denied",
        reason: error.code,
        idempotencyKey: input.idempotencyKey,
        workspaceId: input.workspaceId,
        revision: input.revision,
        approvalId: input.approvalId,
        publicationId: input.publicationId ?? null,
        scheduleId: input.scheduleId ?? null,
        resultHash: await sha256CanonicalJson({
          code: error.code,
          latestRevision: error.latestRevision,
        }),
        replayed: error.replayed,
      });
    };
  }

  return Object.freeze({
    requestPublication(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        workspaceId: ContentWorkspaceId;
        revision: number;
        approvalId: string;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      let scopesEvaluated: ReadonlyArray<string> = [
        mcpPublicationPublishScope,
      ];
      return base.executeScoped({
        principal,
        operation: "foundry.publication.request",
        auditInput: input,
        requiredScopes: [mcpPublicationPublishScope],
        successfulScopesEvaluated: () => scopesEvaluated,
        context,
        joinedAudit: true,
        recordJoinedFailure: recordJoinedFailure({
          idempotencyKey: input.idempotencyKey,
          workspaceId: input.workspaceId,
          revision: input.revision,
          approvalId: input.approvalId,
        }),
        async run(execution, audit) {
          try {
            const workspaceId = createContentWorkspaceId(
              input.workspaceId,
            );
            const approvalId = createContentApprovalId(input.approvalId);
            const application = await execution.run(() =>
              runtime.loadPublication({ principal, workspaceId }),
            );
            const durableKey = await execution.run(() =>
              storageKey(
                "foundry.publication.request",
                principal,
                input.idempotencyKey,
              ),
            );
            const prior = await execution.run(() =>
              application.queries.findByIdempotency(
                workspaceId,
                durableKey,
              ),
            );
            const scoped = prior === null
              ? await exactRevision(
                  principal,
                  workspaceId,
                  input.revision,
                  execution,
                )
              : await authorizedRevision(
                  principal,
                  workspaceId,
                  input.revision,
                  execution,
                );
            scopesEvaluated = [
              mcpPublicationPublishScope,
              ...scoped.requiredDraftScopes,
            ];
            await requireCurrentGrant(
              principal,
              scopesEvaluated,
              execution,
            );
            if (
              prior !== null &&
              (
                prior.revision !== input.revision ||
                prior.approvalId !== approvalId
              )
            ) {
              throw new McpReadError(
                "IDEMPOTENCY_KEY_REUSED",
                "The idempotency key was already used for different input.",
              );
            }
            const publication = await execution.run(async () =>
              prior ?? application.commands.publish({
                  workspaceId,
                  revision: input.revision,
                  approvalId,
                  requestedBy: createMcpContentActorId(principal),
                  idempotencyKey: durableKey,
                  assertCurrentAuthority: assertCurrentAuthority(
                    principal,
                    scopesEvaluated,
                    execution,
                  ),
                  authority: {
                    kind: "mcp",
                    connectionId: principal.connectionId,
                    actorId: principal.actorId,
                    operation: "foundry.publication.request",
                    requiredScopes: scopesEvaluated,
                    audit: {
                      ...audit,
                      scopesEvaluated,
                      idempotencyKey: input.idempotencyKey,
                      workspaceId,
                      revision: input.revision,
                      approvalId,
                      resultHash: await sha256CanonicalJson({
                        command: "foundry.publication.request",
                        workspaceId,
                        revision: input.revision,
                        approvalId,
                        idempotencyKey: input.idempotencyKey,
                      }),
                    },
                  },
                }),
            );
            const replayed = prior !== null;
            const result = publicationResult(
              publication.id,
              publication.status,
              replayed,
            );
            await record(execution, {
              ...audit,
              scopesEvaluated,
            }, {
              idempotencyKey: input.idempotencyKey,
              workspaceId,
              revision: input.revision,
              approvalId,
              publicationId: publication.id,
              scheduleId: null,
              resultHash: await sha256CanonicalJson(result),
              replayed,
            });
            return result;
          } catch (error) {
            throw publicationError(error);
          }
        },
      });
    },

    schedulePublication(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        workspaceId: ContentWorkspaceId;
        revision: number;
        approvalId: string;
        publishAt: string;
        reportingTimeZone: string;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      let scopesEvaluated: ReadonlyArray<string> = [
        mcpPublicationScheduleScope,
      ];
      return base.executeScoped({
        principal,
        operation: "foundry.publication.schedule",
        auditInput: input,
        requiredScopes: [mcpPublicationScheduleScope],
        successfulScopesEvaluated: () => scopesEvaluated,
        context,
        joinedAudit: true,
        recordJoinedFailure: recordJoinedFailure({
          idempotencyKey: input.idempotencyKey,
          workspaceId: input.workspaceId,
          revision: input.revision,
          approvalId: input.approvalId,
        }),
        async run(execution, audit) {
          try {
            const workspaceId = createContentWorkspaceId(
              input.workspaceId,
            );
            const approvalId = createContentApprovalId(input.approvalId);
            const application = await execution.run(() =>
              runtime.loadBlogOperations(principal),
            );
            const durableKey = await execution.run(() =>
              storageKey(
                "foundry.publication.schedule",
                principal,
                input.idempotencyKey,
              ),
            );
            const prior = await execution.run(() =>
              application.queries.findScheduleByWorkspaceRequest({
                siteId: principal.siteId,
                workspaceId,
                idempotencyKey: durableKey,
              }),
            );
            const exact = prior === null
              ? await exactRevision(
                  principal,
                  workspaceId,
                  input.revision,
                  execution,
                )
              : await authorizedRevision(
                  principal,
                  workspaceId,
                  input.revision,
                  execution,
                );
            scopesEvaluated = [
              mcpPublicationScheduleScope,
              ...exact.requiredDraftScopes,
            ];
            await requireCurrentGrant(
              principal,
              scopesEvaluated,
              execution,
            );
            const resolvedTime = resolvePostPublicationInstant(
              input.publishAt,
              input.reportingTimeZone,
            );
            if (prior !== null) {
              if (
                prior.contentRevision !== input.revision ||
                prior.approvalId !== approvalId ||
                prior.executeAtUtc !== resolvedTime.executeAtUtc ||
                prior.ianaTimeZone !== resolvedTime.ianaTimeZone
              ) {
                throw new McpReadError(
                  "IDEMPOTENCY_KEY_REUSED",
                  "The idempotency key was already used for different input.",
                );
              }
              const result = publicationResult(
                prior.id,
                prior.state,
                true,
              );
              await record(execution, {
                ...audit,
                scopesEvaluated,
              }, {
                idempotencyKey: input.idempotencyKey,
                workspaceId,
                revision: input.revision,
                approvalId,
                publicationId: null,
                scheduleId: prior.id,
                resultHash: await sha256CanonicalJson(result),
                replayed: true,
              });
              return result;
            }
            const executeAt = new Date(input.publishAt);
            const current = new Date(now());
            if (
              !Number.isFinite(executeAt.getTime()) ||
              executeAt.getTime() <= current.getTime() ||
              executeAt.getTime() >
                current.getTime() + 366 * 24 * 60 * 60 * 1_000
            ) {
              throw new McpReadError(
                "VALIDATION_FAILED",
                "The publication instant is outside the accepted range.",
              );
            }
            const approval = await execution.run(() =>
              application.queries.getApproval(approvalId),
            );
            if (approval === null) {
              throw new McpReadError(
                "APPROVAL_REQUIRED",
                "An exact current human approval is required.",
              );
            }
            if (
              approval.invalidatedAt !== null ||
              approval.workspaceId !== workspaceId ||
              approval.contentRevision !== input.revision ||
              approval.siteId !== principal.siteId
            ) {
              throw new McpReadError(
                "APPROVAL_STALE",
                "The human approval is no longer current.",
              );
            }
            const post = await execution.run(() =>
              application.queries.findSchedulablePostForApproval({
                siteId: principal.siteId,
                workspaceId,
                contentRevision: input.revision,
                approvalId,
              }),
            );
            if (post === null) {
              throw new McpReadError(
                "WRONG_ARTIFACT_KIND",
                "The exact revision is not one schedulable blog artifact.",
              );
            }
            const schedule = await execution.run(async () =>
              application.commands.activateSchedule({
                actorId: createMcpContentActorId(principal),
                siteId: principal.siteId,
                postId: post.postId,
                approvalId,
                resolvedTime,
                idempotencyKey: durableKey,
                authority: {
                  kind: "mcp",
                  connectionId: principal.connectionId,
                  actorId: principal.actorId,
                  operation: "foundry.publication.schedule",
                  requiredScopes: scopesEvaluated,
                  audit: {
                    ...audit,
                    scopesEvaluated,
                    idempotencyKey: input.idempotencyKey,
                    workspaceId,
                    revision: input.revision,
                    approvalId,
                    resultHash: await sha256CanonicalJson({
                      command: "foundry.publication.schedule",
                      workspaceId,
                      revision: input.revision,
                      approvalId,
                      idempotencyKey: input.idempotencyKey,
                    }),
                  },
                },
              }),
            );
            const replayed = false;
            const result = publicationResult(
              schedule.id,
              schedule.state,
              replayed,
            );
            await record(execution, {
              ...audit,
              scopesEvaluated,
            }, {
              idempotencyKey: input.idempotencyKey,
              workspaceId,
              revision: input.revision,
              approvalId,
              publicationId: null,
              scheduleId: schedule.id,
              resultHash: await sha256CanonicalJson(result),
              replayed,
            });
            return result;
          } catch (error) {
            throw publicationError(error);
          }
        },
      });
    },

    async publicationStatus(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        workspaceId: ContentWorkspaceId;
        revision: number;
        operationId: string;
      }>,
      context: McpExecutionContext,
    ) {
      const requiredScope = principal.scopes.includes(
        mcpPublicationPublishScope,
      )
        ? mcpPublicationPublishScope
        : mcpPublicationScheduleScope;
      return base.executeScoped({
        principal,
        operation: "foundry.publication.status",
        auditInput: input,
        requiredScopes: [requiredScope],
        context,
        async run(execution) {
          const workspaceId = createContentWorkspaceId(
            input.workspaceId,
          );
          await revisionForSite(
            principal,
            workspaceId,
            input.revision,
            execution,
          );
          if (input.operationId.startsWith("publish_")) {
            const application = await execution.run(() =>
              runtime.loadPublication({ principal, workspaceId }),
            );
            const publication = await execution.run(() =>
              application.queries.get(
                createContentPublicationId(input.operationId),
              ),
            );
            if (
              publication === null ||
              publication.workspaceId !== workspaceId ||
              publication.revision !== input.revision
            ) {
              throw new McpReadError(
                "OBJECT_NOT_FOUND",
                "The requested object was not found.",
              );
            }
            return publicationResult(
              publication.id,
              publication.status,
              false,
            );
          }
          const application = await execution.run(() =>
            runtime.loadBlogOperations(principal),
          );
          const schedule = await execution.run(() =>
            application.queries.getSchedule(
              principal.siteId,
              input.operationId,
            ),
          );
          if (
            schedule === null ||
            schedule.workspaceId !== workspaceId ||
            schedule.contentRevision !== input.revision
          ) {
            throw new McpReadError(
              "OBJECT_NOT_FOUND",
              "The requested object was not found.",
            );
          }
          return publicationResult(
            schedule.id,
            schedule.state,
            false,
          );
        },
      });
    },

    cancelPublicationSchedule(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        workspaceId: ContentWorkspaceId;
        revision: number;
        scheduleId: string;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      let scopesEvaluated: ReadonlyArray<string> = [
        mcpPublicationScheduleScope,
      ];
      return base.executeScoped({
        principal,
        operation: "foundry.publication.cancel",
        auditInput: input,
        requiredScopes: [mcpPublicationScheduleScope],
        successfulScopesEvaluated: () => scopesEvaluated,
        context,
        joinedAudit: true,
        recordJoinedFailure: recordJoinedFailure({
          idempotencyKey: input.idempotencyKey,
          workspaceId: input.workspaceId,
          revision: input.revision,
          approvalId: null,
          scheduleId: input.scheduleId,
        }),
        async run(execution, audit) {
          try {
            const workspaceId = createContentWorkspaceId(
              input.workspaceId,
            );
            await revisionForSite(
              principal,
              workspaceId,
              input.revision,
              execution,
            );
            const application = await execution.run(() =>
              runtime.loadBlogOperations(principal),
            );
            const schedule = await execution.run(() =>
              application.queries.getSchedule(
                principal.siteId,
                input.scheduleId,
              ),
            );
            if (
              schedule === null ||
              schedule.workspaceId !== workspaceId ||
              schedule.contentRevision !== input.revision
            ) {
              throw new McpReadError(
                "OBJECT_NOT_FOUND",
                "The requested object was not found.",
              );
            }
            const durableKey = await execution.run(() =>
              storageKey(
                "foundry.publication.cancel",
                principal,
                input.idempotencyKey,
              ),
            );
            const prior = await execution.run(() =>
              application.queries.findScheduleCancellationByRequest({
                siteId: principal.siteId,
                requestId: durableKey,
              }),
            );
            if (
              prior !== null &&
              (
                prior.id !== schedule.id ||
                prior.workspaceId !== workspaceId ||
                prior.contentRevision !== input.revision
              )
            ) {
              throw new McpReadError(
                "IDEMPOTENCY_KEY_REUSED",
                "The idempotency key was already used for different input.",
              );
            }
            const cancelled =
              prior ??
              (await execution.run(async () =>
                application.commands.cancelSchedule({
                  actorId: createMcpContentActorId(principal),
                  siteId: principal.siteId,
                  postId: schedule.postId,
                  scheduleId: schedule.id,
                  idempotencyKey: durableKey,
                  authority: {
                    kind: "mcp",
                    connectionId: principal.connectionId,
                    actorId: principal.actorId,
                    operation: "foundry.publication.schedule",
                    requiredScopes: scopesEvaluated,
                    audit: {
                      ...audit,
                      scopesEvaluated,
                      idempotencyKey: input.idempotencyKey,
                      workspaceId,
                      revision: input.revision,
                      approvalId: schedule.approvalId,
                      resultHash: await sha256CanonicalJson({
                        command: "foundry.publication.cancel",
                        workspaceId,
                        revision: input.revision,
                        scheduleId: schedule.id,
                        idempotencyKey: input.idempotencyKey,
                      }),
                    },
                  },
                }),
              ));
            const replayed = prior !== null;
            const result = publicationResult(
              cancelled.id,
              cancelled.state,
              replayed,
            );
            await record(execution, {
              ...audit,
              scopesEvaluated,
            }, {
              idempotencyKey: input.idempotencyKey,
              workspaceId,
              revision: input.revision,
              approvalId: cancelled.approvalId,
              publicationId: null,
              scheduleId: cancelled.id,
              resultHash: await sha256CanonicalJson(result),
              replayed,
            });
            return result;
          } catch (error) {
            throw publicationError(error);
          }
        },
      });
    },
  });
}

export type McpPublicationSiteId = SiteId;

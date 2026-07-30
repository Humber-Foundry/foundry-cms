import {
  designContract,
  siteDefinitionSchema,
  type SiteDefinition,
  type SiteId,
} from "@foundry/site-definition";

import type { SiteApplication } from "./index";
import {
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionStaleError,
  ContentRevisionValidationError,
  ContentWorkspaceAccessError,
} from "./content-revisions";
import { sha256CanonicalJson } from "./deterministic-hash";

export const mcpContractVersion = "foundry.mcp.v1" as const;
export const mcpInitialScope = "site.read" as const;
export const mcpContentDraftScope = "content.draft" as const;
export const mcpDesignDraftScope = "design.draft" as const;
export const mcpPublicationScheduleScope = "publication.schedule" as const;
export const mcpPublicationPublishScope = "publication.publish" as const;
export const mcpSupportedScopes = Object.freeze([
  mcpInitialScope,
  mcpContentDraftScope,
  mcpDesignDraftScope,
  mcpPublicationScheduleScope,
  mcpPublicationPublishScope,
] as const);
export const mcpProtocolVersion = "2025-11-25" as const;

export type McpConnectionStatus = "active" | "revoked";

export type McpConnectionPrincipal = Readonly<{
  connectionId: string;
  actorId: string;
  clientId: string;
  siteId: SiteId;
  scopes: ReadonlyArray<string>;
}>;

export type McpConnectionGrant = McpConnectionPrincipal &
  Readonly<{
    status: McpConnectionStatus;
  }>;

export type McpConnectionSummary = McpConnectionGrant &
  Readonly<{
    createdAt: string;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }>;

export type McpReadAuditEvent = Readonly<{
  invocationId: string;
  connectionId: string;
  actorId: string;
  siteId: SiteId;
  operation: string;
  inputHash: string;
  protocolVersion: typeof mcpProtocolVersion;
  scopesEvaluated: ReadonlyArray<string>;
  outcome: "allowed" | "denied";
  reason: McpReadErrorCode | null;
  occurredAt: string;
  contractVersion: typeof mcpContractVersion;
}>;

export type McpLinkedPublicationAudit = McpReadAuditEvent &
  Readonly<{
    idempotencyKey: string;
    workspaceId: string;
    revision: number;
    approvalId: string | null;
    /**
     * Derives the audit `result_hash` from the outcome the store is about to
     * commit. The caller owns the tool result envelope, so a store never has
     * to reproduce its shape; passing a precomputed hash is not possible
     * because the operation identity is only known once the claim is built.
     */
    deriveResultHash(
      outcome: Readonly<{ operationId: string; state: string }>,
    ): Promise<string>;
  }>;

export type McpConnectionStore = Readonly<{
  findCurrentConnection(input: {
    connectionId: string;
    siteId: SiteId;
  }): Promise<McpConnectionGrant | null>;
  recordInvocation(event: McpReadAuditEvent): Promise<void>;
}>;

export type McpCursorBinding = Readonly<{
  siteId: SiteId;
  actorId: string;
  query: string;
  offset: number;
}>;

export type McpCursorCodec = Readonly<{
  encode(binding: McpCursorBinding): Promise<string>;
  decode(cursor: string): Promise<McpCursorBinding>;
}>;

export type McpExecutionContext = Readonly<{
  throwIfExpired(): void;
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
  finishDurably<Result>(operation: () => Promise<Result>): Promise<Result>;
}>;

export type McpReadErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "INSUFFICIENT_SCOPE"
  | "CONNECTION_REVOKED"
  | "OBJECT_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "STALE_REVISION"
  | "IDEMPOTENCY_KEY_REUSED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_STALE"
  | "WRONG_ARTIFACT_KIND"
  | "PUBLICATION_BUSY"
  | "RESULT_UNKNOWN"
  | "TEMPORARILY_UNAVAILABLE";

export class McpReadError extends Error {
  readonly code: McpReadErrorCode;
  readonly retryable: boolean;
  readonly invocationId: string | null;
  readonly observedAt: string | null;
  readonly requiredScopes: ReadonlyArray<string>;
  readonly latestRevision: number | null;
  readonly conflictResource: string | null;
  readonly replayed: boolean;
  readonly auditRecorded: boolean;

  constructor(
    code: McpReadErrorCode,
    message: string,
    context: Readonly<{
      invocationId?: string;
      observedAt?: string;
      requiredScopes?: ReadonlyArray<string>;
      latestRevision?: number;
      conflictResource?: string;
      replayed?: boolean;
      auditRecorded?: boolean;
    }> | null = null,
  ) {
    super(message);
    this.name = "McpReadError";
    this.code = code;
    this.retryable = code === "TEMPORARILY_UNAVAILABLE";
    this.invocationId = context?.invocationId ?? null;
    this.observedAt = context?.observedAt ?? null;
    this.requiredScopes = context?.requiredScopes ?? [];
    this.latestRevision = context?.latestRevision ?? null;
    this.conflictResource = context?.conflictResource ?? null;
    this.replayed = context?.replayed ?? false;
    this.auditRecorded = context?.auditRecorded ?? false;
  }
}

type McpSuccess<Result> = Readonly<{
  contractVersion: typeof mcpContractVersion;
  invocationId: string;
  result: Result;
  meta: Readonly<{
    replayed: boolean;
    observedAt: string;
  }>;
}>;

type PublishedContentKind = "page" | "post";

type PublishedContentSummary = Readonly<{
  kind: PublishedContentKind;
  contentId: string;
  title: string;
  revision: number | null;
  contentHash: string;
  liveGitSha: string | null;
  lastModified: string | null;
}>;

type PublishedContentDocument =
  | Readonly<{
      kind: "page";
      contentId: string;
      revision: null;
      contentHash: string;
      liveGitSha: string | null;
      lastModified: string | null;
      document: SiteDefinition["home"];
    }>
  | Readonly<{
      kind: "post";
      contentId: string;
      revision: number;
      contentHash: string;
      liveGitSha: string | null;
      lastModified: string | null;
      document: SiteDefinition["blog"]["posts"][number];
    }>;

const allowedScopes = new Set<string>(mcpSupportedScopes);

function contentSummaries(
  definition: SiteDefinition,
  liveRelease: Readonly<{
    gitSha: string;
    observedAt: string;
  }> | null,
): ReadonlyArray<PublishedContentSummary> {
  const summaries = [
    {
      kind: "page" as const,
      contentId: definition.home.id,
      title: definition.home.seo.title,
      revision: null,
      contentHash: "",
      liveGitSha: liveRelease?.gitSha ?? null,
      lastModified: liveRelease?.observedAt ?? null,
    },
    ...definition.blog.posts.map((post) => ({
      kind: "post" as const,
      contentId: post.id,
      title: post.title,
      revision: post.revision,
      contentHash: "",
      liveGitSha: liveRelease?.gitSha ?? null,
      lastModified: liveRelease?.observedAt ?? null,
    })),
  ];
  return summaries;
}

function contentDocument(
  definition: SiteDefinition,
  kind: PublishedContentKind,
  contentId: string,
  liveRelease: Readonly<{
    gitSha: string;
    observedAt: string;
  }> | null,
): PublishedContentDocument | null {
  if (kind === "page") {
    return definition.home.id === contentId
      ? {
          kind,
          contentId,
          revision: null,
          contentHash: "",
          liveGitSha: liveRelease?.gitSha ?? null,
          lastModified: liveRelease?.observedAt ?? null,
          document: definition.home,
        }
      : null;
  }
  const post = definition.blog.posts.find((candidate) => candidate.id === contentId);
  return post === undefined
    ? null
    : {
        kind,
        contentId,
        revision: post.revision,
        contentHash: "",
        liveGitSha: liveRelease?.gitSha ?? null,
        lastModified: liveRelease?.observedAt ?? null,
        document: post,
      };
}

function isAuthenticConnection(
  current: McpConnectionGrant,
  principal: McpConnectionPrincipal,
): boolean {
  return (
    current.siteId === principal.siteId &&
    current.connectionId === principal.connectionId &&
    current.actorId === principal.actorId &&
    current.clientId === principal.clientId &&
    current.scopes.length > 0 &&
    current.scopes.every((scope) => allowedScopes.has(scope)) &&
    principal.scopes.length > 0 &&
    principal.scopes.every((scope) => current.scopes.includes(scope)) &&
    principal.scopes.every((scope) => allowedScopes.has(scope))
  );
}

export function createMcpReadApplication({
  site,
  siteMetadata,
  connections,
  cursors,
  createInvocationId = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
}: {
  site: SiteApplication;
  siteMetadata: Readonly<{
    canonicalUrl: string;
    locale: string;
    timeZone: string;
    getLiveRelease(): Promise<{
      gitSha: string;
      releaseId: string;
      observedAt: string;
    } | null>;
  }>;
  connections: McpConnectionStore;
  cursors: McpCursorCodec;
  createInvocationId?: () => string;
  now?: () => string;
}) {
  const uninterruptedContext: McpExecutionContext = {
    throwIfExpired() {},
    run: (operation) => operation(),
    finishDurably: (operation) => operation(),
  };

  async function loadConnection(
    principal: McpConnectionPrincipal,
    context: McpExecutionContext = uninterruptedContext,
  ) {
    return context.run(() =>
      connections.findCurrentConnection({
        connectionId: principal.connectionId,
        siteId: principal.siteId,
      }),
    );
  }

  async function execute<Result>({
    principal,
    operation,
    auditInput,
    run,
    context,
    requiredScopes = [mcpInitialScope],
    successfulScopesEvaluated,
    joinedAudit = false,
    recordJoinedFailure,
  }: {
    principal: McpConnectionPrincipal;
    operation: string;
    auditInput: unknown;
    run(
      context: McpExecutionContext,
      audit: McpReadAuditEvent,
    ): Promise<Result>;
    context: McpExecutionContext;
    requiredScopes?: ReadonlyArray<string>;
    successfulScopesEvaluated?: () => ReadonlyArray<string>;
    joinedAudit?: boolean;
    recordJoinedFailure?: (
      audit: McpReadAuditEvent,
      error: McpReadError,
    ) => Promise<McpReadError | void>;
  }): Promise<McpSuccess<Result>> {
    const invocationId = createInvocationId();
    const observedAt = now();
    const inputHash = await context.run(() =>
      sha256CanonicalJson(auditInput),
    );
    let allowedAudit: McpReadAuditEvent | null = null;
    try {
      const current = await loadConnection(principal, context);
      if (current === null || !isAuthenticConnection(current, principal)) {
        throw new McpReadError(
          "AUTHENTICATION_REQUIRED",
          "The MCP connection is invalid or revoked.",
        );
      }
      if (current.status === "revoked") {
        throw new McpReadError(
          "CONNECTION_REVOKED",
          "The MCP connection has been revoked.",
        );
      }
      if (
        requiredScopes.some(
          (scope) =>
            !current.scopes.includes(scope) ||
            !principal.scopes.includes(scope),
        )
      ) {
        throw new McpReadError(
          "INSUFFICIENT_SCOPE",
          "The current connection does not grant the required scope.",
        );
      }
      allowedAudit = {
        invocationId,
        connectionId: principal.connectionId,
        actorId: principal.actorId,
        siteId: principal.siteId,
        operation,
        inputHash,
        protocolVersion: mcpProtocolVersion,
        scopesEvaluated: requiredScopes,
        outcome: "allowed",
        reason: null,
        occurredAt: observedAt,
        contractVersion: mcpContractVersion,
      };
      const result = await run(context, allowedAudit);
      context.throwIfExpired();
      if (!joinedAudit) {
        const completedAudit = {
          ...allowedAudit,
          scopesEvaluated:
            successfulScopesEvaluated?.() ?? requiredScopes,
        };
        await context.finishDurably(() =>
          connections.recordInvocation(completedAudit),
        );
      }
      const replayed =
        typeof result === "object" &&
        result !== null &&
        "replayed" in result &&
        typeof result.replayed === "boolean"
          ? result.replayed
          : false;
      return {
        contractVersion: mcpContractVersion,
        invocationId,
        result,
        meta: {
          replayed,
          observedAt,
        },
      };
    } catch (error) {
      context.throwIfExpired();
      const safeError =
        error instanceof McpReadError
          ? error
          : error instanceof Error && error.name === "SiteNotFoundError"
            ? new McpReadError(
                "OBJECT_NOT_FOUND",
                "The requested object was not found.",
              )
          : error instanceof ContentRevisionConflictError
            ? new McpReadError(
                "STALE_REVISION",
                "The workspace revision changed.",
              )
          : error instanceof ContentRevisionIdempotencyError
            ? new McpReadError(
                "IDEMPOTENCY_KEY_REUSED",
                "The idempotency key was already used for different input.",
              )
          : error instanceof ContentRevisionStaleError
            ? new McpReadError(
                "STALE_REVISION",
                "The workspace revision changed.",
                error.acknowledgedRevision === undefined
                  ? null
                  : { latestRevision: error.acknowledgedRevision },
              )
          : error instanceof ContentRevisionValidationError
            ? new McpReadError(
                "VALIDATION_FAILED",
                "The draft command failed validation.",
              )
          : error instanceof ContentWorkspaceAccessError
            ? new McpReadError(
                "OBJECT_NOT_FOUND",
                "The requested object was not found.",
              )
          : new McpReadError(
              "TEMPORARILY_UNAVAILABLE",
              "The request could not be completed safely.",
            );
      const scopesEvaluated =
        safeError.requiredScopes.length > 0
          ? safeError.requiredScopes
          : requiredScopes;
      const contextualError = new McpReadError(
        safeError.code,
        safeError.message,
        {
          invocationId,
          observedAt:
            safeError.replayed && safeError.observedAt !== null
              ? safeError.observedAt
              : observedAt,
          requiredScopes:
            safeError.code === "INSUFFICIENT_SCOPE"
              ? scopesEvaluated
              : [],
          ...(safeError.latestRevision === null
            ? {}
            : { latestRevision: safeError.latestRevision }),
          ...(safeError.conflictResource === null
            ? {}
            : { conflictResource: safeError.conflictResource }),
          replayed: safeError.replayed,
          auditRecorded: safeError.auditRecorded,
        },
      );
      let reportedError = contextualError;
      let joinedFailureRecorded = safeError.auditRecorded;
      if (
        !joinedFailureRecorded &&
        allowedAudit !== null &&
        recordJoinedFailure !== undefined
      ) {
        const joinedFailureAudit = {
          ...allowedAudit,
          scopesEvaluated,
        };
        try {
          const authoritativeError = await context.finishDurably(() =>
            recordJoinedFailure(joinedFailureAudit, safeError),
          );
          if (authoritativeError instanceof McpReadError) {
            reportedError = authoritativeError;
          }
          joinedFailureRecorded = true;
        } catch {
          joinedFailureRecorded = false;
        }
      }
      if (!joinedFailureRecorded) {
        await context.finishDurably(() =>
          connections.recordInvocation({
            invocationId,
            connectionId: principal.connectionId,
            actorId: principal.actorId,
            siteId: principal.siteId,
            operation,
            inputHash,
            protocolVersion: mcpProtocolVersion,
            scopesEvaluated,
            outcome: "denied",
            reason: safeError.code,
            occurredAt: observedAt,
            contractVersion: mcpContractVersion,
          }),
        );
      }
      throw new McpReadError(
        reportedError.code,
        reportedError.message,
        {
          invocationId,
          observedAt:
            reportedError.observedAt ??
            contextualError.observedAt ??
            undefined,
          requiredScopes:
            reportedError.code === "INSUFFICIENT_SCOPE" &&
            reportedError.requiredScopes.length === 0
              ? scopesEvaluated
              : reportedError.requiredScopes,
          latestRevision:
            reportedError.latestRevision ?? undefined,
          conflictResource:
            reportedError.conflictResource ?? undefined,
          replayed: reportedError.replayed,
          auditRecorded: joinedFailureRecorded,
        },
      );
    }
  }

  return {
    executeScoped: execute,
    loadConnection,
    rejectInvalidInput(
      principal: McpConnectionPrincipal,
      operation: string,
      input: unknown,
      context: McpExecutionContext = uninterruptedContext,
      requiredScopes: ReadonlyArray<string> = [mcpInitialScope],
    ): Promise<unknown> {
      return execute({
        principal,
        operation,
        auditInput: input,
        context,
        requiredScopes,
        async run(): Promise<never> {
          throw new McpReadError(
            "VALIDATION_FAILED",
            "The tool arguments are invalid.",
          );
        },
      });
    },
    getSite(
      principal: McpConnectionPrincipal,
      context: McpExecutionContext = uninterruptedContext,
    ) {
      return execute({
        principal,
        operation: "foundry.site.get",
        auditInput: {},
        context,
        async run(execution) {
          const definition = await execution.run(() =>
            site.queries.getPublishedSite(),
          );
          const liveRelease = await execution.run(() =>
            siteMetadata.getLiveRelease(),
          );
          return {
            siteId: site.siteId,
            displayName: definition.site.name,
            canonicalUrl: siteMetadata.canonicalUrl,
            locale: siteMetadata.locale,
            timeZone: siteMetadata.timeZone,
            schemaVersion: definition.schemaVersion,
            liveRelease,
          };
        },
      });
    },
    getContentSchema(
      principal: McpConnectionPrincipal,
      context: McpExecutionContext = uninterruptedContext,
    ) {
      return execute({
        principal,
        operation: "foundry.schema.content.get",
        auditInput: {},
        context,
        async run(execution) {
          const definition = await execution.run(() =>
            site.queries.getPublishedSite(),
          );
          const liveRelease = await execution.run(() =>
            siteMetadata.getLiveRelease(),
          );
          return {
            schemaVersion: definition.schemaVersion,
            schema: siteDefinitionSchema,
            contentHash: await execution.run(() =>
              sha256CanonicalJson(siteDefinitionSchema),
            ),
            lastModified: liveRelease?.observedAt ?? null,
          };
        },
      });
    },
    getDesignSchema(
      principal: McpConnectionPrincipal,
      context: McpExecutionContext = uninterruptedContext,
    ) {
      return execute({
        principal,
        operation: "foundry.schema.design.get",
        auditInput: {},
        context,
        async run(execution) {
          const definition = await execution.run(() =>
            site.queries.getPublishedSite(),
          );
          const liveRelease = await execution.run(() =>
            siteMetadata.getLiveRelease(),
          );
          const schema = {
            schemaVersion: definition.schemaVersion,
            design: siteDefinitionSchema.properties.design,
            contract: designContract,
          };
          return {
            ...schema,
            contentHash: await execution.run(() => sha256CanonicalJson(schema)),
            lastModified: liveRelease?.observedAt ?? null,
          };
        },
      });
    },
    listContent(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        kind: PublishedContentKind | null;
        limit: number;
        cursor: string | null;
      }>,
      context: McpExecutionContext = uninterruptedContext,
    ) {
      return execute({
        principal,
        operation: "foundry.content.list",
        auditInput: input,
        context,
        async run(execution) {
          if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
            throw new McpReadError(
              "VALIDATION_FAILED",
              "The page size must be between 1 and 100.",
            );
          }
          const query = `content:${input.kind ?? "all"}`;
          let offset = 0;
          if (input.cursor !== null) {
            const cursor = input.cursor;
            let binding: McpCursorBinding;
            try {
              binding = await execution.run(() => cursors.decode(cursor));
            } catch {
              throw new McpReadError(
                "VALIDATION_FAILED",
                "The pagination cursor is invalid.",
              );
            }
            if (
              binding.siteId !== principal.siteId ||
              binding.actorId !== principal.actorId ||
              binding.query !== query ||
              !Number.isInteger(binding.offset) ||
              binding.offset < 0
            ) {
              throw new McpReadError(
                "VALIDATION_FAILED",
                "The pagination cursor is invalid.",
              );
            }
            offset = binding.offset;
          }
          const definition = await execution.run(() =>
            site.queries.getPublishedSite(),
          );
          const liveRelease = await execution.run(() =>
            siteMetadata.getLiveRelease(),
          );
          const allItemsWithDocuments = contentSummaries(
            definition,
            liveRelease,
          );
          const allItems = await execution.run(() =>
            Promise.all(
              allItemsWithDocuments.map(async (item) => {
                const document =
                  item.kind === "page"
                    ? definition.home
                    : definition.blog.posts.find(
                        (post) => post.id === item.contentId,
                      );
                return {
                  ...item,
                  contentHash: await sha256CanonicalJson(document),
                };
              }),
            ),
          );
          const filteredItems = allItems.filter(
            (item) => input.kind === null || item.kind === input.kind,
          );
          const items = filteredItems.slice(offset, offset + input.limit);
          const nextOffset = offset + items.length;
          return {
            items,
            nextCursor:
              nextOffset < filteredItems.length
                ? await execution.run(() =>
                    cursors.encode({
                      siteId: principal.siteId,
                      actorId: principal.actorId,
                      query,
                      offset: nextOffset,
                    }),
                  )
                : null,
          };
        },
      });
    },
    getContent(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        kind: PublishedContentKind;
        contentId: string;
      }>,
      context: McpExecutionContext = uninterruptedContext,
    ) {
      return execute({
        principal,
        operation: "foundry.content.get",
        auditInput: input,
        context,
        async run(execution) {
          const definition = await execution.run(() =>
            site.queries.getPublishedSite(),
          );
          const liveRelease = await execution.run(() =>
            siteMetadata.getLiveRelease(),
          );
          const document = contentDocument(
            definition,
            input.kind,
            input.contentId,
            liveRelease,
          );
          if (document === null) {
            throw new McpReadError(
              "OBJECT_NOT_FOUND",
              "The requested object was not found.",
            );
          }
          return {
            ...document,
            contentHash: await execution.run(() =>
              sha256CanonicalJson(document.document),
            ),
          };
        },
      });
    },
  };
}

import {
  siteDefinitionSchema,
  type SiteDefinition,
  type SiteId,
} from "@foundry/site-definition";

import type { SiteApplication } from "./index";

export const mcpContractVersion = "foundry.mcp.v1" as const;
export const mcpInitialScope = "site.read" as const;

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

export type McpReadAuditEvent = Readonly<{
  invocationId: string;
  connectionId: string;
  actorId: string;
  siteId: SiteId;
  operation: string;
  scopesEvaluated: ReadonlyArray<string>;
  outcome: "allowed" | "denied";
  reason: McpReadErrorCode | null;
  occurredAt: string;
  contractVersion: typeof mcpContractVersion;
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

export type McpReadErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "INSUFFICIENT_SCOPE"
  | "CONNECTION_REVOKED"
  | "OBJECT_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "TEMPORARILY_UNAVAILABLE";

export class McpReadError extends Error {
  readonly code: McpReadErrorCode;
  readonly retryable: boolean;
  readonly invocationId: string | null;
  readonly observedAt: string | null;

  constructor(
    code: McpReadErrorCode,
    message: string,
    context: Readonly<{
      invocationId: string;
      observedAt: string;
    }> | null = null,
  ) {
    super(message);
    this.name = "McpReadError";
    this.code = code;
    this.retryable = code === "TEMPORARILY_UNAVAILABLE";
    this.invocationId = context?.invocationId ?? null;
    this.observedAt = context?.observedAt ?? null;
  }
}

type McpSuccess<Result> = Readonly<{
  contractVersion: typeof mcpContractVersion;
  invocationId: string;
  result: Result;
  meta: Readonly<{
    replayed: false;
    observedAt: string;
  }>;
}>;

type PublishedContentKind = "page" | "post";

type PublishedContentSummary = Readonly<{
  kind: PublishedContentKind;
  contentId: string;
  title: string;
  revision: number;
}>;

type PublishedContentDocument =
  | Readonly<{
      kind: "page";
      contentId: string;
      revision: number;
      document: SiteDefinition["home"];
    }>
  | Readonly<{
      kind: "post";
      contentId: string;
      revision: number;
      document: SiteDefinition["blog"]["posts"][number];
    }>;

const allowedReadScope = new Set<string>([mcpInitialScope]);

function contentSummaries(
  definition: SiteDefinition,
): ReadonlyArray<PublishedContentSummary> {
  return [
    {
      kind: "page",
      contentId: definition.home.id,
      title: definition.home.seo.title,
      revision: 1,
    },
    ...definition.blog.posts.map((post) => ({
      kind: "post" as const,
      contentId: post.id,
      title: post.title,
      revision: post.revision,
    })),
  ];
}

function contentDocument(
  definition: SiteDefinition,
  kind: PublishedContentKind,
  contentId: string,
): PublishedContentDocument | null {
  if (kind === "page") {
    return definition.home.id === contentId
      ? {
          kind,
          contentId,
          revision: 1,
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
    current.actorId.startsWith("mcp-") &&
    current.scopes.length > 0 &&
    current.scopes.every((scope) => allowedReadScope.has(scope)) &&
    principal.scopes.every((scope) => current.scopes.includes(scope)) &&
    principal.scopes.every((scope) => allowedReadScope.has(scope))
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
  }>;
  connections: McpConnectionStore;
  cursors: McpCursorCodec;
  createInvocationId?: () => string;
  now?: () => string;
}) {
  async function loadConnection(principal: McpConnectionPrincipal) {
    return connections.findCurrentConnection({
      connectionId: principal.connectionId,
      siteId: principal.siteId,
    });
  }

  async function execute<Result>({
    principal,
    operation,
    run,
  }: {
    principal: McpConnectionPrincipal;
    operation: string;
    run(): Promise<Result>;
  }): Promise<McpSuccess<Result>> {
    const invocationId = createInvocationId();
    const observedAt = now();
    try {
      const current = await loadConnection(principal);
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
      if (!current.scopes.includes(mcpInitialScope)) {
        throw new McpReadError(
          "INSUFFICIENT_SCOPE",
          "The current connection does not grant site.read.",
        );
      }
      const result = await run();
      await connections.recordInvocation({
        invocationId,
        connectionId: principal.connectionId,
        actorId: principal.actorId,
        siteId: principal.siteId,
        operation,
        scopesEvaluated: [mcpInitialScope],
        outcome: "allowed",
        reason: null,
        occurredAt: observedAt,
        contractVersion: mcpContractVersion,
      });
      return {
        contractVersion: mcpContractVersion,
        invocationId,
        result,
        meta: {
          replayed: false,
          observedAt,
        },
      };
    } catch (error) {
      const safeError =
        error instanceof McpReadError
          ? error
          : error instanceof Error && error.name === "SiteNotFoundError"
            ? new McpReadError(
                "OBJECT_NOT_FOUND",
                "The requested object was not found.",
              )
          : new McpReadError(
              "TEMPORARILY_UNAVAILABLE",
              "The request could not be completed safely.",
            );
      const contextualError = new McpReadError(
        safeError.code,
        safeError.message,
        { invocationId, observedAt },
      );
      await connections.recordInvocation({
        invocationId,
        connectionId: principal.connectionId,
        actorId: principal.actorId,
        siteId: principal.siteId,
        operation,
        scopesEvaluated: [mcpInitialScope],
        outcome: "denied",
        reason: safeError.code,
        occurredAt: observedAt,
        contractVersion: mcpContractVersion,
      });
      throw contextualError;
    }
  }

  return {
    loadConnection,
    getSite(principal: McpConnectionPrincipal) {
      return execute({
        principal,
        operation: "foundry.site.get",
        async run() {
          const definition = await site.queries.getPublishedSite();
          return {
            siteId: site.siteId,
            displayName: definition.site.name,
            canonicalUrl: siteMetadata.canonicalUrl,
            locale: siteMetadata.locale,
            timeZone: siteMetadata.timeZone,
            schemaVersion: definition.schemaVersion,
          };
        },
      });
    },
    getContentSchema(principal: McpConnectionPrincipal) {
      return execute({
        principal,
        operation: "foundry.schema.content.get",
        async run() {
          const definition = await site.queries.getPublishedSite();
          return {
            schemaVersion: definition.schemaVersion,
            schema: siteDefinitionSchema,
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
    ) {
      return execute({
        principal,
        operation: "foundry.content.list",
        async run() {
          if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
            throw new McpReadError(
              "VALIDATION_FAILED",
              "The page size must be between 1 and 100.",
            );
          }
          const query = `content:${input.kind ?? "all"}`;
          let offset = 0;
          if (input.cursor !== null) {
            let binding: McpCursorBinding;
            try {
              binding = await cursors.decode(input.cursor);
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
          const definition = await site.queries.getPublishedSite();
          const allItems = contentSummaries(definition).filter(
            (item) => input.kind === null || item.kind === input.kind,
          );
          const items = allItems.slice(offset, offset + input.limit);
          const nextOffset = offset + items.length;
          return {
            items,
            nextCursor:
              nextOffset < allItems.length
                ? await cursors.encode({
                    siteId: principal.siteId,
                    actorId: principal.actorId,
                    query,
                    offset: nextOffset,
                  })
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
    ) {
      return execute({
        principal,
        operation: "foundry.content.get",
        async run() {
          const definition = await site.queries.getPublishedSite();
          const document = contentDocument(
            definition,
            input.kind,
            input.contentId,
          );
          if (document === null) {
            throw new McpReadError(
              "OBJECT_NOT_FOUND",
              "The requested object was not found.",
            );
          }
          return document;
        },
      });
    },
  };
}

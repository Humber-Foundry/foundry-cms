import {
  McpReadError,
  mcpContractVersion,
  mcpInitialScope,
  mcpProtocolVersion,
  type McpConnectionPrincipal,
  type McpCursorCodec,
  type McpExecutionContext,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import {
  RequestBodyLimitError,
  RequestDeadlineExceededError,
  type RequestExecutionContext,
  hasExactKeys,
  isRecord,
  isRequestId,
  jsonResponse,
  readBoundedText,
  rpcError,
  rpcResult,
  type RpcRequest,
  valueDepth,
} from "./mcp-http-support";
import {
  createMcpToolRegistry,
  type McpReadApplication,
} from "./mcp-tool-registry";

export { mcpProtocolVersion } from "@foundry/application";

const rpcBodyLimitBytes = 256 * 1024;
const rpcMaximumDepth = 32;
const knownMethods = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
]);

type McpProtocolRateStore = Readonly<{
  consumeRateLimit(input: {
    siteId: SiteId;
    bucketKey: string;
    windowStartedAt: string;
    limit: number;
  }): Promise<boolean>;
}>;

function safeErrorMessage(code: McpReadError["code"]) {
  const messages = {
    AUTHENTICATION_REQUIRED: "Authentication is required.",
    INSUFFICIENT_SCOPE: "The connection lacks the required permission.",
    CONNECTION_REVOKED: "The MCP connection has been revoked.",
    OBJECT_NOT_FOUND: "The requested object was not found.",
    VALIDATION_FAILED: "The request is invalid.",
    TEMPORARILY_UNAVAILABLE: "The service is temporarily unavailable.",
  } as const;
  return messages[code];
}

function toolResult(structuredContent: unknown, isError: boolean) {
  return {
    isError,
    structuredContent,
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
  };
}

function readListCursor(params: unknown): string | null | undefined {
  if (params === undefined) return null;
  if (
    !isRecord(params) ||
    !hasExactKeys(params, [], ["cursor", "_meta"]) ||
    (params._meta !== undefined && !isRecord(params._meta)) ||
    (params.cursor !== undefined &&
      typeof params.cursor !== "string")
  ) {
    return undefined;
  }
  return params.cursor ?? null;
}

export function createMcpProtocolRuntime({
  canonicalOrigin,
  siteId,
  siteName,
  store,
  readApplication,
  cursors,
  now = () => new Date(),
}: {
  canonicalOrigin: string;
  siteId: SiteId;
  siteName: string;
  store: McpProtocolRateStore;
  readApplication: McpReadApplication;
  cursors: McpCursorCodec;
  now?: () => Date;
}) {
  const tools = createMcpToolRegistry(readApplication);

  function paginationCursor(nextCursor: string | null) {
    return nextCursor === null ? {} : { nextCursor };
  }

  function resourceAnnotations(lastModified: string | null) {
    return {
      audience: ["user", "assistant"],
      ...(lastModified === null ? {} : { lastModified }),
    };
  }

  async function paginateDiscovery<Value>({
    principal,
    params,
    query,
    values,
    pageSize,
    context,
  }: {
    principal: McpConnectionPrincipal;
    params: unknown;
    query: string;
    values: ReadonlyArray<Value>;
    pageSize: number;
    context: McpExecutionContext;
  }): Promise<{
    values: ReadonlyArray<Value>;
    nextCursor: string | null;
  } | null> {
    const cursor = readListCursor(params);
    if (cursor === undefined) return null;
    let offset = 0;
    if (cursor !== null) {
      try {
        const binding = await context.waitFor(cursors.decode(cursor));
        if (
          binding.siteId !== siteId ||
          binding.actorId !== principal.actorId ||
          binding.query !== `discovery:${query}` ||
          !Number.isInteger(binding.offset) ||
          binding.offset < 0
        ) {
          return null;
        }
        offset = binding.offset;
      } catch (error) {
        if (error instanceof RequestDeadlineExceededError) throw error;
        return null;
      }
    }
    const page = values.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      values: page,
      nextCursor:
        nextOffset < values.length
          ? await context.waitFor(
              cursors.encode({
                siteId,
                actorId: principal.actorId,
                query: `discovery:${query}`,
                offset: nextOffset,
              }),
            )
          : null,
    };
  }

  async function readResource(
    principal: McpConnectionPrincipal,
    uri: string,
    context: McpExecutionContext,
  ) {
    if (uri === "foundry://site") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(await readApplication.getSite(principal, context)),
      };
    }
    if (uri === "foundry://schemas/content") {
      return {
        uri,
        mimeType: "application/schema+json",
        text: JSON.stringify(
          await readApplication.getContentSchema(principal, context),
        ),
      };
    }
    if (uri === "foundry://schemas/design") {
      return {
        uri,
        mimeType: "application/schema+json",
        text: JSON.stringify(
          await readApplication.getDesignSchema(principal, context),
        ),
      };
    }
    const match = /^foundry:\/\/content\/(page|post)\/([^/]+)$/u.exec(uri);
    if (match !== null) {
      let contentId: string;
      try {
        contentId = decodeURIComponent(match[2]!);
      } catch {
        throw new McpReadError(
          "VALIDATION_FAILED",
          "The resource URI is invalid.",
        );
      }
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          await readApplication.getContent(
            principal,
            {
              kind: match[1] as "page" | "post",
              contentId,
            },
            context,
          ),
        ),
      };
    }
    throw new McpReadError(
      "OBJECT_NOT_FOUND",
      "The requested object was not found.",
    );
  }

  async function callTool(
    principal: McpConnectionPrincipal,
    name: string,
    argumentsValue: unknown,
    context: McpExecutionContext,
  ) {
    const tool = tools.get(name);
    if (tool === null) return null;
    try {
      return toolResult(
        await tool.execute(principal, argumentsValue, context),
        false,
      );
    } catch (error) {
      if (!(error instanceof McpReadError)) throw error;
      const observedAt = error.observedAt ?? now().toISOString();
      return toolResult(
        {
          contractVersion: mcpContractVersion,
          invocationId: error.invocationId ?? crypto.randomUUID(),
          error: {
            code: error.code,
            message: safeErrorMessage(error.code),
            retryable: error.retryable,
            requiredScopes:
              error.code === "INSUFFICIENT_SCOPE" ? [mcpInitialScope] : [],
          },
          meta: {
            replayed: false,
            observedAt,
          },
        },
        true,
      );
    }
  }

  async function applyIngressRateLimits(
    principal: McpConnectionPrincipal,
    context: McpExecutionContext,
    requestId: RpcRequest["id"] | null,
  ) {
    const windowStartedAt = new Date(
      Math.floor(now().getTime() / 60_000) * 60_000,
    ).toISOString();
    const [siteBudget, connectionBudget] = await context.waitFor(
      Promise.all([
        store.consumeRateLimit({
          siteId,
          bucketKey: "site",
          windowStartedAt,
          limit: 600,
        }),
        store.consumeRateLimit({
          siteId,
          bucketKey: principal.connectionId,
          windowStartedAt,
          limit: 300,
        }),
      ]),
    );
    return siteBudget && connectionBudget
      ? null
      : rateLimitedResponse(requestId);
  }

  function rateLimitedResponse(id?: RpcRequest["id"] | null) {
    const retryAfter = Math.max(1, 60 - now().getUTCSeconds());
    return id === undefined
      ? jsonResponse(
          { error: "rate_limited", retryAfterMs: retryAfter * 1_000 },
          429,
          { "retry-after": String(retryAfter) },
        )
      : rpcError(
          id,
          -32003,
          "Rate limited",
          { code: "RATE_LIMITED", retryAfterMs: retryAfter * 1_000 },
          429,
          { "retry-after": String(retryAfter) },
        );
  }

  async function applyOperationRateLimit(
    principal: McpConnectionPrincipal,
    rpc: RpcRequest,
    context: McpExecutionContext,
  ) {
    const windowStartedAt = new Date(
      Math.floor(now().getTime() / 60_000) * 60_000,
    ).toISOString();
    const requestedOperation =
      rpc.method === "tools/call" &&
      isRecord(rpc.params) &&
      typeof rpc.params.name === "string"
        ? `${rpc.method}:${rpc.params.name}`
        : rpc.method;
    const operation =
      knownMethods.has(rpc.method) &&
      (rpc.method !== "tools/call" ||
        (isRecord(rpc.params) &&
          typeof rpc.params.name === "string" &&
          tools.get(rpc.params.name) !== null))
        ? requestedOperation
        : "unknown";
    return (await context.waitFor(
      store.consumeRateLimit({
        siteId,
        bucketKey: `${principal.connectionId}:${operation}`,
        windowStartedAt,
        limit: 120,
      }),
    ))
      ? null
      : rateLimitedResponse(rpc.id);
  }

  async function dispatch(
    principal: McpConnectionPrincipal,
    rpc: RpcRequest,
    context: McpExecutionContext,
  ): Promise<Response> {
    const rateLimited = await applyOperationRateLimit(principal, rpc, context);
    if (rateLimited !== null) return rateLimited;
    if (rpc.method === "ping") {
      return rpc.params === undefined ||
        (isRecord(rpc.params) &&
          hasExactKeys(rpc.params, [], ["_meta"]) &&
          (rpc.params._meta === undefined || isRecord(rpc.params._meta)))
        ? rpcResult(rpc.id, {})
        : rpcError(rpc.id, -32602, "Invalid ping parameters");
    }
    if (rpc.method === "initialize") {
      if (
        !isRecord(rpc.params) ||
        !hasExactKeys(
          rpc.params,
          ["protocolVersion", "capabilities", "clientInfo"],
          ["_meta"],
        ) ||
        rpc.params.protocolVersion !== mcpProtocolVersion ||
        !isRecord(rpc.params.capabilities) ||
        !isRecord(rpc.params.clientInfo) ||
        typeof rpc.params.clientInfo.name !== "string" ||
        typeof rpc.params.clientInfo.version !== "string" ||
        (rpc.params._meta !== undefined && !isRecord(rpc.params._meta))
      ) {
        return rpcError(
          rpc.id,
          -32602,
          "Unsupported MCP protocol version",
        );
      }
      return rpcResult(rpc.id, {
        protocolVersion: mcpProtocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: "foundry-cms",
          version: "0.1.0",
          description: `${siteName} read-only MCP resource (${mcpContractVersion})`,
        },
      });
    }
    if (rpc.method === "tools/list") {
      const page = await paginateDiscovery({
        principal,
        params: rpc.params,
        query: "tools",
        values: tools.list(),
        pageSize: 2,
        context,
      });
      return page === null
        ? rpcError(rpc.id, -32602, "Invalid pagination cursor")
        : rpcResult(rpc.id, {
            tools: page.values,
            ...paginationCursor(page.nextCursor),
          });
    }
    if (rpc.method === "tools/call") {
      if (
        !isRecord(rpc.params) ||
        !hasExactKeys(rpc.params, ["name"], ["arguments", "_meta"]) ||
        (rpc.params._meta !== undefined && !isRecord(rpc.params._meta)) ||
        typeof rpc.params.name !== "string"
      ) {
        return rpcError(rpc.id, -32602, "Invalid tool arguments");
      }
      const result = await callTool(
        principal,
        rpc.params.name,
        rpc.params.arguments ?? {},
        context,
      );
      return result === null
        ? rpcError(rpc.id, -32602, "Invalid tool arguments")
        : rpcResult(rpc.id, result);
    }
    if (rpc.method === "resources/list") {
      const cursor = readListCursor(rpc.params);
      if (cursor === undefined) {
        return rpcError(rpc.id, -32602, "Invalid pagination cursor");
      }
      const site = await readApplication.getSite(principal, context);
      const content = await readApplication.listContent(
        principal,
        {
          kind: null,
          limit: cursor === null ? 47 : 50,
          cursor,
        },
        context,
      );
      return rpcResult(rpc.id, {
        resources: [
          ...(cursor === null
            ? [
                {
                  uri: "foundry://site",
                  name: site.result.displayName,
                  mimeType: "application/json",
                  annotations: resourceAnnotations(
                    site.result.liveRelease?.observedAt ?? null,
                  ),
                },
                {
                  uri: "foundry://schemas/content",
                  name: "Content schema",
                  mimeType: "application/schema+json",
                  annotations: resourceAnnotations(
                    site.result.liveRelease?.observedAt ?? null,
                  ),
                },
                {
                  uri: "foundry://schemas/design",
                  name: "Design schema",
                  mimeType: "application/schema+json",
                  annotations: resourceAnnotations(
                    site.result.liveRelease?.observedAt ?? null,
                  ),
                },
              ]
            : []),
          ...content.result.items.map((item) => ({
            uri: `foundry://content/${item.kind}/${encodeURIComponent(item.contentId)}`,
            name: item.title,
            mimeType: "application/json",
            annotations: resourceAnnotations(item.lastModified),
            _meta: {
              contentHash: item.contentHash,
              liveGitSha: item.liveGitSha,
              lastModified: item.lastModified,
            },
          })),
        ],
        ...paginationCursor(content.result.nextCursor),
      });
    }
    if (rpc.method === "resources/templates/list") {
      const site = await readApplication.getSite(principal, context);
      const page = await paginateDiscovery({
        principal,
        params: rpc.params,
        query: "resource-templates",
        values: [
          {
            uriTemplate: "foundry://content/{kind}/{contentId}",
            name: "Published content",
            mimeType: "application/json",
            annotations: resourceAnnotations(
              site.result.liveRelease?.observedAt ?? null,
            ),
          },
        ],
        pageSize: 50,
        context,
      });
      return page === null
        ? rpcError(rpc.id, -32602, "Invalid pagination cursor")
        : rpcResult(rpc.id, {
            resourceTemplates: page.values,
            ...paginationCursor(page.nextCursor),
          });
    }
    if (rpc.method === "resources/read") {
      if (
        !isRecord(rpc.params) ||
        !hasExactKeys(rpc.params, ["uri"], ["_meta"]) ||
        (rpc.params._meta !== undefined && !isRecord(rpc.params._meta)) ||
        typeof rpc.params.uri !== "string"
      ) {
        return rpcError(rpc.id, -32602, "Invalid resource request");
      }
      try {
        return rpcResult(rpc.id, {
          contents: [await readResource(principal, rpc.params.uri, context)],
        });
      } catch (error) {
        if (error instanceof McpReadError) {
          if (error.code === "VALIDATION_FAILED") {
            return rpcError(rpc.id, -32602, "Invalid resource request");
          }
          return rpcError(rpc.id, -32002, safeErrorMessage(error.code), {
            code: error.code,
          });
        }
        throw error;
      }
    }
    if (rpc.method === "prompts/list") {
      const page = await paginateDiscovery({
        principal,
        params: rpc.params,
        query: "prompts",
        values: [],
        pageSize: 50,
        context,
      });
      return page === null
        ? rpcError(rpc.id, -32602, "Invalid pagination cursor")
        : rpcResult(rpc.id, {
            prompts: page.values,
            ...paginationCursor(page.nextCursor),
          });
    }
    return rpcError(rpc.id, -32601, "Method not found");
  }

  return {
    async handle(
      request: Request,
      authenticate: () => Promise<McpConnectionPrincipal | Response>,
      context: RequestExecutionContext,
    ): Promise<Response> {
      if (request.method !== "POST") {
        return jsonResponse({ error: "method_not_allowed" }, 405, {
          allow: "POST",
        });
      }
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== canonicalOrigin) {
        return jsonResponse({ error: "origin_not_allowed" }, 403);
      }
      const accept = request.headers.get("accept") ?? "";
      if (
        !accept.includes("application/json") ||
        !accept.includes("text/event-stream") ||
        request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json") !== true
      ) {
        return jsonResponse({ error: "unsupported_media_type" }, 415);
      }
      const requestedVersion =
        request.headers.get("mcp-protocol-version");
      if (
        requestedVersion !== null &&
        requestedVersion !== mcpProtocolVersion
      ) {
        return rpcError(
          null,
          -32600,
          "Unsupported MCP protocol version",
          undefined,
          400,
        );
      }
      let principal: McpConnectionPrincipal | Response;
      try {
        principal = await context.waitFor(authenticate());
      } catch (error) {
        return error instanceof RequestDeadlineExceededError
          ? jsonResponse(
              { error: "temporarily_unavailable" },
              503,
              { "retry-after": "1" },
            )
          : jsonResponse({ error: "temporarily_unavailable" }, 503);
      }
      if (principal instanceof Response) return principal;
      let value: unknown;
      let bodyFailure: Response | null = null;
      try {
        value = JSON.parse(
          await context.waitFor(
            readBoundedText(request, rpcBodyLimitBytes, context.signal),
          ),
        );
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          value = null;
          bodyFailure = jsonResponse({ error: "request_too_large" }, 413);
        } else if (error instanceof RequestDeadlineExceededError) {
          return jsonResponse(
            { error: "temporarily_unavailable" },
            503,
            { "retry-after": "1" },
          );
        } else {
          value = null;
          bodyFailure = rpcError(null, -32700, "Parse error");
        }
      }
      const requestId =
        isRecord(value) && isRequestId(value.id) ? value.id : null;
      let ingressLimited: Response | null;
      try {
        ingressLimited = await applyIngressRateLimits(
          principal,
          context,
          requestId,
        );
      } catch (error) {
        return error instanceof RequestDeadlineExceededError
          ? jsonResponse(
              { error: "temporarily_unavailable" },
              503,
              { "retry-after": "1" },
            )
          : jsonResponse({ error: "temporarily_unavailable" }, 503);
      }
      if (ingressLimited !== null) return ingressLimited;
      if (bodyFailure !== null) return bodyFailure;
      if (!isRecord(value) || value.jsonrpc !== "2.0") {
        return rpcError(
          isRecord(value) && isRequestId(value.id) ? value.id : null,
          -32600,
          "Invalid Request",
        );
      }
      if (valueDepth(value, rpcMaximumDepth) > rpcMaximumDepth) {
        return rpcError(
          isRequestId(value.id) ? value.id : null,
          -32602,
          "Request nesting limit exceeded",
        );
      }
      if (typeof value.method !== "string") {
        const isResultResponse =
          isRequestId(value.id) &&
          hasExactKeys(value, ["jsonrpc", "id", "result"]) &&
          isRecord(value.result);
        const isErrorResponse =
          isRequestId(value.id) &&
          hasExactKeys(value, ["jsonrpc", "id", "error"]) &&
          isRecord(value.error) &&
          typeof value.error.code === "number" &&
          Number.isInteger(value.error.code) &&
          typeof value.error.message === "string";
        return (isResultResponse || isErrorResponse) &&
          requestedVersion === mcpProtocolVersion
          ? new Response(null, { status: 202 })
          : rpcError(
              isRequestId(value.id) ? value.id : null,
              -32600,
              "Invalid Request",
            );
      }
      if (
        !hasExactKeys(value, ["jsonrpc", "method"], ["id", "params"]) ||
        (value.params !== undefined && !isRecord(value.params))
      ) {
        return rpcError(
          isRequestId(value.id) ? value.id : null,
          -32600,
          "Invalid Request",
        );
      }
      if (value.id === undefined) {
        return value.method === "initialize" ||
          requestedVersion === mcpProtocolVersion
          ? new Response(null, { status: 202 })
          : rpcError(
              null,
              -32600,
              "MCP-Protocol-Version header required",
              undefined,
              400,
            );
      }
      if (!isRequestId(value.id)) {
        return rpcError(null, -32600, "Invalid Request");
      }
      if (
        value.method !== "initialize" &&
        requestedVersion !== mcpProtocolVersion
      ) {
        return rpcError(
          value.id,
          -32600,
          "MCP-Protocol-Version header required",
          undefined,
          400,
        );
      }
      try {
        return await dispatch(principal, value as RpcRequest, context);
      } catch (error) {
        return error instanceof RequestDeadlineExceededError
          ? rpcError(
              value.id,
              -32001,
              "Request deadline exceeded",
              { code: "TEMPORARILY_UNAVAILABLE" },
              503,
            )
          : rpcError(value.id, -32603, "Internal error", undefined, 500);
      }
    },
  };
}

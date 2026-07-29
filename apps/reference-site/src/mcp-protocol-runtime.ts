import {
  McpReadError,
  mcpContractVersion,
  mcpInitialScope,
  type McpConnectionPrincipal,
  type McpCursorCodec,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

import {
  RequestBodyLimitError,
  hasExactKeys,
  isRecord,
  jsonResponse,
  readBoundedText,
  rpcError,
  rpcResult,
  type RpcRequest,
  valueDepth,
} from "./mcp-http-support";
import {
  McpToolArgumentsError,
  createMcpToolRegistry,
  type McpReadApplication,
} from "./mcp-tool-registry";

export const mcpProtocolVersion = "2025-11-25";

const rpcBodyLimitBytes = 256 * 1024;
const rpcMaximumDepth = 32;

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
    !hasExactKeys(params, [], ["cursor"]) ||
    (params.cursor !== undefined &&
      params.cursor !== null &&
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

  async function paginateDiscovery<Value>({
    principal,
    params,
    query,
    values,
    pageSize,
  }: {
    principal: McpConnectionPrincipal;
    params: unknown;
    query: string;
    values: ReadonlyArray<Value>;
    pageSize: number;
  }): Promise<{
    values: ReadonlyArray<Value>;
    nextCursor: string | null;
  } | null> {
    const cursor = readListCursor(params);
    if (cursor === undefined) return null;
    let offset = 0;
    if (cursor !== null) {
      try {
        const binding = await cursors.decode(cursor);
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
      } catch {
        return null;
      }
    }
    const page = values.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      values: page,
      nextCursor:
        nextOffset < values.length
          ? await cursors.encode({
              siteId,
              actorId: principal.actorId,
              query: `discovery:${query}`,
              offset: nextOffset,
            })
          : null,
    };
  }

  async function readResource(
    principal: McpConnectionPrincipal,
    uri: string,
  ) {
    if (uri === "foundry://site") {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(await readApplication.getSite(principal)),
      };
    }
    if (uri === "foundry://schemas/content") {
      return {
        uri,
        mimeType: "application/schema+json",
        text: JSON.stringify(
          await readApplication.getContentSchema(principal),
        ),
      };
    }
    if (uri === "foundry://schemas/design") {
      return {
        uri,
        mimeType: "application/schema+json",
        text: JSON.stringify(
          await readApplication.getDesignSchema(principal),
        ),
      };
    }
    const match = /^foundry:\/\/content\/(page|post)\/([^/]+)$/u.exec(uri);
    if (match !== null) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          await readApplication.getContent(principal, {
            kind: match[1] as "page" | "post",
            contentId: decodeURIComponent(match[2]!),
          }),
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
  ) {
    const tool = tools.get(name);
    if (tool === null) return null;
    try {
      return toolResult(
        await tool.execute(principal, argumentsValue),
        false,
      );
    } catch (error) {
      if (error instanceof McpToolArgumentsError) return null;
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

  async function applyRateLimits(
    principal: McpConnectionPrincipal,
    rpc: RpcRequest,
  ) {
    const windowStartedAt = new Date(
      Math.floor(now().getTime() / 60_000) * 60_000,
    ).toISOString();
    const operation =
      rpc.method === "tools/call" &&
      isRecord(rpc.params) &&
      typeof rpc.params.name === "string"
        ? `${rpc.method}:${rpc.params.name}`
        : rpc.method;
    const [siteBudget, connectionBudget, toolBudget] = await Promise.all([
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
      store.consumeRateLimit({
        siteId,
        bucketKey: `${principal.connectionId}:${operation}`,
        windowStartedAt,
        limit: 120,
      }),
    ]);
    if (siteBudget && connectionBudget && toolBudget) return null;
    const retryAfter = Math.max(1, 60 - now().getUTCSeconds());
    return jsonResponse(
      { error: "rate_limited", retryAfterMs: retryAfter * 1_000 },
      429,
      { "retry-after": String(retryAfter) },
    );
  }

  async function dispatch(
    request: Request,
    principal: McpConnectionPrincipal,
    rpc: RpcRequest,
  ): Promise<Response> {
    const rateLimited = await applyRateLimits(principal, rpc);
    if (rateLimited !== null) return rateLimited;
    if (
      rpc.method !== "initialize" &&
      request.headers.get("mcp-protocol-version") !== mcpProtocolVersion
    ) {
      return rpcError(rpc.id, -32600, "Unsupported MCP protocol version");
    }
    if (rpc.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (rpc.method === "initialize") {
      if (
        !isRecord(rpc.params) ||
        rpc.params.protocolVersion !== mcpProtocolVersion
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
      });
      return page === null
        ? rpcError(rpc.id, -32602, "Invalid pagination cursor")
        : rpcResult(rpc.id, {
            tools: page.values,
            nextCursor: page.nextCursor,
          });
    }
    if (rpc.method === "tools/call") {
      if (
        !isRecord(rpc.params) ||
        !hasExactKeys(rpc.params, ["name", "arguments"]) ||
        typeof rpc.params.name !== "string"
      ) {
        return rpcError(rpc.id, -32602, "Invalid tool arguments");
      }
      const result = await callTool(
        principal,
        rpc.params.name,
        rpc.params.arguments,
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
      const site = await readApplication.getSite(principal);
      const content = await readApplication.listContent(principal, {
        kind: null,
        limit: cursor === null ? 47 : 50,
        cursor,
      });
      return rpcResult(rpc.id, {
        resources: [
          ...(cursor === null
            ? [
                {
                  uri: "foundry://site",
                  name: site.result.displayName,
                  mimeType: "application/json",
                  annotations: { audience: ["user", "assistant"] },
                },
                {
                  uri: "foundry://schemas/content",
                  name: "Content schema",
                  mimeType: "application/schema+json",
                  annotations: { audience: ["user", "assistant"] },
                },
                {
                  uri: "foundry://schemas/design",
                  name: "Design schema",
                  mimeType: "application/schema+json",
                  annotations: { audience: ["user", "assistant"] },
                },
              ]
            : []),
          ...content.result.items.map((item) => ({
            uri: `foundry://content/${item.kind}/${encodeURIComponent(item.contentId)}`,
            name: item.title,
            mimeType: "application/json",
            annotations: { audience: ["user", "assistant"] },
            _meta: {
              contentHash: item.contentHash,
              liveGitSha: item.liveGitSha,
              lastModified: item.lastModified,
            },
          })),
        ],
        nextCursor: content.result.nextCursor,
      });
    }
    if (rpc.method === "resources/templates/list") {
      const page = await paginateDiscovery({
        principal,
        params: rpc.params,
        query: "resource-templates",
        values: [
          {
            uriTemplate: "foundry://content/{kind}/{contentId}",
            name: "Published content",
            mimeType: "application/json",
            annotations: { audience: ["user", "assistant"] },
          },
        ],
        pageSize: 50,
      });
      return page === null
        ? rpcError(rpc.id, -32602, "Invalid pagination cursor")
        : rpcResult(rpc.id, {
            resourceTemplates: page.values,
            nextCursor: page.nextCursor,
          });
    }
    if (rpc.method === "resources/read") {
      if (
        !isRecord(rpc.params) ||
        !hasExactKeys(rpc.params, ["uri"]) ||
        typeof rpc.params.uri !== "string"
      ) {
        return rpcError(rpc.id, -32602, "Invalid resource request");
      }
      try {
        return rpcResult(rpc.id, {
          contents: [await readResource(principal, rpc.params.uri)],
        });
      } catch (error) {
        if (error instanceof McpReadError) {
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
      });
      return page === null
        ? rpcError(rpc.id, -32602, "Invalid pagination cursor")
        : rpcResult(rpc.id, {
            prompts: page.values,
            nextCursor: page.nextCursor,
          });
    }
    return rpcError(rpc.id, -32601, "Method not found");
  }

  return {
    async handle(
      request: Request,
      principal: McpConnectionPrincipal,
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
      let value: unknown;
      try {
        value = JSON.parse(await readBoundedText(request, rpcBodyLimitBytes));
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          return jsonResponse({ error: "request_too_large" }, 413);
        }
        return rpcError(null, -32700, "Parse error");
      }
      if (
        !isRecord(value) ||
        value.jsonrpc !== "2.0" ||
        typeof value.method !== "string" ||
        !hasExactKeys(value, ["jsonrpc", "method"], ["id", "params"])
      ) {
        return rpcError(null, -32600, "Invalid Request");
      }
      if (valueDepth(value, rpcMaximumDepth) > rpcMaximumDepth) {
        return rpcError(
          typeof value.id === "string" ||
            typeof value.id === "number" ||
            value.id === null
            ? value.id
            : null,
          -32602,
          "Request nesting limit exceeded",
        );
      }
      return dispatch(request, principal, value as RpcRequest);
    },
  };
}

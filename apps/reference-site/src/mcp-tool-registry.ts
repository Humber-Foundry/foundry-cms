import {
  mcpContractVersion,
  type McpConnectionPrincipal,
  type McpExecutionContext,
  type createMcpReadApplication,
} from "@foundry/application";
import { siteDefinitionSchema } from "@foundry/site-definition";

import { hasExactKeys, isRecord } from "./mcp-http-support";

export type McpReadApplication = ReturnType<
  typeof createMcpReadApplication
>;

function toolOutputSchema(result: unknown) {
  const meta = {
    type: "object",
    additionalProperties: false,
    properties: {
      replayed: { const: false },
      observedAt: { type: "string", format: "date-time" },
    },
    required: ["replayed", "observedAt"],
  };
  return {
    type: "object",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          contractVersion: { const: mcpContractVersion },
          invocationId: { type: "string", minLength: 1 },
          result,
          meta,
        },
        required: ["contractVersion", "invocationId", "result", "meta"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          contractVersion: { const: mcpContractVersion },
          invocationId: { type: "string", minLength: 1 },
          error: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: {
                enum: [
                  "AUTHENTICATION_REQUIRED",
                  "INSUFFICIENT_SCOPE",
                  "CONNECTION_REVOKED",
                  "OBJECT_NOT_FOUND",
                  "VALIDATION_FAILED",
                  "TEMPORARILY_UNAVAILABLE",
                ],
              },
              message: { type: "string" },
              retryable: { type: "boolean" },
              requiredScopes: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: [
              "code",
              "message",
              "retryable",
              "requiredScopes",
            ],
          },
          meta,
        },
        required: ["contractVersion", "invocationId", "error", "meta"],
      },
    ],
    $defs: siteDefinitionSchema.$defs,
  };
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const taskExecution = { taskSupport: "forbidden" } as const;

const descriptors = {
  "foundry.site.get": {
    name: "foundry.site.get",
    description: "Read this connection's site metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: toolOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        siteId: { type: "string" },
        displayName: { type: "string" },
        canonicalUrl: { type: "string", format: "uri" },
        locale: { type: "string" },
        timeZone: { type: "string" },
        schemaVersion: { type: "string" },
        liveRelease: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                gitSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
                releaseId: { type: "string" },
                observedAt: { type: "string", format: "date-time" },
              },
              required: ["gitSha", "releaseId", "observedAt"],
            },
            { type: "null" },
          ],
        },
      },
      required: [
        "siteId",
        "displayName",
        "canonicalUrl",
        "locale",
        "timeZone",
        "schemaVersion",
        "liveRelease",
      ],
    }),
    annotations,
    execution: taskExecution,
  },
  "foundry.content.list": {
    name: "foundry.content.list",
    description:
      "List published page and post documents with bounded pagination.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { anyOf: [{ enum: ["page", "post"] }, { type: "null" }] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["kind", "limit", "cursor"],
    },
    outputSchema: toolOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { enum: ["page", "post"] },
              contentId: { type: "string" },
              title: { type: "string" },
              revision: {
                anyOf: [
                  { type: "integer", minimum: 0 },
                  { type: "null" },
                ],
              },
              contentHash: {
                type: "string",
                pattern: "^[0-9a-f]{64}$",
              },
              liveGitSha: {
                anyOf: [
                  { type: "string", pattern: "^[0-9a-f]{40}$" },
                  { type: "null" },
                ],
              },
              lastModified: {
                anyOf: [
                  { type: "string", format: "date-time" },
                  { type: "null" },
                ],
              },
            },
            required: [
              "kind",
              "contentId",
              "title",
              "revision",
              "contentHash",
              "liveGitSha",
              "lastModified",
            ],
          },
        },
        nextCursor: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
      required: ["items", "nextCursor"],
    }),
    annotations,
    execution: taskExecution,
  },
  "foundry.content.get": {
    name: "foundry.content.get",
    description: "Read one published page or post document.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["page", "post"] },
        contentId: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["kind", "contentId"],
    },
    outputSchema: toolOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["page", "post"] },
        contentId: { type: "string" },
        revision: {
          anyOf: [
            { type: "integer", minimum: 0 },
            { type: "null" },
          ],
        },
        contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        liveGitSha: {
          anyOf: [
            { type: "string", pattern: "^[0-9a-f]{40}$" },
            { type: "null" },
          ],
        },
        lastModified: {
          anyOf: [
            { type: "string", format: "date-time" },
            { type: "null" },
          ],
        },
        document: {
          oneOf: [
            siteDefinitionSchema.properties.home,
            siteDefinitionSchema.$defs.blogPost,
          ],
        },
      },
      required: [
        "kind",
        "contentId",
        "revision",
        "contentHash",
        "liveGitSha",
        "lastModified",
        "document",
      ],
    }),
    annotations,
    execution: taskExecution,
  },
} as const;

export function createMcpToolRegistry(application: McpReadApplication) {
  const handlers = {
    "foundry.site.get": async (
      principal: McpConnectionPrincipal,
      input: unknown,
      context: McpExecutionContext,
    ) => {
      if (!isRecord(input) || !hasExactKeys(input, [])) {
        return application.rejectInvalidInput(
          principal,
          "foundry.site.get",
          input,
          context,
        );
      }
      return application.getSite(principal, context);
    },
    "foundry.content.list": async (
      principal: McpConnectionPrincipal,
      input: unknown,
      context: McpExecutionContext,
    ) => {
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["kind", "limit", "cursor"]) ||
        (input.kind !== null &&
          input.kind !== "page" &&
          input.kind !== "post") ||
        typeof input.limit !== "number" ||
        (input.cursor !== null && typeof input.cursor !== "string")
      ) {
        return application.rejectInvalidInput(
          principal,
          "foundry.content.list",
          input,
          context,
        );
      }
      return application.listContent(principal, {
        kind: input.kind,
        limit: input.limit,
        cursor: input.cursor,
      }, context);
    },
    "foundry.content.get": async (
      principal: McpConnectionPrincipal,
      input: unknown,
      context: McpExecutionContext,
    ) => {
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["kind", "contentId"]) ||
        (input.kind !== "page" && input.kind !== "post") ||
        typeof input.contentId !== "string" ||
        input.contentId.length < 1 ||
        input.contentId.length > 200
      ) {
        return application.rejectInvalidInput(
          principal,
          "foundry.content.get",
          input,
          context,
        );
      }
      return application.getContent(principal, {
        kind: input.kind,
        contentId: input.contentId,
      }, context);
    },
  } satisfies Record<
    keyof typeof descriptors,
    (
      principal: McpConnectionPrincipal,
      input: unknown,
      context: McpExecutionContext,
    ) => Promise<unknown>
  >;

  return {
    list() {
      return Object.values(descriptors);
    },
    get(name: string) {
      if (!Object.hasOwn(handlers, name)) return null;
      const toolName = name as keyof typeof handlers;
      return {
        descriptor: descriptors[toolName],
        execute: handlers[toolName],
      };
    },
  };
}

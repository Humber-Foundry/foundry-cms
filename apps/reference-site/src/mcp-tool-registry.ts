import {
  mcpContractVersion,
  type McpConnectionPrincipal,
  type createMcpReadApplication,
} from "@foundry/application";
import { siteDefinitionSchema } from "@foundry/site-definition";

import { hasExactKeys, isRecord } from "./mcp-http-support";

export type McpReadApplication = ReturnType<
  typeof createMcpReadApplication
>;

export class McpToolArgumentsError extends Error {}

function successOutputSchema(result: unknown) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      contractVersion: { const: mcpContractVersion },
      invocationId: { type: "string", minLength: 1 },
      result,
      meta: {
        type: "object",
        additionalProperties: false,
        properties: {
          replayed: { const: false },
          observedAt: { type: "string", format: "date-time" },
        },
        required: ["replayed", "observedAt"],
      },
    },
    required: ["contractVersion", "invocationId", "result", "meta"],
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
    outputSchema: successOutputSchema({
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
    outputSchema: successOutputSchema({
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
    outputSchema: successOutputSchema({
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
    ) => {
      if (!isRecord(input) || !hasExactKeys(input, [])) {
        throw new McpToolArgumentsError();
      }
      return application.getSite(principal);
    },
    "foundry.content.list": async (
      principal: McpConnectionPrincipal,
      input: unknown,
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
        throw new McpToolArgumentsError();
      }
      return application.listContent(principal, {
        kind: input.kind,
        limit: input.limit,
        cursor: input.cursor,
      });
    },
    "foundry.content.get": async (
      principal: McpConnectionPrincipal,
      input: unknown,
    ) => {
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["kind", "contentId"]) ||
        (input.kind !== "page" && input.kind !== "post") ||
        typeof input.contentId !== "string" ||
        input.contentId.length < 1 ||
        input.contentId.length > 200
      ) {
        throw new McpToolArgumentsError();
      }
      return application.getContent(principal, {
        kind: input.kind,
        contentId: input.contentId,
      });
    },
  } satisfies Record<
    keyof typeof descriptors,
    (principal: McpConnectionPrincipal, input: unknown) => Promise<unknown>
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

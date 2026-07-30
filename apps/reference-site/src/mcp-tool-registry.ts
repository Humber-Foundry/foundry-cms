import {
  createContentWorkspaceId,
  mcpContentDraftScope,
  mcpContractVersion,
  mcpDesignDraftScope,
  mcpPublicationPublishScope,
  mcpPublicationScheduleScope,
  type McpContentPatchOperation,
  type McpConnectionPrincipal,
  type McpExecutionContext,
  type createMcpDraftApplication,
  type createMcpPublicationApplication,
  type createMcpReadApplication,
} from "@foundry/application";
import {
  designContract,
  listEditableSiteFields,
  referenceSiteDefinition,
  siteDefinitionSchema,
  type RichTextDocument,
} from "@foundry/site-definition";

import { hasExactKeys, isRecord } from "./mcp-http-support";

export type McpReadApplication = ReturnType<
  typeof createMcpReadApplication
> &
  Partial<ReturnType<typeof createMcpDraftApplication>> &
  Partial<ReturnType<typeof createMcpPublicationApplication>>;

function toolOutputSchema(result: unknown) {
  const meta = {
    type: "object",
    additionalProperties: false,
    properties: {
      replayed: { type: "boolean" },
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
                  "STALE_REVISION",
                  "IDEMPOTENCY_KEY_REUSED",
                  "APPROVAL_REQUIRED",
                  "APPROVAL_STALE",
                  "WRONG_ARTIFACT_KIND",
                  "PUBLICATION_BUSY",
                  "RESULT_UNKNOWN",
                  "TEMPORARILY_UNAVAILABLE",
                ],
              },
              message: { type: "string" },
              retryable: { type: "boolean" },
              requiredScopes: {
                type: "array",
                items: { type: "string" },
              },
              latestRevision: {
                type: ["integer", "null"],
                minimum: 0,
              },
              conflictResource: {
                type: ["string", "null"],
                format: "uri-reference",
              },
            },
            required: [
              "code",
              "message",
              "retryable",
              "requiredScopes",
              "latestRevision",
              "conflictResource",
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
  openWorldHint: false,
} as const;

const taskExecution = { taskSupport: "forbidden" } as const;

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const nonDestructiveMutationAnnotations = {
  ...mutationAnnotations,
  destructiveHint: false,
} as const;

const publicationMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const idempotencyKeySchema = {
  type: "string",
  format: "uuid",
} as const;

const workspaceIdSchema = {
  type: "string",
  pattern: "^workspace_[a-z0-9_]+$",
} as const;

const approvalIdSchema = {
  type: "string",
  pattern: "^approval_[a-f0-9]{32}$",
} as const;

const scheduleIdPattern =
  "schedule_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const scheduleIdSchema = {
  type: "string",
  pattern: `^${scheduleIdPattern}$`,
} as const;

// A status read names either a publication or a blog schedule. Constraining
// the shape here keeps a malformed identifier a terminal validation failure
// rather than a retryable error raised from an identifier constructor deeper
// in the application layer.
const operationIdSchema = {
  type: "string",
  pattern: `^(publish_[a-f0-9]{32}|${scheduleIdPattern})$`,
} as const;

const publicationOperationResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    operationId: { type: "string", minLength: 1, maxLength: 200 },
    state: { type: "string", minLength: 1, maxLength: 100 },
    statusResource: { type: "string", format: "uri-reference" },
    replayed: { type: "boolean" },
  },
  required: ["operationId", "state", "statusResource", "replayed"],
} as const;

const contentFields = listEditableSiteFields(referenceSiteDefinition)
  .filter(({ group }) => group !== "Design");
const contentFieldPaths = contentFields.map(({ path }) => path);
const plainTextContentFieldPaths = contentFields
  .filter(({ format }) => format === "plainText")
  .map(({ path }) => path);
const richTextContentFieldPaths = contentFields
  .filter(({ format }) => format === "richText")
  .map(({ path }) => path);
const designVariantContracts =
  referenceSiteDefinition.home.sections.map(({ id, type }) => ({
    componentId: id,
    values: designContract.variants[type].values,
  }));
const draftResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspaceId: { type: "string", pattern: "^workspace_[a-z0-9_]+$" },
    revision: { type: "integer", minimum: 0 },
    contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    schemaVersion: { type: "string" },
    validation: {
      type: "object",
      additionalProperties: false,
      properties: {
        valid: { const: true },
        issues: { type: "array", maxItems: 0 },
      },
      required: ["valid", "issues"],
    },
  },
  required: [
    "workspaceId",
    "revision",
    "contentHash",
    "schemaVersion",
    "validation",
  ],
} as const;
const draftMutationResult = {
  ...draftResult,
  properties: {
    ...draftResult.properties,
    replayed: { type: "boolean" },
  },
  required: [...draftResult.required, "replayed"],
} as const;
const canonicalDefinitionResult = {
  type: "object",
  additionalProperties: false,
  properties: siteDefinitionSchema.properties,
  required: siteDefinitionSchema.required,
} as const;
const canonicalRevisionResult = {
  ...draftResult,
  properties: {
    ...draftResult.properties,
    definition: canonicalDefinitionResult,
    rendererVersion: { type: "string", minLength: 1 },
    productionBase: {
      type: "string",
      pattern:
        "^git:(?:[0-9a-f]{40}|[0-9a-f]{64})@content:[0-9a-f]{64}$",
    },
    createdAt: { type: "string", format: "date-time" },
    createdBy: { type: "string", minLength: 1 },
  },
  required: [
    ...draftResult.required,
    "definition",
    "rendererVersion",
    "productionBase",
    "createdAt",
    "createdBy",
  ],
} as const;
const workspaceResourceResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspaceId: workspaceIdSchema,
    manifest: {
      type: "object",
      additionalProperties: false,
      properties: {
        siteId: { type: "string", pattern: "^site_[a-z0-9_]+$" },
        schemaVersion: { type: "string" },
        rendererVersion: { type: "string", minLength: 1 },
        productionBase: {
          type: "string",
          pattern:
            "^git:(?:[0-9a-f]{40}|[0-9a-f]{64})@content:[0-9a-f]{64}$",
        },
      },
      required: [
        "siteId",
        "schemaVersion",
        "rendererVersion",
        "productionBase",
      ],
    },
    base: canonicalRevisionResult,
    current: canonicalRevisionResult,
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { const: "draft" },
        baseRevision: { type: "integer", minimum: 0 },
        currentRevision: { type: "integer", minimum: 0 },
        contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      required: [
        "status",
        "baseRevision",
        "currentRevision",
        "contentHash",
      ],
    },
  },
  required: ["workspaceId", "manifest", "base", "current", "state"],
} as const;

function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      .test(value)
  );
}

function parseWorkspaceMutation(
  input: unknown,
  operationsRequired: boolean,
) {
  if (
    !isRecord(input) ||
    !hasExactKeys(
      input,
      ["workspaceId", "expectedRevision", "idempotencyKey"],
      operationsRequired ? ["operations"] : [],
    ) ||
    typeof input.workspaceId !== "string" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 0 ||
    !validIdempotencyKey(input.idempotencyKey)
  ) {
    return null;
  }
  try {
    return {
      workspaceId: createContentWorkspaceId(input.workspaceId),
      expectedRevision: input.expectedRevision as number,
      idempotencyKey: input.idempotencyKey,
    };
  } catch {
    return null;
  }
}

function parsePatchInput(input: unknown) {
  const common = parseWorkspaceMutation(input, true);
  if (
    common === null ||
    !isRecord(input) ||
    !Array.isArray(input.operations) ||
    input.operations.length < 1 ||
    input.operations.length > 100
  ) {
    return null;
  }
  const operations: McpContentPatchOperation[] = [];
  for (const operation of input.operations) {
    if (
      !isRecord(operation) ||
      !hasExactKeys(operation, ["op", "field", "value"], ["format"]) ||
      operation.op !== "set" ||
      typeof operation.field !== "string" ||
      !contentFieldPaths.includes(operation.field) ||
      (operation.format !== undefined &&
        operation.format !== "plainText" &&
        operation.format !== "richText")
    ) {
      continue;
    }
    const contract = contentFields.find(
      ({ path }) => path === operation.field,
    )!;
    if (
      contract.format === "plainText" &&
      (operation.format === undefined ||
        operation.format === "plainText") &&
      typeof operation.value === "string" &&
      operation.value.length >= 1 &&
      operation.value.length <= 200_000
    ) {
      operations.push({
        op: "set",
        field: operation.field,
        value: operation.value,
        ...(operation.format === undefined
          ? {}
          : { format: "plainText" as const }),
      });
      continue;
    }
    if (
      contract.format === "richText" &&
      operation.format === "richText" &&
      isRecord(operation.value)
    ) {
      operations.push({
        op: "set",
        field: operation.field,
        value: operation.value as RichTextDocument,
        format: "richText" as const,
      });
    }
  }
  return operations.length === input.operations.length
    ? { ...common, operations }
    : null;
}

function parseDesignPatchInput(input: unknown) {
  const common = parseWorkspaceMutation(input, true);
  if (
    common === null ||
    !isRecord(input) ||
    !Array.isArray(input.operations) ||
    input.operations.length < 1 ||
    input.operations.length > 100
  ) {
    return null;
  }
  const operations: Array<
    | Readonly<{
        op: "set_token";
        token: keyof typeof designContract.tokens;
        value: string;
      }>
    | Readonly<{
        op: "set_variant";
        componentId: string;
        value: string;
      }>
  > = [];
  for (const operation of input.operations) {
    if (!isRecord(operation) || typeof operation.op !== "string") {
      continue;
    }
    if (
      operation.op === "set_token" &&
      hasExactKeys(operation, ["op", "token", "value"]) &&
      typeof operation.token === "string" &&
      Object.hasOwn(designContract.tokens, operation.token) &&
      typeof operation.value === "string"
    ) {
      operations.push({
        op: "set_token" as const,
        token: operation.token as keyof typeof designContract.tokens,
        value: operation.value,
      });
      continue;
    }
    if (
      operation.op === "set_variant" &&
      hasExactKeys(operation, ["op", "componentId", "value"]) &&
      typeof operation.componentId === "string" &&
      typeof operation.value === "string" &&
      designVariantContracts.some(
        ({ componentId, values }) =>
          componentId === operation.componentId &&
          values.includes(operation.value as never),
      )
    ) {
      operations.push({
        op: "set_variant" as const,
        componentId: operation.componentId,
        value: operation.value,
      });
    }
  }
  return operations.length === input.operations.length
    ? { ...common, operations }
    : null;
}

function parsePublicationInput(
  input: unknown,
  mode: "request" | "schedule",
) {
  const required = [
    "workspaceId",
    "revision",
    "approvalId",
    "idempotencyKey",
    ...(mode === "schedule"
      ? ["publishAt", "reportingTimeZone"]
      : []),
  ];
  if (
    !isRecord(input) ||
    !hasExactKeys(input, required) ||
    typeof input.workspaceId !== "string" ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 0 ||
    typeof input.approvalId !== "string" ||
    !/^approval_[a-f0-9]{32}$/u.test(input.approvalId) ||
    !validIdempotencyKey(input.idempotencyKey) ||
    (mode === "schedule" &&
      (
        typeof input.publishAt !== "string" ||
        typeof input.reportingTimeZone !== "string" ||
        input.reportingTimeZone.length < 1 ||
        input.reportingTimeZone.length > 100
      ))
  ) {
    return null;
  }
  try {
    return {
      workspaceId: createContentWorkspaceId(input.workspaceId),
      revision: input.revision as number,
      approvalId: input.approvalId,
      idempotencyKey: input.idempotencyKey,
      ...(mode === "schedule"
        ? {
            publishAt: input.publishAt as string,
            reportingTimeZone: input.reportingTimeZone as string,
          }
        : {}),
    };
  } catch {
    return null;
  }
}

function parsePublicationStatus(input: unknown) {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["workspaceId", "revision", "operationId"]) ||
    typeof input.workspaceId !== "string" ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 0 ||
    typeof input.operationId !== "string" ||
    input.operationId.length < 1 ||
    input.operationId.length > 200
  ) {
    return null;
  }
  try {
    return {
      workspaceId: createContentWorkspaceId(input.workspaceId),
      revision: input.revision as number,
      operationId: input.operationId,
    };
  } catch {
    return null;
  }
}

function parsePublicationCancel(input: unknown) {
  if (
    !isRecord(input) ||
    !hasExactKeys(
      input,
      ["workspaceId", "revision", "scheduleId", "idempotencyKey"],
    ) ||
    typeof input.workspaceId !== "string" ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 0 ||
    typeof input.scheduleId !== "string" ||
    input.scheduleId.length < 1 ||
    input.scheduleId.length > 200 ||
    !validIdempotencyKey(input.idempotencyKey)
  ) {
    return null;
  }
  try {
    return {
      workspaceId: createContentWorkspaceId(input.workspaceId),
      revision: input.revision as number,
      scheduleId: input.scheduleId,
      idempotencyKey: input.idempotencyKey,
    };
  } catch {
    return null;
  }
}

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
  "foundry.workspace.open": {
    name: "foundry.workspace.open",
    description:
      "Open one site-scoped canonical draft workspace at revision zero.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        expectedRevision: { const: 0 },
        idempotencyKey: idempotencyKeySchema,
      },
      required: ["expectedRevision", "idempotencyKey"],
    },
    outputSchema: toolOutputSchema(draftMutationResult),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.workspace.get": {
    name: "foundry.workspace.get",
    description: "Read an authorized site-scoped draft workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
      },
      required: ["workspaceId"],
    },
    outputSchema: toolOutputSchema(workspaceResourceResult),
    annotations,
    execution: taskExecution,
  },
  "foundry.content.patch": {
    name: "foundry.content.patch",
    description:
      "Apply allowlisted content field edits to a new immutable revision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "set" },
                  field: { enum: plainTextContentFieldPaths },
                  format: { const: "plainText" },
                  value: {
                    type: "string",
                    minLength: 1,
                    maxLength: 200000,
                  },
                },
                required: ["op", "field", "value"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "set" },
                  field: { enum: richTextContentFieldPaths },
                  format: { const: "richText" },
                  value: { $ref: "#/$defs/richTextDocument" },
                },
                required: ["op", "field", "format", "value"],
              },
            ],
          },
        },
      },
      required: [
        "workspaceId",
        "expectedRevision",
        "idempotencyKey",
        "operations",
      ],
      $defs: siteDefinitionSchema.$defs,
    },
    outputSchema: toolOutputSchema({
      ...draftMutationResult,
      properties: {
        ...draftMutationResult.properties,
        previewArtifact: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
        },
      },
      required: [...draftMutationResult.required, "previewArtifact"],
    }),
    annotations: mutationAnnotations,
    execution: taskExecution,
  },
  "foundry.design.patch": {
    name: "foundry.design.patch",
    description:
      "Apply registered design tokens or component variants to a new immutable revision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: [
              ...Object.entries(designContract.tokens).map(
                ([token, contract]) => ({
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    op: { const: "set_token" },
                    token: { const: token },
                    value: { enum: [...contract.values] },
                  },
                  required: ["op", "token", "value"],
                }),
              ),
              ...designVariantContracts.map(
                ({ componentId, values }) => ({
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    op: { const: "set_variant" },
                    componentId: { const: componentId },
                    value: { enum: [...values] },
                  },
                  required: ["op", "componentId", "value"],
                }),
              ),
            ],
          },
        },
      },
      required: [
        "workspaceId",
        "expectedRevision",
        "idempotencyKey",
        "operations",
      ],
    },
    outputSchema: toolOutputSchema({
      ...draftMutationResult,
      properties: {
        ...draftMutationResult.properties,
        previewArtifact: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
        },
      },
      required: [...draftMutationResult.required, "previewArtifact"],
    }),
    annotations: mutationAnnotations,
    execution: taskExecution,
  },
  "foundry.preview.prepare": {
    name: "foundry.preview.prepare",
    description:
      "Prepare an immutable canonical preview and a human review URL without creating approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
      },
      required: [
        "workspaceId",
        "expectedRevision",
        "idempotencyKey",
      ],
    },
    outputSchema: toolOutputSchema({
      ...draftResult,
      properties: {
        ...draftResult.properties,
        previewId: { type: "string", minLength: 1, maxLength: 200 },
        previewArtifact: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
        },
        approvalStatus: { const: "pending_human_review" },
        replayed: { type: "boolean" },
        humanReviewUrl: { type: "string", format: "uri" },
      },
      required: [
        ...draftResult.required,
        "previewId",
        "previewArtifact",
        "approvalStatus",
        "replayed",
        "humanReviewUrl",
      ],
    }),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.publication.request": {
    name: "foundry.publication.request",
    description:
      "Publish one exact approved workspace revision through the canonical publication pipeline.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        revision: { type: "integer", minimum: 0 },
        approvalId: approvalIdSchema,
        idempotencyKey: idempotencyKeySchema,
      },
      required: [
        "workspaceId",
        "revision",
        "approvalId",
        "idempotencyKey",
      ],
    },
    outputSchema: toolOutputSchema(publicationOperationResult),
    annotations: publicationMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.publication.schedule": {
    name: "foundry.publication.schedule",
    description:
      "Schedule one exact approved blog revision through the canonical scheduler.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        revision: { type: "integer", minimum: 0 },
        approvalId: approvalIdSchema,
        publishAt: { type: "string", format: "date-time" },
        reportingTimeZone: {
          type: "string",
          minLength: 1,
          maxLength: 100,
        },
        idempotencyKey: idempotencyKeySchema,
      },
      required: [
        "workspaceId",
        "revision",
        "approvalId",
        "publishAt",
        "reportingTimeZone",
        "idempotencyKey",
      ],
    },
    outputSchema: toolOutputSchema(publicationOperationResult),
    annotations: publicationMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.publication.status": {
    name: "foundry.publication.status",
    description:
      "Read the current state of a publication or publication schedule.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        revision: { type: "integer", minimum: 0 },
        operationId: operationIdSchema,
      },
      required: ["workspaceId", "revision", "operationId"],
    },
    outputSchema: toolOutputSchema(publicationOperationResult),
    annotations,
    execution: taskExecution,
  },
  "foundry.publication.cancel": {
    name: "foundry.publication.cancel",
    description: "Cancel one active publication schedule.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        revision: { type: "integer", minimum: 0 },
        scheduleId: scheduleIdSchema,
        idempotencyKey: idempotencyKeySchema,
      },
      required: [
        "workspaceId",
        "revision",
        "scheduleId",
        "idempotencyKey",
      ],
    },
    outputSchema: toolOutputSchema(publicationOperationResult),
    annotations: publicationMutationAnnotations,
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
    "foundry.workspace.open": async (principal, input, context) => {
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["expectedRevision", "idempotencyKey"]) ||
        input.expectedRevision !== 0 ||
        !validIdempotencyKey(input.idempotencyKey)
      ) {
        return application.rejectInvalidInput(
          principal,
          "foundry.workspace.open",
          input,
          context,
          [
            principal.scopes.includes(mcpDesignDraftScope)
              ? mcpDesignDraftScope
              : mcpContentDraftScope,
          ],
        );
      }
      return application.openWorkspace!(principal, {
        expectedRevision: 0,
        idempotencyKey: input.idempotencyKey,
      }, context);
    },
    "foundry.workspace.get": async (principal, input, context) => {
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["workspaceId"]) ||
        typeof input.workspaceId !== "string"
      ) {
        return application.rejectInvalidInput(
          principal,
          "foundry.workspace.get",
          input,
          context,
          [
            principal.scopes.includes(mcpDesignDraftScope)
              ? mcpDesignDraftScope
              : mcpContentDraftScope,
          ],
        );
      }
      let workspaceId;
      try {
        workspaceId = createContentWorkspaceId(input.workspaceId);
      } catch {
        return application.rejectInvalidInput(
          principal,
          "foundry.workspace.get",
          input,
          context,
          [
            principal.scopes.includes(mcpDesignDraftScope)
              ? mcpDesignDraftScope
              : mcpContentDraftScope,
          ],
        );
      }
      return application.getWorkspace!(principal, workspaceId, context);
    },
    "foundry.content.patch": async (principal, input, context) => {
      const parsed = parsePatchInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.content.patch",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.patchContent!(principal, parsed, context);
    },
    "foundry.design.patch": async (principal, input, context) => {
      const parsed = parseDesignPatchInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.design.patch",
          input,
          context,
          [mcpDesignDraftScope],
        );
      }
      return application.patchDesign!(principal, parsed, context);
    },
    "foundry.preview.prepare": async (principal, input, context) => {
      const parsed = parseWorkspaceMutation(input, false);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.preview.prepare",
          input,
          context,
          [
            principal.scopes.includes(mcpDesignDraftScope)
              ? mcpDesignDraftScope
              : mcpContentDraftScope,
          ],
        );
      }
      return application.preparePreview!(principal, parsed, context);
    },
    "foundry.publication.request": async (
      principal,
      input,
      context,
    ) => {
      const parsed = parsePublicationInput(input, "request");
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.publication.request",
          input,
          context,
          [mcpPublicationPublishScope],
        );
      }
      return application.requestPublication!(
        principal,
        parsed,
        context,
      );
    },
    "foundry.publication.schedule": async (
      principal,
      input,
      context,
    ) => {
      const parsed = parsePublicationInput(input, "schedule");
      if (
        parsed === null ||
        !("publishAt" in parsed) ||
        !("reportingTimeZone" in parsed)
      ) {
        return application.rejectInvalidInput(
          principal,
          "foundry.publication.schedule",
          input,
          context,
          [mcpPublicationScheduleScope],
        );
      }
      return application.schedulePublication!(
        principal,
        {
          workspaceId: parsed.workspaceId,
          revision: parsed.revision,
          approvalId: parsed.approvalId,
          publishAt: parsed.publishAt!,
          reportingTimeZone: parsed.reportingTimeZone!,
          idempotencyKey: parsed.idempotencyKey,
        },
        context,
      );
    },
    "foundry.publication.status": async (
      principal,
      input,
      context,
    ) => {
      const parsed = parsePublicationStatus(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.publication.status",
          input,
          context,
          [
            principal.scopes.includes(mcpPublicationPublishScope)
              ? mcpPublicationPublishScope
              : mcpPublicationScheduleScope,
          ],
        );
      }
      return application.publicationStatus!(
        principal,
        parsed,
        context,
      );
    },
    "foundry.publication.cancel": async (
      principal,
      input,
      context,
    ) => {
      const parsed = parsePublicationCancel(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.publication.cancel",
          input,
          context,
          [mcpPublicationScheduleScope],
        );
      }
      return application.cancelPublicationSchedule!(
        principal,
        parsed,
        context,
      );
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
    list(principal: McpConnectionPrincipal) {
      const supportsDrafts = application.openWorkspace !== undefined;
      const supportsPublication =
        application.requestPublication !== undefined;
      return Object.entries(descriptors)
        .filter(([name]) => {
          if (
            name.startsWith("foundry.workspace.") ||
            name === "foundry.content.patch" ||
            name === "foundry.design.patch" ||
            name === "foundry.preview.prepare"
          ) {
            if (!supportsDrafts) return false;
          }
          if (name.startsWith("foundry.publication.")) {
            if (!supportsPublication) return false;
            if (name === "foundry.publication.request") {
              return principal.scopes.includes(
                mcpPublicationPublishScope,
              );
            }
            if (
              name === "foundry.publication.schedule" ||
              name === "foundry.publication.cancel"
            ) {
              return principal.scopes.includes(
                mcpPublicationScheduleScope,
              );
            }
            return (
              principal.scopes.includes(mcpPublicationPublishScope) ||
              principal.scopes.includes(mcpPublicationScheduleScope)
            );
          }
          if (
            name === "foundry.workspace.open" ||
            name === "foundry.workspace.get" ||
            name === "foundry.preview.prepare"
          ) {
            return (
              principal.scopes.includes(mcpContentDraftScope) ||
              principal.scopes.includes(mcpDesignDraftScope)
            );
          }
          if (name === "foundry.content.patch") {
            return principal.scopes.includes(mcpContentDraftScope);
          }
          if (name === "foundry.design.patch") {
            return principal.scopes.includes(mcpDesignDraftScope);
          }
          return true;
        })
        .map(([, descriptor]) => descriptor);
    },
    get(name: string) {
      if (!Object.hasOwn(handlers, name)) return null;
      if (
        application.openWorkspace === undefined &&
        (
          name.startsWith("foundry.workspace.") ||
          name === "foundry.content.patch" ||
          name === "foundry.design.patch" ||
          name === "foundry.preview.prepare"
        )
      ) {
        return null;
      }
      if (
        application.requestPublication === undefined &&
        name.startsWith("foundry.publication.")
      ) {
        return null;
      }
      const toolName = name as keyof typeof handlers;
      return {
        descriptor: descriptors[toolName],
        execute: handlers[toolName],
      };
    },
  };
}

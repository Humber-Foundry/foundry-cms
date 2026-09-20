import {
  createCampaignId,
  createContentWorkspaceId,
  mcpAnalyticsReadScope,
  mcpAnalyticsViews,
  mcpCampaignDraftScope,
  mcpCampaignTestScope,
  mcpContentDraftScope,
  mcpContractVersion,
  mcpDesignDraftScope,
  mcpRestructureScopes,
  mcpPublicationPublishScope,
  mcpPublicationScheduleScope,
  type CampaignId,
  type McpAnalyticsView,
  type McpBlogPostContent,
  type McpContentPatchOperation,
  type McpConnectionPrincipal,
  type McpExecutionContext,
  type createMcpAnalyticsApplication,
  type createMcpBlogApplication,
  type createMcpCampaignApplication,
  type createMcpDraftApplication,
  type createMcpPublicationApplication,
  type createMcpReadApplication,
} from "@humber-foundry/application";

import { previewChangeReasonLimit } from "./mcp-preview-review-limits";
import { installedSiteDefinition } from "../foundry/site-definition";
import { installedPageComponentRegistry } from "../foundry/page-components";
import {
  designContract,
  pageCompositionContract,
  campaignShareImageUrlPattern,
  pageSlugMaxLength,
  pageSlugPattern,
  pageStartingLayouts,
  seoShareImageUrlMaxLength,
  siteDefinitionSchema,
  type RichTextDocument,
  type PageSectionOperation,
  type SeoShareImage,
} from "@humber-foundry/site-definition";

import { hasExactKeys, isRecord } from "./mcp-http-support";

export type McpReadApplication = ReturnType<
  typeof createMcpReadApplication
> &
  Partial<ReturnType<typeof createMcpBlogApplication>> &
  Partial<ReturnType<typeof createMcpDraftApplication>> &
  Partial<ReturnType<typeof createMcpPublicationApplication>> &
  Partial<ReturnType<typeof createMcpCampaignApplication>> &
  Partial<ReturnType<typeof createMcpAnalyticsApplication>>;

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
              // The named, machine-readable cause behind this refusal, e.g.
              // `campaign_sender_details_not_configured` — see
              // `McpReadError.reason`. `null` for a refusal with no named
              // reason beyond its `code`.
              reason: { type: ["string", "null"] },
            },
            required: [
              "code",
              "message",
              "retryable",
              "requiredScopes",
              "latestRevision",
              "conflictResource",
              "reason",
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

// A test send reaches an external provider but adds no bulk audience effect and
// deletes nothing, so it is a non-destructive open-world mutation.
const campaignTestAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
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

// The scheduler resolves a publication instant only from a UTC instant with
// optional milliseconds. `format: date-time` also admits offset forms such as
// `+00:00`, which would pass validation and then be refused deeper as an
// invalid instant, so constrain the shape the resolver actually accepts.
const publishAtSchema = {
  type: "string",
  format: "date-time",
  pattern:
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z$",
} as const;

const publishAtShape = new RegExp(publishAtSchema.pattern, "u");

const scheduleIdPattern =
  "schedule_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const scheduleIdSchema = {
  type: "string",
  pattern: `^${scheduleIdPattern}$`,
} as const;

const previewIdPattern =
  "preview_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// A status read names a publication, a blog schedule or a prepared preview.
// Constraining the shape here keeps a malformed identifier a terminal
// validation failure rather than a retryable error raised from an identifier
// constructor deeper in the application layer.
const operationIdSchema = {
  type: "string",
  pattern:
    `^(publish_[a-f0-9]{32}|${scheduleIdPattern}|${previewIdPattern})$`,
} as const;

const publicationOperationResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    operationId: { type: "string", minLength: 1, maxLength: 200 },
    state: { type: "string", minLength: 1, maxLength: 100 },
    replayed: { type: "boolean" },
  },
  required: ["operationId", "state", "replayed"],
} as const;

// A status read of a prepared preview also reports the person's decision.
// `approvalId` appears only after a person approved, and is the approval
// `foundry.publication.request` requires. `reviewNote` is the reason a person
// typed when they asked for changes, so a client renders it as text.
const publicationStatusResult = {
  ...publicationOperationResult,
  properties: {
    ...publicationOperationResult.properties,
    approvalId: approvalIdSchema,
    reviewNote: {
      type: "string",
      minLength: 1,
      maxLength: previewChangeReasonLimit,
    },
  },
} as const;

/**
 * The shape of an editable field path.
 *
 * A path is a chain of identifiers joined by dots, exactly as
 * `listEditableSiteFields` builds it: the record's own id, then the field
 * inside it, with the page id in front on every page but the home page
 * (ADR-0017). The set of paths is not fixed here, because an agent that made
 * a page in a draft must be able to edit that page's fields in the same
 * draft, and the installed definition knows nothing about it. The draft's own
 * field list decides which of these paths is real (ADR-0034).
 */
const editableFieldPathPattern =
  "^[a-z][A-Za-z0-9_]*(?:\\.[a-z][A-Za-z0-9_]*)*$";

/**
 * The longest field path a tool accepts, and the longest plain-text value it
 * accepts. Both are exhaustion bounds; the draft applies the real rules.
 */
const editableFieldPathMaxLength = 300;
const plainTextValueMaxLength = 200_000;

const editableFieldPathShape = new RegExp(editableFieldPathPattern, "u");

const editableFieldPathSchema = {
  type: "string",
  minLength: 1,
  maxLength: editableFieldPathMaxLength,
  pattern: editableFieldPathPattern,
} as const;

function isEditableFieldPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= editableFieldPathMaxLength &&
    editableFieldPathShape.test(value)
  );
}

// A page id and a section id are both ordinary Site Definition identifiers, so
// a hand-written id and a minted `page_<digest>` are both well formed here.
// Whether the draft holds a page or a section with this id is the draft's
// answer, not the schema's.
const definitionIdentifierMaxLength = 200;

const definitionIdentifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: definitionIdentifierMaxLength,
  pattern: siteDefinitionSchema.$defs.id.pattern,
} as const;

const definitionIdentifierShape = new RegExp(
  siteDefinitionSchema.$defs.id.pattern,
  "u",
);

function isDefinitionIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= definitionIdentifierMaxLength &&
    definitionIdentifierShape.test(value)
  );
}

const pageIdSchema = definitionIdentifierSchema;

// A page name is the editable field `<pageId>.title`, so it takes the same
// bound as any other plain-text field edit rather than a second limit.
const pageTitleSchema = {
  type: "string",
  minLength: 1,
  maxLength: plainTextValueMaxLength,
} as const;

// The empty address belongs to the home page, and a reserved address names a
// route the installation already serves. Neither is excluded here: the draft
// refuses both with a sentence that says which rule was broken and carries a
// named reason, which a bare schema mismatch could not (ADR-0033).
const pageSlugSchema = {
  type: "string",
  maxLength: pageSlugMaxLength,
  pattern: pageSlugPattern,
} as const;

const pageSlugShape = new RegExp(pageSlugPattern, "u");

const pageStartingLayoutSchema = {
  enum: pageStartingLayouts.map(({ id }) => id),
} as const;

/**
 * How a design command names one section.
 *
 * It is the section's own id on the home page, and the page id followed by the
 * section id on every other page, which is the shape a section's editable
 * field path has (ADR-0017). The tool no longer advertises a closed list of
 * section ids: a list built at module load can only describe the installed
 * site, so it could not name a section on a page an agent made inside a draft.
 * The draft's own design field list answers whether the section is real, the
 * same way it already answered whether the value is registered. See ADR-0035.
 */
const designComponentIdSchema = editableFieldPathSchema;

/**
 * Every section style any registered section offers, sorted and without
 * repetition. The schema says which words are section styles at all; which of
 * them one section offers is the draft's answer.
 */
const designVariantValues: ReadonlyArray<string> = [
  ...new Set(
    Object.values(designContract.variants).flatMap(({ values }) => [
      ...(values as ReadonlyArray<string>),
    ]),
  ),
].sort();

/**
 * The bounds a restructure request is held to before the draft sees it.
 *
 * A page holds at most `pageCompositionContract.slot.maxItems` sections, so a
 * position beyond that can never be right, and a request that carries more
 * operations than that could not leave a page the draft would accept.
 */
const sectionPositionSchema = {
  type: "integer",
  minimum: 0,
  maximum: pageCompositionContract.slot.maxItems,
} as const;

const sectionIdSchema = definitionIdentifierSchema;

const sectionTypeSchema = {
  enum: [...installedPageComponentRegistry.allowedComponents],
} as const;

const sectionVariantSchema = { enum: designVariantValues } as const;

/**
 * The most section operations one request may carry. A page holds at most
 * twelve sections, so twice that is more than enough to rebuild a page from
 * nothing in one request, and it bounds the work a single call can ask for.
 */
const sectionOperationLimit = pageCompositionContract.slot.maxItems * 2;
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
/**
 * What a page tool gives back. It is the draft mutation result with the page
 * the operation acted on: the new page for a create or a duplicate, the named
 * page for a rename or a delete.
 */
const pageMutationResult = {
  ...draftMutationResult,
  properties: {
    ...draftMutationResult.properties,
    pageId: pageIdSchema,
    previewArtifact: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
  required: [...draftMutationResult.required, "pageId", "previewArtifact"],
} as const;
/**
 * What an agent writes into one blog post. It is the Site Definition's own
 * blog post shape, minus the three fields the blog owns rather than the
 * writer: the post's id, its revision number and whether it is on the site. A
 * post's tags are `seo.keywords`, which is where the blog keeps them.
 *
 * Every picture in a post has to be one of this site's own photos. That is
 * the draft's answer, not the schema's, so the refusal names the address it
 * turned down. See ADR-0036.
 */
const blogPostContentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    slug: siteDefinitionSchema.$defs.blogPost.properties.slug,
    title: { $ref: "#/$defs/text" },
    excerpt: { $ref: "#/$defs/text" },
    seo: { $ref: "#/$defs/seoMetadata" },
    mainImage: siteDefinitionSchema.$defs.blogPost.properties.mainImage,
    body: { $ref: "#/$defs/richTextDocument" },
  },
  required: ["slug", "title", "excerpt", "seo", "mainImage", "body"],
} as const;

const blogPostIdSchema = siteDefinitionSchema.$defs.blogPost.properties.id;

const blogPostIdShape = new RegExp(blogPostIdSchema.pattern, "u");

function isBlogPostId(value: unknown): value is string {
  return typeof value === "string" && blogPostIdShape.test(value);
}

/**
 * What a blog post write gives back: the draft mutation result with the post
 * the write acted on.
 */
const blogPostMutationResult = {
  ...draftMutationResult,
  properties: {
    ...draftMutationResult.properties,
    postId: blogPostIdSchema,
    previewArtifact: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
  required: [...draftMutationResult.required, "postId", "previewArtifact"],
} as const;

/** What a blog command outside the draft takes: one post and one retry key. */
const blogPostCommandInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    postId: blogPostIdSchema,
    idempotencyKey: idempotencyKeySchema,
  },
  required: ["postId", "idempotencyKey"],
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
      !isEditableFieldPath(operation.field) ||
      (operation.format !== undefined &&
        operation.format !== "plainText" &&
        operation.format !== "richText")
    ) {
      continue;
    }
    // The format the caller declared decides how the value is read. The draft
    // then checks that this field really takes that format, and refuses the
    // edit if it does not, so nothing here has to know the field list.
    if (
      operation.format !== "richText" &&
      typeof operation.value === "string" &&
      operation.value.length >= 1 &&
      operation.value.length <= plainTextValueMaxLength
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
    if (operation.format === "richText" && isRecord(operation.value)) {
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

/**
 * Read the three things every page tool takes, and nothing else. `extraKeys`
 * names the fields this particular operation adds, so a key that belongs to
 * another page tool is rejected rather than ignored.
 */
/**
 * Read one blog post's content, or answer `null`.
 *
 * The exact field set is the Site Definition's own blog post shape. Whether
 * the pictures it names are this site's photos, and whether the rich text is
 * canonical, are the draft's answers, so they are checked there and refused
 * with a named reason.
 */
function parseBlogPostContent(value: unknown): McpBlogPostContent | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "slug",
      "title",
      "excerpt",
      "seo",
      "mainImage",
      "body",
    ]) ||
    typeof value.slug !== "string" ||
    typeof value.title !== "string" ||
    typeof value.excerpt !== "string" ||
    !isRecord(value.seo) ||
    !isRecord(value.body) ||
    (value.mainImage !== null && !isRecord(value.mainImage))
  ) {
    return null;
  }
  return value as unknown as McpBlogPostContent;
}

function parseCreateBlogPostInput(input: unknown) {
  const common = parsePageMutationInput(input, ["post"]);
  if (common === null || !isRecord(input)) return null;
  const post = parseBlogPostContent(input.post);
  return post === null ? null : { ...common, post };
}

function parseUpdateBlogPostInput(input: unknown) {
  const common = parsePageMutationInput(input, ["postId", "post"]);
  if (common === null || !isRecord(input) || !isBlogPostId(input.postId)) {
    return null;
  }
  const post = parseBlogPostContent(input.post);
  return post === null ? null : { ...common, postId: input.postId, post };
}

function parseBlogPostCommandInput(input: unknown) {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["postId", "idempotencyKey"]) ||
    !isBlogPostId(input.postId) ||
    !validIdempotencyKey(input.idempotencyKey)
  ) {
    return null;
  }
  return { postId: input.postId, idempotencyKey: input.idempotencyKey };
}

function parseBlogScheduleRequestInput(input: unknown) {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "postId",
      "publishAt",
      "reportingTimeZone",
      "idempotencyKey",
    ]) ||
    !isBlogPostId(input.postId) ||
    typeof input.publishAt !== "string" ||
    !publishAtShape.test(input.publishAt) ||
    typeof input.reportingTimeZone !== "string" ||
    input.reportingTimeZone.length < 1 ||
    input.reportingTimeZone.length > 100 ||
    !validIdempotencyKey(input.idempotencyKey)
  ) {
    return null;
  }
  return {
    postId: input.postId,
    publishAt: input.publishAt,
    reportingTimeZone: input.reportingTimeZone,
    idempotencyKey: input.idempotencyKey,
  };
}

function parsePageMutationInput(
  input: unknown,
  extraKeys: ReadonlyArray<string>,
) {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "workspaceId",
      "expectedRevision",
      "idempotencyKey",
      ...extraKeys,
    ]) ||
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

function isPageTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= plainTextValueMaxLength
  );
}

function isPageSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= pageSlugMaxLength &&
    pageSlugShape.test(value)
  );
}

function parseCreatePageInput(input: unknown) {
  const common = parsePageMutationInput(input, [
    "title",
    "slug",
    "startingLayout",
  ]);
  if (
    common === null ||
    !isRecord(input) ||
    !isPageTitle(input.title) ||
    !isPageSlug(input.slug) ||
    typeof input.startingLayout !== "string" ||
    !pageStartingLayouts.some(({ id }) => id === input.startingLayout)
  ) {
    return null;
  }
  return {
    ...common,
    title: input.title,
    slug: input.slug,
    startingLayout: input.startingLayout,
  };
}

function parseNamedPageInput(input: unknown) {
  const common = parsePageMutationInput(input, ["pageId", "title", "slug"]);
  if (
    common === null ||
    !isRecord(input) ||
    !isDefinitionIdentifier(input.pageId) ||
    !isPageTitle(input.title) ||
    !isPageSlug(input.slug)
  ) {
    return null;
  }
  return {
    ...common,
    pageId: input.pageId,
    title: input.title,
    slug: input.slug,
  };
}

function parseDeletePageInput(input: unknown) {
  const common = parsePageMutationInput(input, ["pageId"]);
  if (common === null || !isRecord(input) || !isDefinitionIdentifier(input.pageId)) {
    return null;
  }
  return { ...common, pageId: input.pageId };
}

function isSectionPosition(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= pageCompositionContract.slot.maxItems
  );
}

/**
 * Read one section operation, or answer `null`.
 *
 * Every operation is read by its own exact key set, so a key that belongs to
 * another operation is refused rather than ignored. Which section types and
 * section styles exist is the schema's answer here; whether this page holds that
 * section, and whether that section offers that section style, is the draft's.
 */
function parseSectionOperation(
  operation: unknown,
): PageSectionOperation | null {
  if (!isRecord(operation) || typeof operation.op !== "string") return null;
  if (
    operation.op === "add" &&
    (hasExactKeys(operation, ["op", "sectionType", "position"]) ||
      hasExactKeys(operation, ["op", "sectionType", "position", "variant"])) &&
    typeof operation.sectionType === "string" &&
    installedPageComponentRegistry.allowedComponents.includes(
      operation.sectionType,
    ) &&
    isSectionPosition(operation.position) &&
    (operation.variant === undefined ||
      (typeof operation.variant === "string" &&
        designVariantValues.includes(operation.variant)))
  ) {
    return {
      op: "add",
      sectionType: operation.sectionType,
      position: operation.position,
      ...(operation.variant === undefined
        ? {}
        : { variant: operation.variant as string }),
    };
  }
  if (
    operation.op === "remove" &&
    hasExactKeys(operation, ["op", "sectionId"]) &&
    isDefinitionIdentifier(operation.sectionId)
  ) {
    return { op: "remove", sectionId: operation.sectionId };
  }
  if (
    operation.op === "move" &&
    hasExactKeys(operation, ["op", "sectionId", "position"]) &&
    isDefinitionIdentifier(operation.sectionId) &&
    isSectionPosition(operation.position)
  ) {
    return {
      op: "move",
      sectionId: operation.sectionId,
      position: operation.position,
    };
  }
  if (
    operation.op === "duplicate" &&
    hasExactKeys(operation, ["op", "sectionId"]) &&
    isDefinitionIdentifier(operation.sectionId)
  ) {
    return { op: "duplicate", sectionId: operation.sectionId };
  }
  if (
    operation.op === "set_variant" &&
    hasExactKeys(operation, ["op", "sectionId", "variant"]) &&
    isDefinitionIdentifier(operation.sectionId) &&
    typeof operation.variant === "string" &&
    designVariantValues.includes(operation.variant)
  ) {
    return {
      op: "set_variant",
      sectionId: operation.sectionId,
      variant: operation.variant,
    };
  }
  return null;
}

function parseRestructurePageInput(input: unknown) {
  const common = parsePageMutationInput(input, ["pageId", "operations"]);
  if (
    common === null ||
    !isRecord(input) ||
    !isDefinitionIdentifier(input.pageId) ||
    !Array.isArray(input.operations) ||
    input.operations.length < 1 ||
    input.operations.length > sectionOperationLimit
  ) {
    return null;
  }
  const operations = input.operations.flatMap((operation) => {
    const parsed = parseSectionOperation(operation);
    return parsed === null ? [] : [parsed];
  });
  return operations.length === input.operations.length
    ? { ...common, pageId: input.pageId, operations }
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
      isEditableFieldPath(operation.componentId) &&
      typeof operation.value === "string" &&
      designVariantValues.includes(operation.value)
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

const campaignIdSchema = {
  type: "string",
  format: "uuid",
} as const;

const campaignCallToActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string", minLength: 1, maxLength: 200 },
    href: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  required: ["label", "href"],
} as const;

/**
 * A campaign share image must be an absolute https address, because an email
 * client has no site to resolve a path against.
 */
const campaignShareImageSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          minLength: 1,
          maxLength: seoShareImageUrlMaxLength,
          pattern: campaignShareImageUrlPattern,
        },
        alt: { type: "string", maxLength: 300 },
      },
      required: ["url", "alt"],
    },
  ],
} as const;

const campaignEditableProperties = {
  subject: { type: "string", minLength: 1, maxLength: 200 },
  previewText: { type: "string", minLength: 1, maxLength: 1_000 },
  headerImage: campaignShareImageSchema,
  shareImage: campaignShareImageSchema,
  callToAction: campaignCallToActionSchema,
  emailContent: { $ref: "#/$defs/richTextDocument" },
} as const;

const campaignRevisionResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    campaignId: campaignIdSchema,
    version: { type: "integer", minimum: 1 },
    lifecycleState: { const: "draft" },
    revisionNumber: { type: "integer", minimum: 1 },
    provenance: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["standalone", "post_revision"] },
      },
      required: ["kind"],
    },
    replayed: { type: "boolean" },
  },
  required: [
    "campaignId",
    "version",
    "lifecycleState",
    "revisionNumber",
    "provenance",
    "replayed",
  ],
} as const;

const campaignDocumentResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    campaignId: campaignIdSchema,
    version: { type: "integer", minimum: 1 },
    lifecycleState: { const: "draft" },
    revisionNumber: { type: "integer", minimum: 1 },
    provenance: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["standalone", "post_revision"] },
      },
      required: ["kind"],
    },
    subject: { type: "string", minLength: 1, maxLength: 200 },
    previewText: { type: "string", minLength: 1, maxLength: 1_000 },
    headerImage: campaignShareImageSchema,
    shareImage: campaignShareImageSchema,
    callToAction: campaignCallToActionSchema,
    emailContent: { $ref: "#/$defs/richTextDocument" },
    schemaVersion: { type: "string" },
    rendererVersion: { type: "string", minLength: 1 },
    createdAt: { type: "string", format: "date-time" },
  },
  required: [
    "campaignId",
    "version",
    "lifecycleState",
    "revisionNumber",
    "provenance",
    "subject",
    "previewText",
    "headerImage",
    "shareImage",
    "callToAction",
    "emailContent",
    "schemaVersion",
    "rendererVersion",
    "createdAt",
  ],
} as const;

const campaignTestResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    executionId: { type: "string", format: "uuid" },
    state: {
      enum: [
        "pending",
        "attempting",
        "ambiguous",
        "accepted",
        "failed",
        "cancelled",
      ],
    },
    replayed: { type: "boolean" },
  },
  required: ["executionId", "state", "replayed"],
} as const;

const campaignTestReadinessResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: {
      enum: [
        "evaluation_only",
        "provider_unhealthy",
        "live_test_required",
        "owner_confirmation_required",
        "ready",
      ],
    },
    testDeliveryReady: { type: "boolean" },
    provider: { type: "string", minLength: 1 },
    configurationFingerprint: {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
    },
    ownershipEvidenceId: { type: "string", minLength: 1 },
    acceptedAt: { type: "string", format: "date-time" },
  },
  required: [
    "state",
    "testDeliveryReady",
    "provider",
    "configurationFingerprint",
    "ownershipEvidenceId",
  ],
} as const;

const localDateSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
} as const;

const analyticsRangeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    fromLocalDate: localDateSchema,
    toLocalDate: localDateSchema,
  },
  required: ["fromLocalDate", "toLocalDate"],
} as const;

const analyticsResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    view: { enum: [...mcpAnalyticsViews] },
    // The bounded view always carries the aggregate envelope. Its body differs
    // by view and is already privacy-guarded and small-cell suppressed by the
    // projection, so it is admitted as an aggregate object rather than
    // re-described field by field here.
    data: {
      type: "object",
      properties: {
        schemaVersion: { type: "string" },
        siteId: { type: "string" },
      },
      required: ["schemaVersion", "siteId"],
    },
  },
  required: ["view", "data"],
} as const;

const localDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Read an optional share image. Following this file's convention, `null` means
 * the value was unusable and the tool call is rejected. An absent or explicitly
 * null share image is valid and reads as `{ shareImage: null }`.
 */
function parseCampaignShareImage(
  value: unknown,
): Readonly<{ shareImage: SeoShareImage | null }> | null {
  if (value === undefined || value === null) return { shareImage: null };
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["url", "alt"]) ||
    typeof value.url !== "string" ||
    typeof value.alt !== "string"
  ) {
    return null;
  }
  return { shareImage: { url: value.url, alt: value.alt } };
}

function parseCampaignEditable(input: unknown): Readonly<{
  subject: string;
  previewText: string;
  headerImage: SeoShareImage | null;
  shareImage: SeoShareImage | null;
  callToAction: { label: string; href: string };
  emailContent: RichTextDocument;
}> | null {
  if (!isRecord(input)) {
    return null;
  }
  const headerImage = parseCampaignShareImage(input.headerImage);
  const shareImage = parseCampaignShareImage(input.shareImage);
  if (
    headerImage === null ||
    shareImage === null ||
    typeof input.subject !== "string" ||
    typeof input.previewText !== "string" ||
    !isRecord(input.callToAction) ||
    !hasExactKeys(input.callToAction, ["label", "href"]) ||
    typeof input.callToAction.label !== "string" ||
    typeof input.callToAction.href !== "string" ||
    !isRecord(input.emailContent)
  ) {
    return null;
  }
  return {
    subject: input.subject,
    previewText: input.previewText,
    headerImage: headerImage.shareImage,
    shareImage: shareImage.shareImage,
    callToAction: {
      label: input.callToAction.label,
      href: input.callToAction.href,
    },
    // The application layer re-validates the document with the canonical
    // rich-text validator before it becomes a revision, exactly as the
    // content patch tool does for its rich-text values.
    emailContent: input.emailContent as RichTextDocument,
  };
}

function parseCampaignId(value: unknown): CampaignId | null {
  if (typeof value !== "string") return null;
  try {
    return createCampaignId(value);
  } catch {
    return null;
  }
}

function parseAnalyticsInput(input: unknown): Readonly<{
  view: McpAnalyticsView;
  range: { fromLocalDate: string; toLocalDate: string };
  limit: number | null;
}> | null {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["view", "range", "limit"]) ||
    typeof input.view !== "string" ||
    !mcpAnalyticsViews.includes(input.view as McpAnalyticsView) ||
    !isRecord(input.range) ||
    !hasExactKeys(input.range, ["fromLocalDate", "toLocalDate"]) ||
    typeof input.range.fromLocalDate !== "string" ||
    typeof input.range.toLocalDate !== "string" ||
    !localDatePattern.test(input.range.fromLocalDate) ||
    !localDatePattern.test(input.range.toLocalDate) ||
    (input.limit !== null &&
      (typeof input.limit !== "number" ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100))
  ) {
    return null;
  }
  return {
    view: input.view as McpAnalyticsView,
    range: {
      fromLocalDate: input.range.fromLocalDate,
      toLocalDate: input.range.toLocalDate,
    },
    limit: input.limit as number | null,
  };
}

/**
 * The input a page tool takes: the draft, the revision the agent read before
 * it decided, the key that makes a retry safe, and whatever that one
 * operation names. Written once so the four tools cannot drift apart.
 */
function pageToolInputSchema<
  Extra extends Readonly<Record<string, unknown>>,
>(extraProperties: Extra) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      workspaceId: workspaceIdSchema,
      expectedRevision: { type: "integer", minimum: 0 },
      idempotencyKey: idempotencyKeySchema,
      ...extraProperties,
    },
    required: [
      "workspaceId",
      "expectedRevision",
      "idempotencyKey",
      ...Object.keys(extraProperties),
    ],
  } as const;
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
            siteDefinitionSchema.$defs.sitePage,
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
      "Edit content fields of any page in the draft, as a new immutable revision.",
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
                  field: editableFieldPathSchema,
                  format: { const: "plainText" },
                  value: {
                    type: "string",
                    minLength: 1,
                    maxLength: plainTextValueMaxLength,
                  },
                },
                required: ["op", "field", "value"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "set" },
                  field: editableFieldPathSchema,
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
  "foundry.page.create": {
    name: "foundry.page.create",
    description:
      "Add a page to the draft from one of the starting points, as a new immutable revision.",
    inputSchema: pageToolInputSchema({
      title: pageTitleSchema,
      slug: pageSlugSchema,
      startingLayout: pageStartingLayoutSchema,
    }),
    outputSchema: toolOutputSchema(pageMutationResult),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.page.rename": {
    name: "foundry.page.rename",
    description:
      "Change one page's name and web address in the draft, as a new immutable revision.",
    inputSchema: pageToolInputSchema({
      pageId: pageIdSchema,
      title: pageTitleSchema,
      slug: pageSlugSchema,
    }),
    outputSchema: toolOutputSchema(pageMutationResult),
    annotations: mutationAnnotations,
    execution: taskExecution,
  },
  "foundry.page.duplicate": {
    name: "foundry.page.duplicate",
    description:
      "Copy one page in the draft under a new name and web address, as a new immutable revision.",
    inputSchema: pageToolInputSchema({
      pageId: pageIdSchema,
      title: pageTitleSchema,
      slug: pageSlugSchema,
    }),
    outputSchema: toolOutputSchema(pageMutationResult),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.page.delete": {
    name: "foundry.page.delete",
    description:
      "Remove one page from the draft, as a new immutable revision.",
    inputSchema: pageToolInputSchema({ pageId: pageIdSchema }),
    outputSchema: toolOutputSchema(pageMutationResult),
    annotations: mutationAnnotations,
    execution: taskExecution,
  },
  "foundry.page.restructure": {
    name: "foundry.page.restructure",
    description:
      "Add, remove, move and copy the sections of one page in the draft, and choose their section styles, as a new immutable revision.",
    inputSchema: pageToolInputSchema({
      pageId: pageIdSchema,
      operations: {
        type: "array",
        minItems: 1,
        maxItems: sectionOperationLimit,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "add" },
                sectionType: sectionTypeSchema,
                position: sectionPositionSchema,
                variant: sectionVariantSchema,
              },
              required: ["op", "sectionType", "position"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "remove" },
                sectionId: sectionIdSchema,
              },
              required: ["op", "sectionId"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "move" },
                sectionId: sectionIdSchema,
                position: sectionPositionSchema,
              },
              required: ["op", "sectionId", "position"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "duplicate" },
                sectionId: sectionIdSchema,
              },
              required: ["op", "sectionId"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                op: { const: "set_variant" },
                sectionId: sectionIdSchema,
                variant: sectionVariantSchema,
              },
              required: ["op", "sectionId", "variant"],
            },
          ],
        },
      },
    }),
    outputSchema: toolOutputSchema(pageMutationResult),
    annotations: mutationAnnotations,
    execution: taskExecution,
  },
  "foundry.section.list": {
    name: "foundry.section.list",
    description:
      "List the section types a page can hold, with their section styles and their editable fields.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: toolOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              sectionType: sectionTypeSchema,
              label: { type: "string", minLength: 1 },
              variants: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    value: sectionVariantSchema,
                    label: { type: "string", minLength: 1 },
                    description: { type: "string", minLength: 1 },
                  },
                  required: ["value", "label", "description"],
                },
              },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string", minLength: 1 },
                    label: { type: "string", minLength: 1 },
                    format: { enum: ["plainText", "richText"] },
                  },
                  required: ["name", "label", "format"],
                },
              },
            },
            required: ["sectionType", "label", "variants", "fields"],
          },
        },
      },
      required: ["sections"],
    }),
    annotations,
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
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "set_variant" },
                  componentId: designComponentIdSchema,
                  value: { enum: designVariantValues },
                },
                required: ["op", "componentId", "value"],
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
  "foundry.blog.create": {
    name: "foundry.blog.create",
    description:
      "Start a new blog post in the draft, as a new immutable revision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
        post: blogPostContentSchema,
      },
      required: [
        "workspaceId",
        "expectedRevision",
        "idempotencyKey",
        "post",
      ],
      $defs: siteDefinitionSchema.$defs,
    },
    outputSchema: toolOutputSchema(blogPostMutationResult),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.blog.update": {
    name: "foundry.blog.update",
    description:
      "Rewrite one blog post in the draft, as a new immutable revision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: workspaceIdSchema,
        expectedRevision: { type: "integer", minimum: 0 },
        idempotencyKey: idempotencyKeySchema,
        postId: blogPostIdSchema,
        post: blogPostContentSchema,
      },
      required: [
        "workspaceId",
        "expectedRevision",
        "idempotencyKey",
        "postId",
        "post",
      ],
      $defs: siteDefinitionSchema.$defs,
    },
    outputSchema: toolOutputSchema(blogPostMutationResult),
    annotations: mutationAnnotations,
    execution: taskExecution,
  },
  "foundry.blog.archive": {
    name: "foundry.blog.archive",
    description:
      "Take one post out of the blog. A post that is on the site comes off it only after a person approves the removal.",
    inputSchema: blogPostCommandInputSchema,
    outputSchema: toolOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        postId: blogPostIdSchema,
        archiveRequestId: { type: "string", minLength: 1 },
        collectionState: { enum: ["archiving", "archived"] },
        removalFromSiteNeedsApproval: { type: "boolean" },
      },
      required: [
        "postId",
        "archiveRequestId",
        "collectionState",
        "removalFromSiteNeedsApproval",
      ],
    }),
    annotations: mutationAnnotations,
    execution: taskExecution,
  },
  "foundry.blog.restore": {
    name: "foundry.blog.restore",
    description:
      "Put one archived post back as an unpublished draft.",
    inputSchema: blogPostCommandInputSchema,
    outputSchema: toolOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        postId: blogPostIdSchema,
        workspaceId: { type: "string", pattern: "^workspace_[a-z0-9_]+$" },
        revision: { type: "integer", minimum: 0 },
        postRevision: { type: "integer", minimum: 1 },
        targetVisibility: { const: "unpublished" },
      },
      required: [
        "postId",
        "workspaceId",
        "revision",
        "postRevision",
        "targetVisibility",
      ],
    }),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.blog.schedule_request": {
    name: "foundry.blog.schedule_request",
    description:
      "Ask a person to publish one post at a named time. It records the request only; a person approves the post and starts the schedule.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        postId: blogPostIdSchema,
        publishAt: publishAtSchema,
        reportingTimeZone: {
          type: "string",
          minLength: 1,
          maxLength: 100,
        },
        idempotencyKey: idempotencyKeySchema,
      },
      required: [
        "postId",
        "publishAt",
        "reportingTimeZone",
        "idempotencyKey",
      ],
    },
    outputSchema: toolOutputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: { type: "string", minLength: 1 },
        postId: blogPostIdSchema,
        publishAt: publishAtSchema,
        reportingTimeZone: { type: "string", minLength: 1 },
        state: { const: "pending_human_approval" },
      },
      required: [
        "requestId",
        "postId",
        "publishAt",
        "reportingTimeZone",
        "state",
      ],
    }),
    annotations: nonDestructiveMutationAnnotations,
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
        // Deliberately looser than `previewIdPattern`. A preview prepared
        // before preview ids carried a prefix still replays through this
        // tool, and its result must stay valid against its own schema.
        // `foundry.publication.status` is the strict surface.
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
        publishAt: publishAtSchema,
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
      "Read the current state of a publication, publication schedule or prepared preview.",
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
    outputSchema: toolOutputSchema(publicationStatusResult),
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
  "foundry.campaign.create": {
    name: "foundry.campaign.create",
    description:
      "Prepare a new standalone campaign as an independent draft revision.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        idempotencyKey: idempotencyKeySchema,
        ...campaignEditableProperties,
      },
      required: [
        "idempotencyKey",
        "subject",
        "previewText",
        "callToAction",
        "emailContent",
      ],
      $defs: siteDefinitionSchema.$defs,
    },
    outputSchema: toolOutputSchema(campaignRevisionResult),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.campaign.edit": {
    name: "foundry.campaign.edit",
    description:
      "Edit a campaign into a new immutable revision under optimistic concurrency.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaignId: campaignIdSchema,
        expectedVersion: { type: "integer", minimum: 1 },
        idempotencyKey: idempotencyKeySchema,
        ...campaignEditableProperties,
      },
      required: [
        "campaignId",
        "expectedVersion",
        "idempotencyKey",
        "subject",
        "previewText",
        "callToAction",
        "emailContent",
      ],
      $defs: siteDefinitionSchema.$defs,
    },
    outputSchema: toolOutputSchema(campaignRevisionResult),
    annotations: nonDestructiveMutationAnnotations,
    execution: taskExecution,
  },
  "foundry.campaign.get": {
    name: "foundry.campaign.get",
    description:
      "Read a campaign's editable content and metadata, without audience or recipient data.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaignId: campaignIdSchema,
      },
      required: ["campaignId"],
    },
    outputSchema: toolOutputSchema(campaignDocumentResult),
    annotations,
    execution: taskExecution,
  },
  "foundry.campaign.request_test": {
    name: "foundry.campaign.request_test",
    description:
      "Request a test delivery to the Owner-configured verified recipients. The agent selects no recipients.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaignId: campaignIdSchema,
        idempotencyKey: idempotencyKeySchema,
      },
      required: ["campaignId", "idempotencyKey"],
    },
    outputSchema: toolOutputSchema(campaignTestResult),
    annotations: campaignTestAnnotations,
    execution: taskExecution,
  },
  "foundry.campaign.test_readiness": {
    name: "foundry.campaign.test_readiness",
    description:
      "Read whether a campaign's test delivery and Owner confirmation are current.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        campaignId: campaignIdSchema,
      },
      required: ["campaignId"],
    },
    outputSchema: toolOutputSchema(campaignTestReadinessResult),
    annotations,
    execution: taskExecution,
  },
  "foundry.analytics.read": {
    name: "foundry.analytics.read",
    description:
      "Read one fixed bounded aggregate analytics view with metric metadata and small-cell suppression.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        view: { enum: [...mcpAnalyticsViews] },
        range: analyticsRangeSchema,
        limit: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: 100 },
            { type: "null" },
          ],
        },
      },
      required: ["view", "range", "limit"],
    },
    outputSchema: toolOutputSchema(analyticsResult),
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
    "foundry.page.create": async (principal, input, context) => {
      const parsed = parseCreatePageInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.page.create",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.createPage!(principal, parsed, context);
    },
    "foundry.page.rename": async (principal, input, context) => {
      const parsed = parseNamedPageInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.page.rename",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.renamePage!(principal, parsed, context);
    },
    "foundry.page.duplicate": async (principal, input, context) => {
      const parsed = parseNamedPageInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.page.duplicate",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.duplicatePage!(principal, parsed, context);
    },
    "foundry.page.delete": async (principal, input, context) => {
      const parsed = parseDeletePageInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.page.delete",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.deletePage!(principal, parsed, context);
    },
    "foundry.page.restructure": async (principal, input, context) => {
      const parsed = parseRestructurePageInput(input);
      if (parsed === null) {
        // A malformed request still says which scopes it was asking for, so
        // the refusal names the design draft scope when the request tried to
        // choose a section style. See ADR-0035.
        return application.rejectInvalidInput(
          principal,
          "foundry.page.restructure",
          input,
          context,
          mcpRestructureScopes(
            isRecord(input) && Array.isArray(input.operations)
              ? input.operations
              : [],
          ),
        );
      }
      return application.restructurePage!(principal, parsed, context);
    },
    "foundry.section.list": async (principal, input, context) => {
      if (!isRecord(input) || !hasExactKeys(input, [])) {
        return application.rejectInvalidInput(
          principal,
          "foundry.section.list",
          input,
          context,
        );
      }
      return application.listSectionTypes(principal, context);
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
    "foundry.blog.create": async (principal, input, context) => {
      const parsed = parseCreateBlogPostInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.blog.create",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.createBlogPost!(principal, parsed, context);
    },
    "foundry.blog.update": async (principal, input, context) => {
      const parsed = parseUpdateBlogPostInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.blog.update",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.updateBlogPost!(principal, parsed, context);
    },
    "foundry.blog.archive": async (principal, input, context) => {
      const parsed = parseBlogPostCommandInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.blog.archive",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.archiveBlogPost!(principal, parsed, context);
    },
    "foundry.blog.restore": async (principal, input, context) => {
      const parsed = parseBlogPostCommandInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.blog.restore",
          input,
          context,
          [mcpContentDraftScope],
        );
      }
      return application.restoreBlogPost!(principal, parsed, context);
    },
    "foundry.blog.schedule_request": async (principal, input, context) => {
      const parsed = parseBlogScheduleRequestInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.blog.schedule_request",
          input,
          context,
          [mcpPublicationScheduleScope],
        );
      }
      return application.requestBlogSchedule!(principal, parsed, context);
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
    "foundry.campaign.create": async (principal, input, context) => {
      const editable =
        isRecord(input) &&
        hasExactKeys(
          input,
          [
            "idempotencyKey",
            "subject",
            "previewText",
            "callToAction",
            "emailContent",
          ],
          ["headerImage", "shareImage"],
        ) &&
        validIdempotencyKey(input.idempotencyKey)
          ? parseCampaignEditable(input)
          : null;
      if (editable === null || !isRecord(input)) {
        return application.rejectInvalidInput(
          principal,
          "foundry.campaign.create",
          input,
          context,
          [mcpCampaignDraftScope],
        );
      }
      return application.createCampaign!(
        principal,
        {
          idempotencyKey: input.idempotencyKey as string,
          ...editable,
        },
        context,
      );
    },
    "foundry.campaign.edit": async (principal, input, context) => {
      const editable =
        isRecord(input) &&
        hasExactKeys(
          input,
          [
            "campaignId",
            "expectedVersion",
            "idempotencyKey",
            "subject",
            "previewText",
            "callToAction",
            "emailContent",
          ],
          ["headerImage", "shareImage"],
        ) &&
        validIdempotencyKey(input.idempotencyKey) &&
        Number.isSafeInteger(input.expectedVersion) &&
        (input.expectedVersion as number) >= 1
          ? parseCampaignEditable(input)
          : null;
      const campaignId = isRecord(input)
        ? parseCampaignId(input.campaignId)
        : null;
      if (editable === null || campaignId === null || !isRecord(input)) {
        return application.rejectInvalidInput(
          principal,
          "foundry.campaign.edit",
          input,
          context,
          [mcpCampaignDraftScope],
        );
      }
      return application.editCampaign!(
        principal,
        {
          campaignId,
          expectedVersion: input.expectedVersion as number,
          idempotencyKey: input.idempotencyKey as string,
          ...editable,
        },
        context,
      );
    },
    "foundry.campaign.get": async (principal, input, context) => {
      const campaignId =
        isRecord(input) && hasExactKeys(input, ["campaignId"])
          ? parseCampaignId(input.campaignId)
          : null;
      if (campaignId === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.campaign.get",
          input,
          context,
          [mcpCampaignDraftScope],
        );
      }
      return application.getCampaign!(principal, { campaignId }, context);
    },
    "foundry.campaign.request_test": async (principal, input, context) => {
      const campaignId =
        isRecord(input) &&
        hasExactKeys(input, ["campaignId", "idempotencyKey"]) &&
        validIdempotencyKey(input.idempotencyKey)
          ? parseCampaignId(input.campaignId)
          : null;
      if (campaignId === null || !isRecord(input)) {
        return application.rejectInvalidInput(
          principal,
          "foundry.campaign.request_test",
          input,
          context,
          [mcpCampaignTestScope],
        );
      }
      return application.requestTest!(
        principal,
        {
          campaignId,
          idempotencyKey: input.idempotencyKey as string,
        },
        context,
      );
    },
    "foundry.campaign.test_readiness": async (principal, input, context) => {
      const campaignId =
        isRecord(input) && hasExactKeys(input, ["campaignId"])
          ? parseCampaignId(input.campaignId)
          : null;
      if (campaignId === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.campaign.test_readiness",
          input,
          context,
          [mcpCampaignTestScope],
        );
      }
      return application.testReadiness!(principal, { campaignId }, context);
    },
    "foundry.analytics.read": async (principal, input, context) => {
      const parsed = parseAnalyticsInput(input);
      if (parsed === null) {
        return application.rejectInvalidInput(
          principal,
          "foundry.analytics.read",
          input,
          context,
          [mcpAnalyticsReadScope],
        );
      }
      return application.readAnalytics!(principal, parsed, context);
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
      const supportsCampaigns =
        application.createCampaign !== undefined;
      const supportsAnalytics =
        application.readAnalytics !== undefined;
      const supportsBlogDrafts = application.createBlogPost !== undefined;
      const supportsBlogOperations =
        application.archiveBlogPost !== undefined;
      return Object.entries(descriptors)
        .filter(([name]) => {
          if (
            name.startsWith("foundry.workspace.") ||
            name.startsWith("foundry.page.") ||
            name === "foundry.content.patch" ||
            name === "foundry.design.patch" ||
            name === "foundry.preview.prepare"
          ) {
            if (!supportsDrafts) return false;
          }
          // The two blog draft writes are draft work and need the content
          // draft scope. Archive and restore are blog collection work and
          // need the same scope. Asking for a schedule needs the schedule
          // scope, because that is the permission it asks about. See
          // ADR-0036.
          if (
            name === "foundry.blog.create" ||
            name === "foundry.blog.update"
          ) {
            return (
              supportsDrafts &&
              supportsBlogDrafts &&
              principal.scopes.includes(mcpContentDraftScope)
            );
          }
          if (
            name === "foundry.blog.archive" ||
            name === "foundry.blog.restore"
          ) {
            return (
              supportsBlogOperations &&
              principal.scopes.includes(mcpContentDraftScope)
            );
          }
          if (name === "foundry.blog.schedule_request") {
            return (
              supportsBlogOperations &&
              principal.scopes.includes(mcpPublicationScheduleScope)
            );
          }
          if (name.startsWith("foundry.campaign.")) {
            if (!supportsCampaigns) return false;
            if (
              name === "foundry.campaign.request_test" ||
              name === "foundry.campaign.test_readiness"
            ) {
              return principal.scopes.includes(mcpCampaignTestScope);
            }
            return principal.scopes.includes(mcpCampaignDraftScope);
          }
          if (name === "foundry.analytics.read") {
            return (
              supportsAnalytics &&
              principal.scopes.includes(mcpAnalyticsReadScope)
            );
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
          // A page operation writes content, so it needs the content draft
          // scope, exactly as a content field edit does.
          if (
            name === "foundry.content.patch" ||
            name.startsWith("foundry.page.")
          ) {
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
          name.startsWith("foundry.page.") ||
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
      if (
        application.createBlogPost === undefined &&
        (name === "foundry.blog.create" || name === "foundry.blog.update")
      ) {
        return null;
      }
      if (
        application.archiveBlogPost === undefined &&
        (
          name === "foundry.blog.archive" ||
          name === "foundry.blog.restore" ||
          name === "foundry.blog.schedule_request"
        )
      ) {
        return null;
      }
      if (
        application.createCampaign === undefined &&
        name.startsWith("foundry.campaign.")
      ) {
        return null;
      }
      if (
        application.readAnalytics === undefined &&
        name === "foundry.analytics.read"
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

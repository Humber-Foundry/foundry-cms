import {
  designContract,
  listEditableSiteFields,
  createBlogPostId,
  findPageById,
  mediaAssetIdFromPublishedPath,
  pageMediaOccurrenceId,
  serializeRichTextDocument,
  type BlogPost,
  type PageMediaSlot,
  type SiteMediaOccurrence,
  type BlogPostSchemaError,
  type PageSectionOperation,
  type RichTextDocument,
  type SeoShareImage,
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
  mintedContentBlogPostId,
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
  type McpCursorBinding,
  type McpCursorCodec,
  type McpExecutionContext,
  type McpReadAuditEvent,
} from "./mcp-read";

/**
 * One photo in this site's media library, as an agent sees it.
 *
 * `mediaPath` is the site's own address for the photo, which is the only
 * address a blog post may point at. The photo's own bytes are never returned
 * through MCP, and neither is the person or connection that added it.
 * See ADR-0037.
 */
export type McpMediaAsset = Readonly<{
  assetId: string;
  mediaPath: string;
  fileName: string;
  contentType: string;
  byteLength: number;
  width: number;
  height: number;
  createdAt: string;
}>;

/** What placing a photo in one page slot gives back. */
export type McpPlacedMediaOccurrence = Readonly<{
  occurrenceId: string;
  revision: number;
  asset: Readonly<{
    assetId: string;
    width: number;
    height: number;
    contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  }>;
}>;

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
  /**
   * Whether this site's media library holds the photo with this asset id.
   * A blog post may only name a photo the library already has; uploading
   * one is not an MCP tool. See ADR-0036.
   */
  mediaLibraryHoldsAsset(input: {
    principal: McpConnectionPrincipal;
    assetId: string;
  }): Promise<boolean>;
  /**
   * Every photo this site's media library holds, newest first. The list
   * carries only what an agent needs to name and size a photo; it carries no
   * person and no address. See ADR-0037.
   */
  listMediaAssets(input: {
    principal: McpConnectionPrincipal;
  }): Promise<ReadonlyArray<McpMediaAsset>>;
  /**
   * Add one photo to this site's media library.
   *
   * The runtime reads the picture's real type and size from the bytes and
   * then runs the very same upload command the dashboard's own upload runs,
   * so an agent's photo is held to the same rules. See ADR-0037.
   */
  uploadMediaAsset(input: {
    principal: McpConnectionPrincipal;
    fileName: string;
    source: Uint8Array;
    idempotencyKey: string;
  }): Promise<McpMediaAsset>;
  /**
   * Point one page photo slot at one photo the library already holds, and
   * answer the new occurrence and the photo's own size. This advances the
   * media occurrence head the content revision store then requires, exactly
   * as the dashboard's own Photos page does.
   */
  placeMediaOccurrence(input: {
    principal: McpConnectionPrincipal;
    workspaceId: ContentWorkspaceId;
    occurrenceId: string;
    assetId: string;
    idempotencyKey: string;
  }): Promise<McpPlacedMediaOccurrence>;
  /**
   * An opaque page marker bound to this site, this connection and this query.
   * The media list is the only place the draft application paginates.
   */
  cursors: McpCursorCodec;
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
 * What every draft record tool shares: who is asking, which tool it is, what
 * it sent, the permissions it needs, and how an ordinary refusal is named.
 *
 * `namedRefusal` lets one family of tools read a refusal in its own words. It
 * keeps the seam itself free of any one record's vocabulary: a blog code
 * belongs to the blog tools, not to the four page tools that share this seam.
 */
type DraftRecordMutation<Input extends McpPageMutationInput> = Readonly<{
  principal: McpConnectionPrincipal;
  operation: string;
  input: Input;
  context: McpExecutionContext;
  requiredScopes?: ReadonlyArray<string>;
  refusalReason?: string;
  namedRefusal?: (error: ContentRevisionValidationError) => McpReadError | null;
}>;

/**
 * Read a refused blog write in the blog's own words.
 *
 * The blog reports its rules under the `blog` field. The code is the named
 * reason an agent branches on, the same way a page lifecycle code is, and the
 * sentence is the plain words a site owner would read.
 */
function blogRefusal(error: ContentRevisionValidationError) {
  const code = error.fields.blog;
  if (code === undefined || !Object.hasOwn(blogRefusalSentences, code)) {
    return null;
  }
  return new McpReadError(
    "VALIDATION_FAILED",
    blogRefusalSentences[code as BlogPostSchemaError["code"]],
    { reason: code },
  );
}

/**
 * What every MCP tool that writes a draft record takes: the draft, the
 * revision the agent read before it decided, and the key that makes a retry
 * safe. It is the same front as `foundry.content.patch`, because a page
 * operation and a blog post write are the same kind of draft write.
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

export type McpRestructurePageInput = McpPageMutationInput &
  Readonly<{
    pageId: string;
    operations: ReadonlyArray<PageSectionOperation>;
  }>;

/**
 * The one field of a section operation that names a section style.
 *
 * It is tied to the operation union, so an operation that ever names a section
 * style under a different key stops the build here and `mcpRestructureScopes`
 * below has to change with it.
 */
const sectionStyleField = "variant" satisfies keyof Extract<
  PageSectionOperation,
  { variant: string }
>;

/**
 * The draft scopes one restructure needs.
 *
 * Changing which sections a page holds is a content change, so every
 * restructure needs the content draft scope. Naming a section style is
 * choosing a design value, so a request that names one needs the design draft
 * scope as well. See ADR-0035.
 *
 * The operations are read as they arrived, before anything is parsed or
 * loaded, so this answers for a malformed request as well as a well-formed
 * one. That is deliberate: a request is audited whether or not it parsed, and
 * naming only the content scope there would understate what the caller tried
 * to do. It is also why this is the only place the rule is written.
 */
export function mcpRestructureScopes(
  operations: ReadonlyArray<unknown>,
): ReadonlyArray<string> {
  const namesASectionStyle = operations.some(
    (operation) =>
      typeof operation === "object" &&
      operation !== null &&
      sectionStyleField in operation &&
      (operation as Record<string, unknown>)[sectionStyleField] !== undefined,
  );
  return namesASectionStyle
    ? [mcpContentDraftScope, mcpDesignDraftScope]
    : [mcpContentDraftScope];
}

/**
 * The named reason for a page refusal the draft raised without a page
 * lifecycle code of its own. A rename is two ordinary field edits, so the
 * field's own check refuses it and reports one sentence per field. The agent
 * reads those sentences in the message and this word in `reason`.
 */
const pageFieldsRefusedReason = "page_fields_refused";

/**
 * The named reason for a restructure the page composition boundary refused
 * without a page lifecycle code of its own, such as a section list that is
 * empty or a section another section's button still links to. The message
 * carries the boundary's own sentences.
 */
const pageSectionsRefusedReason = "page_sections_refused";

/**
 * The three named reasons a content edit is refused for: the draft has no
 * field at that path, the path is a design setting rather than content, or
 * the value was sent in the other format. An agent branches on these instead
 * of reading the sentence.
 */
const contentFieldNotEditableReason = "content_field_not_editable";
const contentFieldFormatReason = "content_field_format_mismatch";
const designFieldNotContentReason = "design_field_not_content";

/**
 * The two named reasons a design change is refused for: the draft has no
 * design setting at that path, or the setting does not offer that value.
 */
const designSettingNotFoundReason = "design_setting_not_found";
const designValueNotRegisteredReason = "design_value_not_registered";

/**
 * One plain sentence for each rule the blog itself keeps, so an agent that
 * writes a post reads the same words a site owner would. `reason` carries the
 * blog's own code, which is what a program branches on.
 */
const blogRefusalSentences: Readonly<
  Record<BlogPostSchemaError["code"], string>
> = Object.freeze({
  cross_site_identifier: "That post belongs to another site.",
  post_already_exists: "This draft already has a post with that id.",
  post_already_live: "That post is already on the site.",
  post_not_found: "This draft has no post with that id.",
  post_not_live: "That post is not on the site.",
  post_not_unpublished: "That post is not waiting to go back on the site.",
  slug_already_exists:
    "Another post in this draft already uses that web address.",
  schema_invalid: "The post does not match the site's content rules.",
});

/**
 * The named reason a post is refused for naming a picture that is not one of
 * this site's own photos. A post may point only at a photo this site's media
 * library already holds. An agent that needs a new one adds it with
 * `foundry.media.upload` first. See ADR-0036 and ADR-0037.
 */
const blogMediaNotInLibraryReason = "blog_media_not_in_library";

/**
 * The named reasons a photo tool is refused for.
 *
 * `media_not_an_image` covers bytes that are not one of the picture types the
 * library stores. `media_too_large` covers a picture bigger than one tool call
 * may carry. `media_upload_refused` covers every other rule the media library
 * itself keeps. `media_asset_not_found` covers placing a photo this site does
 * not hold, and `media_page_not_found` covers a page the draft does not hold.
 * See ADR-0037.
 */
const mediaNotAnImageReason = "media_not_an_image";
const mediaTooLargeReason = "media_too_large";
const mediaUploadRefusedReason = "media_upload_refused";
const mediaAssetNotFoundReason = "media_asset_not_found";
const mediaPageNotFoundReason = "media_page_not_found";

/**
 * The most picture bytes one `foundry.media.upload` call may carry.
 *
 * The photo travels inside the tool call itself, because no MCP tool accepts a
 * URL to fetch (threat model, "SSRF/open-world abuse"). Four mebibytes covers
 * every ordinary web photo and bounds what one call can ask the server to hold
 * in memory. The dashboard's own upload accepts a larger original because a
 * person sends it over a plain form request, not a JSON-RPC call. See
 * ADR-0037.
 */
export const mcpMediaUploadMaxByteLength = 4 * 1024 * 1024;

/** The most photos one `foundry.media.list` page may carry. */
export const mcpMediaListMaxPageSize = 100;

/** The longest file name an uploaded photo may carry. */
export const mcpMediaFileNameMaxLength = 255;

/**
 * A refusal the media runtime raises with a named cause of its own, so the
 * tool can report the same reason a program branches on.
 */
export class McpMediaValidationError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "McpMediaValidationError";
  }
}

/** Which page photo slot a placement names. */
export type McpMediaSlot = PageMediaSlot;

export type McpPlaceMediaInput = McpPageMutationInput &
  Readonly<{
    pageId: string;
    slot: McpMediaSlot;
    assetId: string;
  }>;

/**
 * Read the picture bytes a caller sent.
 *
 * The encoded text is checked for its shape and its length before anything is
 * decoded, so an oversized or malformed payload is refused rather than turned
 * into a large buffer first.
 */
function decodeMediaUploadBytes(bytesBase64: string): Uint8Array {
  const encoded = bytesBase64;
  // Standard base64, padded, no line breaks. Every other text is refused
  // before it reaches the decoder.
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    throw new McpMediaValidationError(
      mediaNotAnImageReason,
      "The picture is not base64 text.",
    );
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = (encoded.length / 4) * 3 - padding;
  if (byteLength <= 0) {
    throw new McpMediaValidationError(
      mediaNotAnImageReason,
      "The picture is empty.",
    );
  }
  if (byteLength > mcpMediaUploadMaxByteLength) {
    throw new McpMediaValidationError(
      mediaTooLargeReason,
      `A photo sent through this tool must be ${mcpMediaUploadMaxByteLength} bytes or smaller. Send a smaller copy.`,
    );
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new McpMediaValidationError(
      mediaNotAnImageReason,
      "The picture is not base64 text.",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Turn a refused photo command into the tool error an agent acts on. A
 * refusal the media runtime named keeps its own reason; anything else becomes
 * one named refusal rather than an unexplained failure.
 */
function mediaRefusal(error: unknown): unknown {
  if (error instanceof McpReadError) return error;
  if (error instanceof McpMediaValidationError) {
    return new McpReadError("VALIDATION_FAILED", error.message, {
      reason: error.reason,
    });
  }
  return error;
}

/**
 * The named reason a post write is refused for when the draft turned it down
 * without a blog code of its own, such as a field the site's own rules refuse.
 */
const blogPostRefusedReason = "blog_post_refused";

/**
 * What an agent writes into one blog post. It is the post's own field set
 * from the Site Definition, minus the four fields the blog owns rather than
 * the writer: its id, its revision number, and the two that say whether it is
 * in the collection and on the site. A
 * post's tags are `seo.keywords`, which is where the blog has always kept
 * them. See ADR-0036.
 */
export type McpBlogPostContent = Omit<
  BlogPost,
  "id" | "revision" | "collectionState" | "targetVisibility"
>;

export type McpCreateBlogPostInput = McpPageMutationInput &
  Readonly<{ post: McpBlogPostContent }>;

export type McpUpdateBlogPostInput = McpPageMutationInput &
  Readonly<{ postId: string; post: McpBlogPostContent }>;

/**
 * Refuse a post that points at a picture this site does not hold.
 *
 * Every picture address in a post — the header image, the share image and
 * every picture in the body — must be this site's own media path,
 * `/api/media/<assetId>`. An agent can choose a photo the media library
 * already has; it cannot add one, and it cannot point the site at a picture
 * somewhere else. See ADR-0036.
 */
function blogPostMediaFields(post: McpBlogPostContent) {
  const fields: Array<
    Readonly<{ field: string; assetId: string | null }>
  > = [];
  const collectImage = (field: string, image: SeoShareImage | null) => {
    if (image !== null) {
      fields.push({
        field,
        assetId: mediaAssetIdFromPublishedPath(image.url),
      });
    }
  };
  collectImage("mainImage", post.mainImage);
  collectImage("seo.shareImage", post.seo.shareImage);
  post.body.children.forEach((block, index) => {
    if (block.type === "image") {
      fields.push({
        field: `body.children.${index}`,
        assetId: mediaAssetIdFromPublishedPath(block.src),
      });
    }
  });
  return fields;
}

async function requireOwnMediaReferences(
  post: McpBlogPostContent,
  holdsAsset: (assetId: string) => Promise<boolean>,
) {
  const fields = blogPostMediaFields(post);
  // A post often uses the same photo twice, as its header and its share
  // picture, so each photo is looked up once however often it appears.
  const assetIds = new Set(
    fields.flatMap(({ assetId }) => (assetId === null ? [] : [assetId])),
  );
  const held = new Map(
    await Promise.all(
      [...assetIds].map(
        async (assetId) =>
          [assetId, await holdsAsset(assetId)] as const,
      ),
    ),
  );
  for (const { field, assetId } of fields) {
    // The refusal names the field rather than repeating the address, so
    // nothing a caller wrote is echoed back into a client's screen.
    if (assetId === null || held.get(assetId) !== true) {
      throw new McpReadError(
        "VALIDATION_FAILED",
        `The picture at ${field} is not one of this site's photos. Use the media path of a photo the media library already holds.`,
        { reason: blogMediaNotInLibraryReason },
      );
    }
  }
}

/**
 * Turn a refused page operation into the tool error an agent acts on.
 *
 * The sentences come from the draft itself, which is the one place the page
 * rules are written (ADR-0033), so an agent and a site owner read the same
 * words. `reason` carries the stable code a program branches on.
 */
function pageRefusal(
  error: ContentRevisionValidationError,
  fallbackReason: string = pageFieldsRefusedReason,
): McpReadError {
  const sentences = Object.values(error.fields).join(" ");
  return new McpReadError(
    "VALIDATION_FAILED",
    sentences === "" ? "The page operation was refused." : sentences,
    {
      reason:
        error instanceof ContentPageOperationError
          ? error.code
          : fallbackReason,
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
        `The field ${field} is a design setting, not content. Use foundry.design.patch for a design change.`,
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
      field.values === undefined
    ) {
      // The draft's own field list is the answer, so a section on a page the
      // agent made in this draft can have its section style chosen (ADR-0035).
      throw new McpReadError(
        "VALIDATION_FAILED",
        `This draft has no design setting at ${path}.`,
        { reason: designSettingNotFoundReason },
      );
    }
    if (!field.values.includes(operation.value)) {
      throw new McpReadError(
        "VALIDATION_FAILED",
        `The design setting ${path} does not offer the value ${operation.value}.`,
        { reason: designValueNotRegisteredReason },
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
   * Run one draft record operation as an MCP tool call.
   *
   * Every page tool and every blog draft tool goes through here, so they all
   * get the same draft scope, the same replay handling, the same
   * base-revision check and the same refusal shape. The work itself is `run`,
   * which calls the matching application command; this adds nothing to what
   * the dashboard does.
   *
   * `recordKey` is the name the result reports the record under: `pageId` for
   * a page, `postId` for a blog post, `occurrenceId` for a page photo slot.
   *
   * `replayedRecordId` names the record a stored receipt was for. A receipt
   * records the revision, not the record, so a create and a duplicate rebuild
   * the id they minted while a rename, a delete and an update already know
   * it.
   */
  function draftRecordMutation<Input extends McpPageMutationInput>({
    principal,
    operation,
    input,
    context,
    run,
    replayedRecordId,
    recordKey,
    requiredScopes = [mcpContentDraftScope],
    refusalReason = pageFieldsRefusedReason,
    namedRefusal = () => null,
  }: DraftRecordMutation<Input> &
    Readonly<{
      recordKey: "pageId" | "postId" | "occurrenceId";
      run(
        application: ContentRevisionApplication,
        command: PageMutationCommand,
      ): Promise<
        Readonly<{
          revision: SavedContentRevision;
          recordId: string;
          replayed: boolean;
        }>
      >;
      replayedRecordId(
        workspaceId: ContentWorkspaceId,
        storageKey: string,
      ): Promise<string>;
    }>) {
    return base.executeScoped({
      principal,
      operation,
      auditInput: input,
      requiredScopes,
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
            [recordKey]: await execution.run(() =>
              replayedRecordId(replay.workspaceId, storageKey),
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
        let mutation: Awaited<ReturnType<typeof run>>;
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
            throw namedRefusal(error) ?? pageRefusal(error, refusalReason);
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
          [recordKey]: mutation.recordId,
          replayed: mutation.replayed,
          previewArtifact: await execution.run(() =>
            createCanonicalPreviewArtifactHash(saved),
          ),
        };
      },
    });
  }

  /**
   * Run one page operation as an MCP tool call. It is the draft record seam
   * with the page's own words: the application command answers with a
   * `PageMutationResult`, and the result reports the page as `pageId`.
   */
  function pageMutation<Input extends McpPageMutationInput>({
    run,
    replayedPageId,
    ...rest
  }: DraftRecordMutation<Input> &
    Readonly<{
      run(
        application: ContentRevisionApplication,
        command: PageMutationCommand,
      ): Promise<PageMutationResult>;
      replayedPageId(
        workspaceId: ContentWorkspaceId,
        storageKey: string,
      ): Promise<string>;
    }>) {
    return draftRecordMutation({
      ...rest,
      recordKey: "pageId",
      replayedRecordId: replayedPageId,
      async run(application, command) {
        const mutation = await run(application, command);
        return {
          revision: mutation.revision,
          recordId: mutation.pageId,
          replayed: mutation.replayed,
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
    restructurePage(
      principal: McpConnectionPrincipal,
      input: McpRestructurePageInput,
      context: McpExecutionContext,
    ) {
      return pageMutation({
        principal,
        operation: "foundry.page.restructure",
        input,
        context,
        requiredScopes: mcpRestructureScopes(input.operations),
        refusalReason: pageSectionsRefusedReason,
        run: (application, command) =>
          application.commands.restructurePage({
            ...command,
            pageId: input.pageId,
            operations: input.operations,
          }),
        replayedPageId: async () => input.pageId,
      });
    },
    /**
     * Start a new blog post in the draft.
     *
     * The agent writes the post's words and picks its pictures; it never
     * chooses the post's id. The id is minted from this request, so a retry
     * after an unknown result mints the same id and leaves one post, not two.
     */
    createBlogPost(
      principal: McpConnectionPrincipal,
      input: McpCreateBlogPostInput,
      context: McpExecutionContext,
    ) {
      return draftRecordMutation({
        principal,
        operation: "foundry.blog.create",
        input,
        context,
        recordKey: "postId",
        refusalReason: blogPostRefusedReason,
        namedRefusal: blogRefusal,
        async run(application, command) {
          await requireOwnMediaReferences(input.post, (assetId) =>
            runtime.mediaLibraryHoldsAsset({ principal, assetId }),
          );
          const saved = await application.commands.createBlogPost({
            ...command,
            siteId: principal.siteId,
            post: {
              ...input.post,
              id: await mintedContentBlogPostId({
                workspaceId: command.workspaceId,
                idempotencyKey: command.idempotencyKey,
              }),
            },
          });
          return {
            revision: saved,
            recordId: saved.postId,
            replayed: saved.replayed,
          };
        },
        replayedRecordId: (workspaceId, idempotencyKey) =>
          mintedContentBlogPostId({ workspaceId, idempotencyKey }),
      });
    },
    /**
     * Rewrite one blog post in the draft.
     *
     * The whole post is sent, the way the dashboard's own editor saves it, so
     * a field the request leaves out is cleared rather than quietly kept.
     */
    updateBlogPost(
      principal: McpConnectionPrincipal,
      input: McpUpdateBlogPostInput,
      context: McpExecutionContext,
    ) {
      return draftRecordMutation({
        principal,
        operation: "foundry.blog.update",
        input,
        context,
        recordKey: "postId",
        refusalReason: blogPostRefusedReason,
        namedRefusal: blogRefusal,
        async run(application, command) {
          await requireOwnMediaReferences(input.post, (assetId) =>
            runtime.mediaLibraryHoldsAsset({ principal, assetId }),
          );
          const saved = await application.commands.editBlogPost({
            ...command,
            siteId: principal.siteId,
            postId: createBlogPostId(input.postId),
            post: input.post,
          });
          return {
            revision: saved,
            recordId: saved.postId,
            replayed: saved.replayed,
          };
        },
        replayedRecordId: async () => input.postId,
      });
    },
    /**
     * List the photos this site's media library holds.
     *
     * The list is a page at a time with an opaque marker, the same way the
     * published content list is. It names each photo, its type and its size,
     * and the site's own address for it, which is the address a blog post
     * must use. It never names who added a photo. See ADR-0037.
     */
    listMedia(
      principal: McpConnectionPrincipal,
      input: Readonly<{ limit: number; cursor: string | null }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.media.list",
        auditInput: input,
        requiredScopes: [mcpContentDraftScope],
        context,
        async run(execution) {
          if (
            !Number.isInteger(input.limit) ||
            input.limit < 1 ||
            input.limit > mcpMediaListMaxPageSize
          ) {
            throw new McpReadError(
              "VALIDATION_FAILED",
              `The page size must be between 1 and ${mcpMediaListMaxPageSize}.`,
            );
          }
          const query = "media:all";
          let offset = 0;
          if (input.cursor !== null) {
            const cursor = input.cursor;
            let binding: McpCursorBinding;
            try {
              binding = await execution.run(() =>
                runtime.cursors.decode(cursor),
              );
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
          const allAssets = await execution.run(() =>
            runtime.listMediaAssets({ principal }),
          );
          const items = allAssets.slice(offset, offset + input.limit);
          const nextOffset = offset + items.length;
          return {
            items,
            nextCursor:
              nextOffset < allAssets.length
                ? await execution.run(() =>
                    runtime.cursors.encode({
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
    /**
     * Add one photo to this site's media library.
     *
     * The picture travels as base64 inside the call, because no MCP tool
     * accepts a web address to fetch. The runtime reads the real picture type
     * and size from the bytes themselves, never from what the caller claimed,
     * and then runs the media library's own upload command. An upload writes
     * no draft revision, so it keeps its receipt in the media library's own
     * audit rather than the draft receipt table. See ADR-0037.
     */
    uploadMedia(
      principal: McpConnectionPrincipal,
      input: Readonly<{
        fileName: string;
        bytesBase64: string;
        idempotencyKey: string;
      }>,
      context: McpExecutionContext,
    ) {
      return base.executeScoped({
        principal,
        operation: "foundry.media.upload",
        // The picture's own bytes never enter the audit record. The file name
        // and the retry key identify the request on their own.
        auditInput: {
          fileName: input.fileName,
          idempotencyKey: input.idempotencyKey,
        },
        requiredScopes: [mcpContentDraftScope],
        context,
        async run(execution) {
          try {
            const source = decodeMediaUploadBytes(input.bytesBase64);
            return await execution.run(() =>
              runtime.uploadMediaAsset({
                principal,
                fileName: input.fileName,
                source,
                idempotencyKey: input.idempotencyKey,
              }),
            );
          } catch (error) {
            throw mediaRefusal(error);
          }
        },
      });
    },
    /**
     * Put one photo in one page's hero or detail slot, inside the draft.
     *
     * The photo has to be one this site's media library already holds, and
     * the page has to be one this draft holds. The result is a new immutable
     * revision, so the photo shows in the preview a person reviews.
     */
    placeMedia(
      principal: McpConnectionPrincipal,
      input: McpPlaceMediaInput,
      context: McpExecutionContext,
    ) {
      return draftRecordMutation({
        principal,
        operation: "foundry.media.place",
        input,
        context,
        recordKey: "occurrenceId",
        refusalReason: mediaUploadRefusedReason,
        async run(application, command) {
          const current = await application.queries.getCurrent();
          const page = findPageById(current.definition, input.pageId);
          if (page === undefined) {
            throw new McpReadError(
              "VALIDATION_FAILED",
              "This draft has no page with that id.",
              { reason: mediaPageNotFoundReason },
            );
          }
          const occurrenceId = pageMediaOccurrenceId(page, input.slot);
          let placed: McpPlacedMediaOccurrence;
          try {
            placed = await runtime.placeMediaOccurrence({
              principal,
              workspaceId: command.workspaceId,
              occurrenceId,
              assetId: input.assetId,
              idempotencyKey: command.idempotencyKey,
            });
          } catch (error) {
            throw mediaRefusal(error);
          }
          const saved = await application.commands.saveMediaOccurrence({
            ...command,
            occurrence: {
              occurrenceId:
                placed.occurrenceId as SiteMediaOccurrence["occurrenceId"],
              revision: placed.revision,
              asset: placed.asset,
              crop: null,
            },
          });
          return {
            revision: saved,
            recordId: placed.occurrenceId,
            // The draft already stood at the saved revision before this call,
            // so the draft answered from its own receipt rather than writing
            // a second time.
            replayed: saved.revision === current.revision,
          };
        },
        replayedRecordId: async (workspaceId) => {
          const application = await load(principal, workspaceId);
          const current = await application.queries.getCurrent();
          const page = findPageById(current.definition, input.pageId);
          if (page === undefined) {
            throw new McpReadError(
              "TEMPORARILY_UNAVAILABLE",
              "The replayed photo result is unavailable.",
            );
          }
          return pageMediaOccurrenceId(page, input.slot);
        },
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

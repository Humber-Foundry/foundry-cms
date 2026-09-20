import {
  AccessDeniedError,
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentPageOperationError,
  ContentRevisionValidationError,
  ContentRevisionConfigurationError,
  ContentRevisionStaleError,
  ContentWorkspaceAccessError,
  type ContentRevision,
  MediaSiteAccessError,
  MediaValidationError,
  createContentActorId,
  createContentWorkspaceId,
  createMediaAssetId,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "@/foundry/site-definition";
import {
  createSerializedRichTextDocument,
  createBlogPostId,
  isPageCompositionSlotId,
  parseSerializedRichTextDocument,
  RichTextValidationError,
  siteDefinitionMediaAssetIds,
  type PageComposition,
  type SeoMetadata,
  type SiteDefinition,
  type SiteDefinitionEdit,
  homePage,
} from "@humber-foundry/site-definition";

import { AccessIdentityError } from "../../../../src/access-identity";
import {
  contentWorkspaceIdForActor,
  contentWorkspaceIdForMutation,
  loadContentRevisionApplication,
  openDefaultContentWorkspace,
  requireExistingContentWorkspaceAccess,
} from "../../../../src/content-revision-runtime";
import {
  HumanAccessConfigurationError,
} from "../../../../src/human-access-configuration";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import {
  createHumanMediaAccessToken,
  createHumanMutationToken,
  verifyHumanMediaAccessToken,
  verifyHumanMutation,
} from "../../../../src/human-mutation-runtime";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";
import {
  MediaAssetConfigurationError,
  loadMediaAssetApplication,
} from "../../../../src/media-asset-runtime";
import { revisionPreviewGatewayUrl } from "../../../../src/content-revision-links";
import { createRevisionPreviewCapability } from "../../../../src/preview-capability-runtime";

type SaveBody = {
  workspaceId: ReturnType<typeof createContentWorkspaceId>;
  schemaVersion: SiteDefinition["schemaVersion"];
  baseRevision: number;
  edits: SiteDefinitionEdit[];
  compositions?: PageComposition[];
};

type BlogMutationBody =
  | Readonly<{
      operation: "create_blog_post";
      workspaceId: ReturnType<typeof createContentWorkspaceId>;
      schemaVersion: SiteDefinition["schemaVersion"];
      baseRevision: number;
      post: Omit<
        SiteDefinition["blog"]["posts"][number],
        "revision" | "collectionState" | "targetVisibility"
      >;
    }>
  | Readonly<{
      operation: "edit_blog_post";
      workspaceId: ReturnType<typeof createContentWorkspaceId>;
      schemaVersion: SiteDefinition["schemaVersion"];
      baseRevision: number;
      postId: SiteDefinition["blog"]["posts"][number]["id"];
      post: Omit<
        SiteDefinition["blog"]["posts"][number],
        "id" | "revision" | "collectionState" | "targetVisibility"
      >;
    }>
  | Readonly<{
      operation: "unpublish_blog_post";
      workspaceId: ReturnType<typeof createContentWorkspaceId>;
      schemaVersion: SiteDefinition["schemaVersion"];
      baseRevision: number;
      postId: SiteDefinition["blog"]["posts"][number]["id"];
    }>
  | Readonly<{
      operation: "republish_blog_post";
      workspaceId: ReturnType<typeof createContentWorkspaceId>;
      schemaVersion: SiteDefinition["schemaVersion"];
      baseRevision: number;
      postId: SiteDefinition["blog"]["posts"][number]["id"];
    }>;

type BlogMutationOperation = BlogMutationBody["operation"];

const blogMutationCommandTypes: Readonly<
  Record<
    BlogMutationOperation,
    | "blog.post.create"
    | "blog.post.edit"
    | "blog.post.unpublish"
    | "blog.post.republish"
  >
> = {
  create_blog_post: "blog.post.create",
  edit_blog_post: "blog.post.edit",
  unpublish_blog_post: "blog.post.unpublish",
  republish_blog_post: "blog.post.republish",
};

function isBlogMutationOperation(
  value: unknown,
): value is BlogMutationOperation {
  return (
    typeof value === "string" &&
    Object.hasOwn(blogMutationCommandTypes, value)
  );
}

/**
 * Read one share image. Absent and null both mean no picture. A present value
 * must carry both an address and a description; the schema validator then
 * decides whether the address itself is one this site will publish.
 */
function parseSeoShareImage(value: unknown): SeoMetadata["shareImage"] {
  if (value === undefined || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    typeof candidate.url !== "string" ||
    typeof candidate.alt !== "string"
  ) {
    throw new TypeError("blog_command_invalid");
  }
  return { url: candidate.url, alt: candidate.alt };
}

/**
 * Read one SEO and sharing block. Every field may be blank or absent, but a
 * field that is present and the wrong shape is a bad command, not something to
 * quietly repair: a silently dropped keyword would leave the composer showing
 * one list and the revision holding another.
 */
function parseSeoMetadata(value: unknown): SeoMetadata {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("blog_command_invalid");
  }
  const seo = value as Record<string, unknown>;
  if (
    typeof seo.title !== "string" ||
    typeof seo.description !== "string" ||
    (seo.keywords !== undefined &&
      (!Array.isArray(seo.keywords) ||
        seo.keywords.some((keyword) => typeof keyword !== "string")))
  ) {
    throw new TypeError("blog_command_invalid");
  }
  return {
    title: seo.title,
    description: seo.description,
    keywords: (seo.keywords ?? []) as ReadonlyArray<string>,
    shareImage: parseSeoShareImage(seo.shareImage),
  };
}

function parseBlogMutation(value: unknown): BlogMutationBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (!isBlogMutationOperation(candidate.operation)) {
    return null;
  }
  if (
    typeof candidate.workspaceId !== "string" ||
    candidate.schemaVersion !== installedSiteDefinition.schemaVersion ||
    !Number.isSafeInteger(candidate.baseRevision) ||
    (candidate.baseRevision as number) < 0
  ) {
    throw new TypeError("blog_command_invalid");
  }
  const common = {
    workspaceId: createContentWorkspaceId(candidate.workspaceId),
    schemaVersion: candidate.schemaVersion,
    baseRevision: candidate.baseRevision as number,
  };
  if (
    candidate.operation === "unpublish_blog_post" ||
    candidate.operation === "republish_blog_post"
  ) {
    if (typeof candidate.postId !== "string") {
      throw new TypeError("blog_command_invalid");
    }
    return {
      operation: candidate.operation,
      ...common,
      postId: createBlogPostId(candidate.postId),
    };
  }
  if (typeof candidate.post !== "object" || candidate.post === null) {
    throw new TypeError("blog_command_invalid");
  }
  const post = candidate.post as Record<string, unknown>;
  if (
    typeof post.slug !== "string" ||
    typeof post.title !== "string" ||
    typeof post.excerpt !== "string" ||
    typeof post.body !== "string"
  ) {
    throw new TypeError("blog_command_invalid");
  }
  const content = {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    seo: parseSeoMetadata(post.seo),
    mainImage: parseSeoShareImage(post.mainImage),
    body: parseSerializedRichTextDocument(
      createSerializedRichTextDocument(post.body),
    ),
  };
  if (candidate.operation === "create_blog_post") {
    if (typeof post.id !== "string") {
      throw new TypeError("blog_command_invalid");
    }
    return {
      operation: candidate.operation,
      ...common,
      post: { id: createBlogPostId(post.id), ...content },
    };
  }
  if (typeof candidate.postId !== "string") {
    throw new TypeError("blog_command_invalid");
  }
  return {
    operation: candidate.operation,
    ...common,
    postId: createBlogPostId(candidate.postId),
    post: content,
  };
}

/**
 * A page operation asked for by the dashboard.
 *
 * Every one carries the same four things as a save: which draft, which
 * schema, which revision the owner read before they decided, and — in the
 * request header — the key that makes a retry safe. The page id is minted by
 * the application, never sent by the browser, so a create cannot be talked
 * into taking an id that is already in use. See ADR-0033.
 */
type PageMutationCommon = Readonly<{
  workspaceId: ReturnType<typeof createContentWorkspaceId>;
  schemaVersion: SiteDefinition["schemaVersion"];
  baseRevision: number;
}>;

type PageMutationBody =
  | (PageMutationCommon &
      Readonly<{
        operation: "create_page";
        title: string;
        slug: string;
        startingLayout: string;
      }>)
  | (PageMutationCommon &
      Readonly<{
        operation: "rename_page";
        pageId: string;
        title: string;
        slug: string;
      }>)
  | (PageMutationCommon &
      Readonly<{
        operation: "duplicate_page";
        pageId: string;
        title: string;
        slug: string;
      }>)
  | (PageMutationCommon &
      Readonly<{ operation: "delete_page"; pageId: string }>);

const pageMutationOperations = [
  "create_page",
  "rename_page",
  "duplicate_page",
  "delete_page",
] as const;

function isPageMutationOperation(
  value: unknown,
): value is PageMutationBody["operation"] {
  return (pageMutationOperations as ReadonlyArray<unknown>).includes(value);
}

function parsePageMutation(value: unknown): PageMutationBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (!isPageMutationOperation(candidate.operation)) {
    return null;
  }
  if (
    typeof candidate.workspaceId !== "string" ||
    candidate.schemaVersion !== installedSiteDefinition.schemaVersion ||
    !Number.isSafeInteger(candidate.baseRevision) ||
    (candidate.baseRevision as number) < 0
  ) {
    throw new TypeError("page_command_invalid");
  }
  const common = {
    workspaceId: createContentWorkspaceId(candidate.workspaceId),
    schemaVersion: candidate.schemaVersion,
    baseRevision: candidate.baseRevision as number,
  };
  if (candidate.operation === "delete_page") {
    if (typeof candidate.pageId !== "string") {
      throw new TypeError("page_command_invalid");
    }
    return { operation: "delete_page", ...common, pageId: candidate.pageId };
  }
  if (typeof candidate.title !== "string" || typeof candidate.slug !== "string") {
    throw new TypeError("page_command_invalid");
  }
  if (candidate.operation === "create_page") {
    if (typeof candidate.startingLayout !== "string") {
      throw new TypeError("page_command_invalid");
    }
    return {
      operation: "create_page",
      ...common,
      title: candidate.title,
      slug: candidate.slug,
      startingLayout: candidate.startingLayout,
    };
  }
  if (typeof candidate.pageId !== "string") {
    throw new TypeError("page_command_invalid");
  }
  return {
    operation: candidate.operation,
    ...common,
    pageId: candidate.pageId,
    title: candidate.title,
    slug: candidate.slug,
  };
}

async function savePageMutation(
  application: Awaited<ReturnType<typeof loadContentRevisionApplication>>,
  mutation: PageMutationBody,
  command: {
    actorId: ReturnType<typeof createContentActorId>;
    workspaceId: PageMutationBody["workspaceId"];
    schemaVersion: SiteDefinition["schemaVersion"];
    baseRevision: number;
    idempotencyKey: string;
  },
) {
  switch (mutation.operation) {
    case "create_page":
      return application.commands.createPage({
        ...command,
        title: mutation.title,
        slug: mutation.slug,
        startingLayout: mutation.startingLayout,
      });
    case "rename_page":
      return application.commands.renamePage({
        ...command,
        pageId: mutation.pageId,
        title: mutation.title,
        slug: mutation.slug,
      });
    case "duplicate_page":
      return application.commands.duplicatePage({
        ...command,
        pageId: mutation.pageId,
        title: mutation.title,
        slug: mutation.slug,
      });
    case "delete_page":
      return application.commands.deletePage({
        ...command,
        pageId: mutation.pageId,
      });
  }
}

async function saveBlogMutation(
  application: Awaited<ReturnType<typeof loadContentRevisionApplication>>,
  mutation: BlogMutationBody,
  command: {
    actorId: ReturnType<typeof createContentActorId>;
    workspaceId: BlogMutationBody["workspaceId"];
    siteId: SiteDefinition["site"]["id"];
    schemaVersion: SiteDefinition["schemaVersion"];
    baseRevision: number;
    idempotencyKey: string;
  },
) {
  switch (mutation.operation) {
    case "create_blog_post":
      return application.commands.createBlogPost({
        ...command,
        post: mutation.post,
      });
    case "edit_blog_post":
      return application.commands.editBlogPost({
        ...command,
        postId: mutation.postId,
        post: mutation.post,
      });
    case "unpublish_blog_post":
      return application.commands.unpublishBlogPost({
        ...command,
        postId: mutation.postId,
      });
    case "republish_blog_post":
      return application.commands.republishBlogPost({
        ...command,
        postId: mutation.postId,
      });
  }
}

function selectedBlogPostId(
  mutation: BlogMutationBody,
): SiteDefinition["blog"]["posts"][number]["id"] | null {
  return mutation.operation === "unpublish_blog_post"
    ? null
    : mutation.operation === "create_blog_post"
      ? mutation.post.id
      : mutation.postId;
}

export async function GET(request: Request) {
  try {
    const authenticated = await loadHumanIdentityRequestContext(
      request.headers,
    );
    const access = await authorizeAuthenticatedHumanIdentity(authenticated);
    if (access.state !== "authorized") {
      throw new AccessDeniedError("membership_not_active");
    }
    const url = new URL(request.url);
    const workspaceParameter = url.searchParams.get("workspaceId");
    const revisionParameter = url.searchParams.get("revision");
    const postParameter = url.searchParams.get("post");
    const mediaAccessToken = url.searchParams.get("accessToken");
    if (workspaceParameter === null && revisionParameter === null) {
      return Response.json(
        {
          mutationToken: await createHumanMutationToken(access.identity),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (workspaceParameter === null || revisionParameter === null) {
      return Response.json({ error: "invalid_preview" }, { status: 400 });
    }
    const revisionNumber = Number(revisionParameter);
    if (
      !Number.isSafeInteger(revisionNumber) ||
      revisionNumber < 0 ||
      String(revisionNumber) !== revisionParameter
    ) {
      return Response.json({ error: "invalid_preview" }, { status: 400 });
    }
    const workspaceId = createContentWorkspaceId(workspaceParameter);
    const actorId = createContentActorId(access.membership.id);
    await requireExistingContentWorkspaceAccess(workspaceId, actorId);
    const application = await loadContentRevisionApplication(
      workspaceId,
      actorId,
    );
    const revision = await application.queries.getRevisionWithBookmark(
      revisionNumber,
    );
    if (
      revision === null ||
      !(await application.queries.isRevisionCurrent(revision))
    ) {
      return Response.json({ error: "preview_unavailable" }, { status: 409 });
    }
    if (
      postParameter !== null &&
      !revision.definition.blog.posts.some(
        ({ slug, targetVisibility }) =>
          slug === postParameter && targetVisibility === "public",
      )
    ) {
      return Response.json({ error: "preview_unavailable" }, { status: 409 });
    }
    const capability = await createRevisionPreviewCapability({
      identity: access.identity,
      workspaceId,
      revision: revisionNumber,
    });
    const revisionAssetIds = [
      ...new Set(
        (homePage(revision.definition).media ?? []).map(
          (occurrence) => occurrence.asset.assetId,
        ),
      ),
    ];
    await Promise.all(
      revisionAssetIds.map((assetId) =>
        verifyHumanMediaAccessToken(
          mediaAccessToken,
          access.identity,
          assetId,
        ),
      ),
    );
    const previewQuery = new URLSearchParams({
      capability,
      bookmark: revision.bookmark,
      ...(mediaAccessToken === null
        ? {}
        : { accessToken: mediaAccessToken }),
    });
    const previewUrl =
      `/__foundry/preview/${workspaceId}/${revisionNumber}` +
      (postParameter === null
        ? ""
        : `/blog/${encodeURIComponent(postParameter)}`) +
      `?${previewQuery.toString()}`;
    return Response.redirect(new URL(previewUrl, request.url), 307);
  } catch (error) {
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof ContentWorkspaceAccessError ||
      error instanceof HumanRequestIntegrityError
    ) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (
      error instanceof HumanAccessConfigurationError ||
      error instanceof ContentRevisionConfigurationError ||
      error instanceof MediaAssetConfigurationError
    ) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    if (error instanceof TypeError) {
      return Response.json({ error: "invalid_preview" }, { status: 400 });
    }
    throw error;
  }
}

function parseSaveBody(
  value: unknown,
):
  | Readonly<{ ok: true; body: SaveBody }>
  | Readonly<{ ok: false; fields?: Readonly<Record<string, string>> }> {
  if (typeof value !== "object" || value === null) {
    return { ok: false };
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.baseRevision) ||
    (candidate.baseRevision as number) < 0 ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.schemaVersion !== "string" ||
    !Array.isArray(candidate.edits)
  ) {
    return { ok: false };
  }
  // A save carries one structural change per page, each naming its own page
  // through its slot id. The shape is checked here; whether the site holds
  // that page is the domain's decision. Two changes for the same page would
  // make the result depend on their order, so they are refused.
  const isComposition = (entry: unknown): entry is PageComposition =>
    typeof entry === "object" &&
    entry !== null &&
    "slotId" in entry &&
    typeof entry.slotId === "string" &&
    isPageCompositionSlotId(entry.slotId) &&
    "components" in entry &&
    Array.isArray(entry.components);
  // A browser tab opened before this release still sends one `composition`.
  // It is read as a list of one, so an owner mid-edit at the moment of release
  // does not silently lose their unsaved structural change.
  const submitted =
    "compositions" in candidate
      ? candidate.compositions
      : candidate.composition === undefined
        ? undefined
        : [candidate.composition];
  const compositions =
    submitted === undefined
      ? undefined
      : Array.isArray(submitted) &&
          submitted.every(isComposition) &&
          new Set(
            (submitted as PageComposition[]).map(({ slotId }) => slotId),
          ).size === submitted.length
        ? (submitted as PageComposition[])
        : undefined;
  if (
    candidate.edits.length === 0 &&
    (compositions === undefined || compositions.length === 0)
  ) {
    return { ok: false };
  }
  if (submitted !== undefined && compositions === undefined) {
    return {
      ok: false,
      fields: {
        compositions:
          "Provide a registered slot and its component collection for each page.",
      },
    };
  }
  const errors = Object.create(null) as Record<string, string>;
  const edits: SiteDefinitionEdit[] = [];
  candidate.edits.forEach((edit, index) => {
    if (typeof edit !== "object" || edit === null) {
      errors[`edits.${index}`] = "Provide a field path and text value.";
      return;
    }
    const entry = edit as Record<string, unknown>;
    const path =
      typeof entry.path === "string" ? entry.path : `edits.${index}.path`;
    if (typeof entry.path !== "string") {
      errors[path] = "Provide a stable Site Definition field path.";
    } else if (typeof entry.value !== "string") {
      errors[path] = "Enter a text value.";
    } else if (
      entry.format !== undefined &&
      entry.format !== "plainText" &&
      entry.format !== "richText"
    ) {
      errors[path] = "Provide a supported field value format.";
    } else if (entry.format === "richText") {
      try {
        edits.push({
          path: entry.path,
          format: "richText",
          value: createSerializedRichTextDocument(entry.value),
        });
      } catch {
        errors[path] =
          "Rich text is invalid or contains unsupported or unsafe content.";
      }
    } else {
      edits.push(
        entry.format === "plainText"
          ? {
              path: entry.path,
              format: "plainText",
              value: entry.value,
            }
          : {
              path: entry.path,
              value: entry.value,
            },
      );
    }
  });
  if (Object.keys(errors).length > 0) {
    return { ok: false, fields: errors };
  }
  try {
    return {
      ok: true,
      body: {
        workspaceId: createContentWorkspaceId(candidate.workspaceId),
        schemaVersion:
          candidate.schemaVersion as SiteDefinition["schemaVersion"],
        baseRevision: candidate.baseRevision as number,
        edits,
        ...(compositions === undefined ? {} : { compositions }),
      },
    };
  } catch {
    return {
      ok: false,
      fields: { workspaceId: "Provide a valid workspace ID." },
    };
  }
}

export async function POST(request: Request) {
  try {
    const authenticated = await loadHumanIdentityRequestContext(
      request.headers,
    );
    await verifyHumanMutation(request, authenticated.identity);
    const access = await authorizeAuthenticatedHumanIdentity(authenticated);
    if (access.state !== "authorized") {
      throw new AccessDeniedError("membership_not_active");
    }
    const submitted: unknown = await request.json();
    const actorId = createContentActorId(access.membership.id);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    let blogMutation: BlogMutationBody | null;
    try {
      blogMutation = parseBlogMutation(submitted);
    } catch (error) {
      if (
        (error instanceof TypeError ||
          error instanceof RichTextValidationError) &&
        typeof submitted === "object" &&
        submitted !== null &&
        "operation" in submitted &&
        isBlogMutationOperation(submitted.operation)
      ) {
        const candidate = submitted as Record<string, unknown>;
        const rawPostId =
          candidate.operation === "create_blog_post" &&
          typeof candidate.post === "object" &&
          candidate.post !== null
            ? (candidate.post as Record<string, unknown>).id
            : candidate.postId;
        let postId = null;
        if (typeof rawPostId === "string") {
          try {
            postId = createBlogPostId(rawPostId);
          } catch {
            // A malformed target is represented by the null audit target.
          }
        }
        let workspaceId = await contentWorkspaceIdForActor(actorId);
        if (typeof candidate.workspaceId === "string") {
          try {
            const requestedWorkspaceId = createContentWorkspaceId(
              candidate.workspaceId,
            );
            await requireExistingContentWorkspaceAccess(
              requestedWorkspaceId,
              actorId,
            );
            workspaceId = requestedWorkspaceId;
          } catch (workspaceError) {
            if (
              !(workspaceError instanceof TypeError) &&
              !(workspaceError instanceof ContentWorkspaceAccessError)
            ) {
              throw workspaceError;
            }
          }
        }
        const application = await loadContentRevisionApplication(
          workspaceId,
          actorId,
        );
        await application.commands.recordRejectedBlogPostCommand({
          actorId,
          postId,
          commandType:
            blogMutationCommandTypes[
              candidate.operation as BlogMutationOperation
            ],
          reasonCode: "blog_command_invalid",
          requestId: idempotencyKey,
        });
        return Response.json({ error: "invalid_command" }, { status: 400 });
      }
      throw error;
    }
    if (blogMutation !== null) {
      const application = await loadContentRevisionApplication(
        blogMutation.workspaceId,
        actorId,
      );
      const command = {
        actorId,
        workspaceId: blogMutation.workspaceId,
        siteId: installedSiteDefinition.site.id,
        schemaVersion: blogMutation.schemaVersion,
        baseRevision: blogMutation.baseRevision,
        idempotencyKey,
      };
      const saved = await saveBlogMutation(
        application,
        blogMutation,
        command,
      );
      const selectedId = selectedBlogPostId(blogMutation);
      const selectedPost = saved.definition.blog.posts.find(
        ({ id }) => id === selectedId,
      );
      const previewQuery =
        selectedPost === undefined
          ? ""
          : `&post=${encodeURIComponent(selectedPost.slug)}`;
      return Response.json(
        {
          ...saved,
          previewUrl:
            `${revisionPreviewGatewayUrl(saved.workspaceId, saved.revision)}` +
            previewQuery,
        },
        { status: 201 },
      );
    }
    const pageMutation = parsePageMutation(submitted);
    if (pageMutation !== null) {
      const application = await loadContentRevisionApplication(
        pageMutation.workspaceId,
        actorId,
      );
      const result = await savePageMutation(application, pageMutation, {
        actorId,
        workspaceId: pageMutation.workspaceId,
        schemaVersion: pageMutation.schemaVersion,
        baseRevision: pageMutation.baseRevision,
        idempotencyKey,
      });
      return Response.json(
        {
          ...result.revision,
          // The page the operation acted on: the new page for a create or a
          // duplicate, so the dashboard can open it straight away.
          pageId: result.pageId,
          previewUrl: revisionPreviewGatewayUrl(
            result.revision.workspaceId,
            result.revision.revision,
          ),
        },
        { status: 201 },
      );
    }
    const operation =
      typeof submitted === "object" &&
      submitted !== null &&
      "operation" in submitted &&
      (submitted.operation === "create_default_workspace" ||
        submitted.operation === "create_workspace")
        ? submitted.operation
        : undefined;
    if (
      typeof submitted === "object" &&
      submitted !== null &&
      "operation" in submitted &&
      submitted.operation === "open_preview"
    ) {
      const candidate = submitted as Record<string, unknown>;
      if (
        typeof candidate.workspaceId !== "string" ||
        !Number.isSafeInteger(candidate.revision) ||
        (candidate.revision as number) < 0 ||
        !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)
      ) {
        return Response.json({ error: "invalid_command" }, { status: 400 });
      }
      let workspaceId;
      try {
        workspaceId = createContentWorkspaceId(candidate.workspaceId);
      } catch {
        return Response.json({ error: "invalid_command" }, { status: 400 });
      }
      await requireExistingContentWorkspaceAccess(workspaceId, actorId);
      const application = await loadContentRevisionApplication(
        workspaceId,
        actorId,
      );
      const revision = await application.queries.getRevisionWithBookmark(
        candidate.revision as number,
      );
      if (
        revision === null ||
        !(await application.queries.isRevisionCurrent(revision))
      ) {
        return Response.json(
          { error: "preview_unavailable" },
          { status: 409 },
        );
      }
      // Every photo the previewed revision references — placed occurrences and
      // page-component image fields — so the authenticated preview can fetch
      // each one at full resolution.
      const requestedAssetIds = [
        ...siteDefinitionMediaAssetIds(revision.definition),
      ].map((assetId) => createMediaAssetId(assetId));
      const mediaApplication = await loadMediaAssetApplication(actorId);
      const grant = await mediaApplication.commands.grantRevisionAccess({
        actorId,
        workspaceId,
        assetIds: requestedAssetIds,
        idempotencyKey,
      });
      const mediaCapability = await createHumanMediaAccessToken(
        access.identity,
        grant.assetIds,
        grant.accessGrantedAt,
      );
      const previewCapability = await createRevisionPreviewCapability({
        identity: access.identity,
        workspaceId,
        revision: revision.revision,
      });
      const previewQuery = new URLSearchParams({
        capability: previewCapability,
        bookmark: revision.bookmark,
        accessToken: mediaCapability.token,
      });
      return Response.json({
        previewUrl:
          `/__foundry/preview/${workspaceId}/${revision.revision}?${previewQuery.toString()}`,
      });
    }
    if (operation !== undefined) {
      // The default workspace goes through the shared open operation, so this
      // API operation and the dashboard's own first visit create it the same
      // way. A `create_workspace` request asks for a separate workspace, whose
      // id comes from the request's own idempotency key.
      let created: ContentRevision;
      if (operation === "create_default_workspace") {
        created = (
          await openDefaultContentWorkspace(actorId, idempotencyKey)
        ).revision;
      } else {
        const workspaceId = await contentWorkspaceIdForMutation(
          actorId,
          idempotencyKey,
        );
        const application = await loadContentRevisionApplication(
          workspaceId,
          actorId,
        );
        created = await application.commands.create({
          actorId,
          workspaceId,
          idempotencyKey,
        });
      }
      return Response.json(
        {
          ...created,
          previewUrl: revisionPreviewGatewayUrl(
            created.workspaceId,
            created.revision,
          ),
        },
        { status: 201 },
      );
    }
    const parsed = parseSaveBody(submitted);
    if (!parsed.ok && parsed.fields !== undefined) {
      return Response.json(
        { error: "validation_failed", fields: parsed.fields },
        { status: 422 },
      );
    }
    if (!parsed.ok) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    const body = parsed.body;
    const application = await loadContentRevisionApplication(
      body.workspaceId,
      actorId,
    );
    const saved = await application.commands.save({
      actorId,
      workspaceId: body.workspaceId,
      schemaVersion: body.schemaVersion,
      baseRevision: body.baseRevision,
      edits: body.edits,
      ...(body.compositions === undefined
        ? {}
        : { compositions: body.compositions }),
      idempotencyKey,
    });
    return Response.json(
      {
        ...saved,
        previewUrl: revisionPreviewGatewayUrl(
          saved.workspaceId,
          saved.revision,
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    // A refused page operation is a validation failure with two extra things
    // the dashboard shows: the stable reason, and the links that still point
    // at a page whose delete was refused.
    if (error instanceof ContentPageOperationError) {
      return Response.json(
        {
          error: "validation_failed",
          fields: error.fields,
          reason: error.code,
          references: error.references,
        },
        { status: 422 },
      );
    }
    if (error instanceof ContentRevisionValidationError) {
      return Response.json(
        { error: "validation_failed", fields: error.fields },
        { status: 422 },
      );
    }
    if (error instanceof ContentRevisionConflictError) {
      return Response.json(
        {
          error: "revision_conflict",
          currentRevision: error.currentRevision,
        },
        { status: 409 },
      );
    }
    if (error instanceof ContentRevisionIdempotencyError) {
      return Response.json(
        { error: "idempotency_key_conflict" },
        { status: 409 },
      );
    }
    if (error instanceof MediaValidationError) {
      return Response.json(
        { error: "idempotency_key_conflict" },
        { status: 409 },
      );
    }
    if (error instanceof ContentRevisionStaleError) {
      return Response.json(
        {
          error: "revision_stale",
          ...(error.acknowledgedRevision === undefined
            ? {}
            : { acknowledgedRevision: error.acknowledgedRevision }),
        },
        { status: 409 },
      );
    }
    if (
      error instanceof ContentWorkspaceAccessError ||
      error instanceof MediaSiteAccessError
    ) {
      return Response.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    if (
      error instanceof AccessIdentityError ||
      error instanceof AccessDeniedError ||
      error instanceof HumanRequestIntegrityError
    ) {
      return Response.json({ error: "request_check_failed" }, { status: 403 });
    }
    if (
      error instanceof HumanAccessConfigurationError ||
      error instanceof ContentRevisionConfigurationError ||
      error instanceof MediaAssetConfigurationError
    ) {
      return Response.json(
        { error: "request_check_unavailable" },
        { status: 503 },
      );
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return Response.json({ error: "invalid_command" }, { status: 400 });
    }
    throw error;
  }
}

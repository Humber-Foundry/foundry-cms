import {
  AccessDeniedError,
  ContentRevisionConflictError,
  ContentRevisionIdempotencyError,
  ContentRevisionValidationError,
  ContentRevisionConfigurationError,
  ContentRevisionStaleError,
  ContentWorkspaceAccessError,
  MediaSiteAccessError,
  MediaValidationError,
  createContentActorId,
  createContentWorkspaceId,
  createMediaAssetId,
} from "@foundry/application";
import {
  createSerializedRichTextDocument,
  createBlogPostId,
  parseSerializedRichTextDocument,
  referenceSiteDefinition,
  type PageComposition,
  type SiteDefinition,
  type SiteDefinitionEdit,
} from "@foundry/site-definition";

import { AccessIdentityError } from "../../../../src/access-identity";
import {
  contentWorkspaceIdForActor,
  contentWorkspaceIdForMutation,
  loadContentRevisionApplication,
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
  composition?: PageComposition;
};

type BlogMutationBody =
  | Readonly<{
      operation: "create_blog_post";
      workspaceId: ReturnType<typeof createContentWorkspaceId>;
      schemaVersion: SiteDefinition["schemaVersion"];
      baseRevision: number;
      post: Omit<
        SiteDefinition["blog"]["posts"][number],
        "revision" | "visibility"
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
        "id" | "revision" | "visibility"
      >;
    }>
  | Readonly<{
      operation: "unpublish_blog_post";
      workspaceId: ReturnType<typeof createContentWorkspaceId>;
      schemaVersion: SiteDefinition["schemaVersion"];
      baseRevision: number;
      postId: SiteDefinition["blog"]["posts"][number]["id"];
    }>;

function parseBlogMutation(value: unknown): BlogMutationBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.operation !== "create_blog_post" &&
    candidate.operation !== "edit_blog_post" &&
    candidate.operation !== "unpublish_blog_post"
  ) {
    return null;
  }
  if (
    typeof candidate.workspaceId !== "string" ||
    candidate.schemaVersion !== referenceSiteDefinition.schemaVersion ||
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
  if (candidate.operation === "unpublish_blog_post") {
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
    typeof post.seo !== "object" ||
    post.seo === null ||
    typeof (post.seo as Record<string, unknown>).title !== "string" ||
    typeof (post.seo as Record<string, unknown>).description !== "string" ||
    typeof post.body !== "string"
  ) {
    throw new TypeError("blog_command_invalid");
  }
  const content = {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    seo: {
      title: (post.seo as Record<string, string>).title!,
      description: (post.seo as Record<string, string>).description!,
    },
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
        ({ slug, visibility }) =>
          slug === postParameter && visibility === "public",
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
        (revision.definition.home.media ?? []).map(
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
  const composition =
    typeof candidate.composition === "object" &&
    candidate.composition !== null &&
    "slotId" in candidate.composition &&
    candidate.composition.slotId === "slot_home_sections" &&
    "components" in candidate.composition &&
    Array.isArray(candidate.composition.components)
      ? (candidate.composition as PageComposition)
      : undefined;
  if (candidate.edits.length === 0 && composition === undefined) {
    return { ok: false };
  }
  if (candidate.composition !== undefined && composition === undefined) {
    return {
      ok: false,
      fields: {
        composition:
          "Provide a registered slot and its component collection.",
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
        ...(composition === undefined ? {} : { composition }),
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
        error instanceof TypeError &&
        typeof submitted === "object" &&
        submitted !== null &&
        "operation" in submitted &&
        (submitted.operation === "create_blog_post" ||
          submitted.operation === "edit_blog_post" ||
          submitted.operation === "unpublish_blog_post")
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
        const workspaceId = await contentWorkspaceIdForActor(actorId);
        const application = await loadContentRevisionApplication(
          workspaceId,
          actorId,
        );
        await application.commands.recordRejectedBlogPostCommand({
          actorId,
          postId,
          commandType:
            candidate.operation === "create_blog_post"
              ? "blog.post.create"
              : candidate.operation === "edit_blog_post"
                ? "blog.post.edit"
                : "blog.post.unpublish",
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
        siteId: referenceSiteDefinition.site.id,
        schemaVersion: blogMutation.schemaVersion,
        baseRevision: blogMutation.baseRevision,
        idempotencyKey,
      };
      const saved =
        blogMutation.operation === "create_blog_post"
          ? await application.commands.createBlogPost({
              ...command,
              post: blogMutation.post,
            })
          : blogMutation.operation === "edit_blog_post"
            ? await application.commands.editBlogPost({
                ...command,
                postId: blogMutation.postId,
                post: blogMutation.post,
              })
            : await application.commands.unpublishBlogPost({
                ...command,
                postId: blogMutation.postId,
              });
      const selectedPost =
        blogMutation.operation === "unpublish_blog_post"
          ? undefined
          : saved.definition.blog.posts.find(
              ({ id }) =>
                id ===
                (blogMutation.operation === "create_blog_post"
                  ? blogMutation.post.id
                  : blogMutation.postId),
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
      const requestedAssetIds = [
        ...new Set(
          (revision.definition.home.media ?? []).map((occurrence) =>
            createMediaAssetId(occurrence.asset.assetId),
          ),
        ),
      ];
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
      const workspaceId =
        operation === "create_default_workspace"
          ? await contentWorkspaceIdForActor(actorId)
          : await contentWorkspaceIdForMutation(actorId, idempotencyKey);
      const application = await loadContentRevisionApplication(
        workspaceId,
        actorId,
      );
      const created = await application.commands.create({
        actorId,
        workspaceId,
        idempotencyKey,
      });
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
      ...(body.composition === undefined
        ? {}
        : { composition: body.composition }),
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

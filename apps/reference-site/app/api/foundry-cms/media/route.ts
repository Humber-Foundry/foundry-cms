import {
  AccessDeniedError,
  MediaAssetReferencedError,
  MediaMutationInProgressError,
  MediaOccurrenceConflictError,
  MediaSiteAccessError,
  MediaValidationError,
  ContentRevisionConflictError,
  ContentRevisionConfigurationError,
  ContentRevisionStaleError,
  ContentRevisionValidationError,
  ContentWorkspaceAccessError,
  createContentActorId,
  createContentWorkspaceId,
  createMediaAssetId,
  createMediaOccurrenceId,
  mediaThumbnailMaxByteLength,
  requireRenderedMediaOccurrenceId,
  type MediaThumbnailUpload,
} from "@humber-foundry/application";

import { siteDefinitionMediaAssetIds } from "@humber-foundry/site-definition";

import { installedSiteDefinition } from "@/foundry/site-definition";

import {
  AccessIdentityError,
  AccessIdentityUnavailableError,
} from "../../../../src/access-identity";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import {
  HumanAccessConfigurationError,
} from "../../../../src/human-access-configuration";
import {
  createHumanMediaAccessToken,
  createHumanMediaLibraryToken,
  verifyHumanMediaAccessToken,
  verifyHumanMediaLibraryToken,
  verifyHumanMutation,
} from "../../../../src/human-mutation-runtime";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";
import {
  MediaAssetConfigurationError,
  loadMediaAssetApplication,
} from "../../../../src/media-asset-runtime";
import {
  contentWorkspaceIdForActor,
  loadContentRevisionApplication,
  requireExistingContentWorkspaceAccess,
} from "../../../../src/content-revision-runtime";
import { revisionPreviewGatewayUrl } from "../../../../src/content-revision-links";
import { inspectImageSource } from "../../../../src/image-source-metadata";

async function authorized(request: Request) {
  const authenticated = await loadHumanIdentityRequestContext(request.headers);
  const access = await authorizeAuthenticatedHumanIdentity(authenticated);
  if (access.state !== "authorized") {
    throw new AccessDeniedError("membership_not_active");
  }
  return {
    authenticated,
    actorId: createContentActorId(access.membership.id),
  };
}

/**
 * The stored objects this route serves. `thumbnail` is the small copy the
 * dashboard gallery shows; anything else is the full-resolution source.
 */
function mediaResponse(
  media: Readonly<{
    body: Uint8Array | ReadableStream<Uint8Array>;
    contentType: string;
  }>,
  variant: "thumbnail" | "source",
) {
  return new Response(
    media.body instanceof Uint8Array
      ? (media.body.slice().buffer as ArrayBuffer)
      : media.body,
    {
      headers: {
        "cache-control": "private, no-store",
        "content-type": media.contentType,
        "x-content-type-options": "nosniff",
        "x-foundry-media-variant": variant,
      },
    },
  );
}

export async function GET(request: Request) {
  try {
    const { authenticated, actorId } = await authorized(request);
    const application = await loadMediaAssetApplication(actorId);
    const searchParams = new URL(request.url).searchParams;
    const requestedAsset = searchParams.get("assetId");
    const requestedVariant = searchParams.get("variant");
    if (requestedVariant !== null && requestedVariant !== "thumbnail") {
      return Response.json({ error: "invalid_query" }, { status: 400 });
    }
    if (requestedAsset !== null) {
      // A thumbnail is unlocked by the library capability, which names no
      // asset, because the gallery shows every photo. That capability can
      // reach nothing else: this branch never serves the source, not even
      // when no thumbnail was stored. The full-resolution source keeps the
      // capability that names the exact assets it covers.
      if (requestedVariant === "thumbnail") {
        await verifyHumanMediaLibraryToken(
          searchParams.get("libraryToken"),
          authenticated.identity,
        );
        const thumbnail = await application.queries.getThumbnailSource(
          createMediaAssetId(requestedAsset),
        );
        if (thumbnail === null) {
          // An asset stored before thumbnails existed has none. The gallery
          // shows the tile without a preview rather than paying for the
          // original.
          return Response.json({ error: "media_not_found" }, { status: 404 });
        }
        return mediaResponse(thumbnail, "thumbnail");
      }
      await verifyHumanMediaAccessToken(
        searchParams.get("accessToken"),
        authenticated.identity,
        requestedAsset,
      );
      const source = await application.queries.getSource(
        createMediaAssetId(requestedAsset),
      );
      if (source === null) {
        return Response.json({ error: "media_not_found" }, { status: 404 });
      }
      return mediaResponse(source, "source");
    }
    return Response.json({ error: "invalid_query" }, { status: 400 });
  } catch (error) {
    return mediaError(error);
  }
}

type CropCoordinates = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}> | null;

function sameCrop(left: CropCoordinates, right: CropCoordinates) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  );
}

function isSameWorkspaceOccurrence(
  current: Readonly<{
    occurrenceId: string;
    revision: number;
    assetId: string;
    crop: CropCoordinates;
  }> | null,
  expected: Readonly<{
    occurrenceId: string;
    revision: number;
    assetId: string;
    crop: CropCoordinates;
  }>,
) {
  return (
    current !== null &&
    current.occurrenceId === expected.occurrenceId &&
    current.revision === expected.revision &&
    current.assetId === expected.assetId &&
    sameCrop(current.crop, expected.crop)
  );
}

function isSameContentOccurrence(
  current: Readonly<{
    occurrenceId: string;
    revision: number;
    asset: Readonly<{
      assetId: string;
      width: number;
      height: number;
      contentType: string;
    }>;
    crop: CropCoordinates;
  }> | undefined,
  expected: Readonly<{
    occurrenceId: string;
    revision: number;
    asset: Readonly<{
      assetId: string;
      width: number;
      height: number;
      contentType: string;
    }>;
    crop: CropCoordinates;
  }>,
) {
  return (
    current !== undefined &&
    current.occurrenceId === expected.occurrenceId &&
    current.revision === expected.revision &&
    current.asset.assetId === expected.asset.assetId &&
    current.asset.width === expected.asset.width &&
    current.asset.height === expected.asset.height &&
    current.asset.contentType === expected.asset.contentType &&
    sameCrop(current.crop, expected.crop)
  );
}

function isSameOptionalContentOccurrence(
  left: Parameters<typeof isSameContentOccurrence>[0],
  right: Parameters<typeof isSameContentOccurrence>[0],
) {
  return left === undefined
    ? right === undefined
    : right !== undefined && isSameContentOccurrence(left, right);
}

function assertContentOccurrenceMutationSafe(
  binding: Awaited<ReturnType<typeof loadContentBinding>>,
  occurrenceId: string,
  baseRevision: number,
  workspaceOccurrence: Readonly<{ revision: number }> | null,
) {
  const selected = (revision: typeof binding.current) =>
    (revision.definition.home.media ?? []).find(
      (candidate) => candidate.occurrenceId === occurrenceId,
    );
  if (
    !isSameOptionalContentOccurrence(
      selected(binding.base),
      selected(binding.current),
    )
  ) {
    // A completed attempt has already advanced the workspace head, so invoking
    // the command can only replay its receipt or fail optimistic concurrency.
    // A head at or behind the requested base could still mutate, so reject it
    // before the media command when the content slot has diverged.
    if (
      workspaceOccurrence !== null &&
      workspaceOccurrence.revision > baseRevision
    ) {
      return;
    }
    throw new ContentRevisionConflictError(binding.current.revision);
  }
}

async function bindOccurrenceToContentRevision({
  actorId,
  idempotencyKey,
  occurrence,
  application,
  binding,
}: {
  actorId: ReturnType<typeof createContentActorId>;
  idempotencyKey: string;
  occurrence: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof loadMediaAssetApplication>>["commands"]["replaceOccurrence"]
    >
  >;
  application: Awaited<ReturnType<typeof loadMediaAssetApplication>>;
  binding: Awaited<ReturnType<typeof loadContentBinding>>;
}) {
  const { workspaceId, contentApplication } = binding;
  let { contentBaseRevision } = binding;
  const asset = await application.queries.getAsset(occurrence.assetId);
  if (asset === null) throw new MediaSiteAccessError();
  const boundOccurrence = {
    occurrenceId: requireRenderedMediaOccurrenceId(occurrence.occurrenceId),
    revision: occurrence.revision,
    asset: {
      assetId: asset.assetId,
      width: asset.width,
      height: asset.height,
      contentType: asset.contentType,
    },
    crop: occurrence.crop,
  } as const;
  const currentBinding = (binding.current.definition.home.media ?? []).find(
    (candidate) =>
      candidate.occurrenceId === boundOccurrence.occurrenceId,
  );
  const mediaHead = await application.queries.getOccurrence(
    workspaceId,
    occurrence.occurrenceId,
  );
  if (!isSameWorkspaceOccurrence(mediaHead, occurrence)) {
    throw new ContentRevisionConflictError(binding.current.revision);
  }
  if (isSameContentOccurrence(currentBinding, boundOccurrence)) {
    return {
      occurrence,
      contentRevision: binding.current,
      previewUrl: revisionPreviewGatewayUrl(
        binding.current.workspaceId,
        binding.current.revision,
      ),
    };
  }
  let contentRevision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${idempotencyKey}:${contentBaseRevision}`),
    );
    const contentIdempotencyKey =
      `media-content-${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")}`;
    try {
      contentRevision =
        await contentApplication.commands.saveMediaOccurrence({
          actorId,
          workspaceId,
          schemaVersion: installedSiteDefinition.schemaVersion,
          baseRevision: contentBaseRevision,
          occurrence: boundOccurrence,
          idempotencyKey: contentIdempotencyKey,
        });
      break;
    } catch (error) {
      if (!(error instanceof ContentRevisionConflictError) || attempt === 2) {
        throw error;
      }
      const current = await contentApplication.queries.getCurrent();
      const currentBinding = (current.definition.home.media ?? []).find(
        (candidate) =>
          candidate.occurrenceId === boundOccurrence.occurrenceId,
      );
      if (isSameContentOccurrence(currentBinding, boundOccurrence)) {
        contentRevision = current;
        break;
      }
      const originalBinding = (binding.base.definition.home.media ?? []).find(
        (candidate) =>
          candidate.occurrenceId === boundOccurrence.occurrenceId,
      );
      if (!isSameOptionalContentOccurrence(currentBinding, originalBinding)) {
        throw error;
      }
      const mediaHead = await application.queries.getOccurrence(
        workspaceId,
        occurrence.occurrenceId,
      );
      if (!isSameWorkspaceOccurrence(mediaHead, occurrence)) throw error;
      contentBaseRevision = current.revision;
    }
  }
  if (contentRevision === undefined) {
    throw new ContentRevisionConflictError(contentBaseRevision);
  }
  return {
    occurrence,
    contentRevision,
    previewUrl: revisionPreviewGatewayUrl(
      contentRevision.workspaceId,
      contentRevision.revision,
    ),
  };
}

function nonnegativeSafeInteger(value: unknown, field: string) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new MediaValidationError(field);
  }
  return value;
}

function finiteNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MediaValidationError(field);
  }
  return value;
}

/**
 * The optional small copy the browser made before the upload. Its type and
 * size come from the bytes themselves, never from what the browser claimed,
 * so a wrong or hostile part is rejected instead of stored.
 */
async function readUploadedThumbnail(
  form: FormData,
): Promise<Readonly<{ thumbnail?: MediaThumbnailUpload }>> {
  const part = form.get("thumbnail");
  if (part === null) return {};
  if (!(part instanceof File) || part.size > mediaThumbnailMaxByteLength) {
    throw new MediaValidationError("thumbnail");
  }
  const bytes = new Uint8Array(await part.arrayBuffer());
  const metadata = await inspectImageSource(bytes);
  return {
    thumbnail: {
      contentType: metadata.contentType,
      byteLength: bytes.byteLength,
      width: metadata.width,
      height: metadata.height,
      source: bytes,
    },
  };
}

async function loadContentBinding(
  body: Record<string, unknown>,
  actorId: ReturnType<typeof createContentActorId>,
) {
  const workspaceId = createContentWorkspaceId(String(body.workspaceId ?? ""));
  const contentBaseRevision = nonnegativeSafeInteger(
    body.contentBaseRevision,
    "contentBaseRevision",
  );
  const contentApplication = await loadContentRevisionApplication(
    workspaceId,
    actorId,
  );
  const current = await contentApplication.queries.getCurrent();
  const base = await contentApplication.queries.getRevision(
    contentBaseRevision,
  );
  if (base === null) {
    throw new ContentRevisionConflictError(current.revision);
  }
  if (!(await contentApplication.queries.isRevisionCurrent(current))) {
    throw new ContentRevisionStaleError(current.revision);
  }
  return {
    workspaceId,
    contentBaseRevision,
    contentApplication,
    current,
    base,
  };
}

export async function POST(request: Request) {
  try {
    const { authenticated, actorId } = await authorized(request);
    await verifyHumanMutation(request, authenticated.identity);
    const application = await loadMediaAssetApplication(actorId);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const contentLength = Number(request.headers.get("content-length"));
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength <= 0 ||
        contentLength >
          20 * 1024 * 1024 + mediaThumbnailMaxByteLength + 64 * 1024
      ) {
        throw new MediaValidationError("source");
      }
      const form = await request.formData();
      const source = form.get("source");
      if (!(source instanceof File) || source.size > 20 * 1024 * 1024) {
        throw new MediaValidationError("source");
      }
      const sourceBytes = new Uint8Array(await source.arrayBuffer());
      const metadata = await inspectImageSource(sourceBytes);
      const asset = await application.commands.upload({
        actorId,
        assetId: createMediaAssetId(String(form.get("assetId") ?? "")),
        fileName: source.name,
        contentType: metadata.contentType,
        byteLength: source.size,
        width: metadata.width,
        height: metadata.height,
        source: sourceBytes,
        idempotencyKey,
        ...(await readUploadedThumbnail(form)),
      });
      return Response.json(asset, { status: 201 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (body.operation === "access") {
      const workspaceId = createContentWorkspaceId(
        String(body.workspaceId ?? ""),
      );
      // Every photo the draft references — placed occurrences and
      // page-component image fields — widens the access token so an
      // authenticated preview can fetch each one at full resolution (ADR-0012).
      // The Photos page is reachable before any draft exists, though, so a
      // workspace with no accessible revision is not an error: the gallery must
      // still load. The scope then falls back to the published site's own
      // references. Checking access first also avoids creating an empty draft
      // workspace as a side effect of reading one.
      let draftReferencedAssetIds: ReadonlyArray<string>;
      try {
        await requireExistingContentWorkspaceAccess(workspaceId, actorId);
        const currentContent = await (
          await loadContentRevisionApplication(workspaceId, actorId)
        ).queries.getCurrent();
        draftReferencedAssetIds = [
          ...siteDefinitionMediaAssetIds(currentContent.definition),
        ];
      } catch (error) {
        if (!(error instanceof ContentWorkspaceAccessError)) throw error;
        // No revision the caller can read. That is expected only for the
        // caller's own default workspace before a draft exists — the Photos
        // page is reachable then and its gallery must still load. Any other
        // inaccessible workspace is refused, so the grant never reads another
        // member's draft. The token scope then falls back to the published
        // site's own references.
        if (workspaceId !== (await contentWorkspaceIdForActor(actorId))) {
          throw error;
        }
        draftReferencedAssetIds = [
          ...siteDefinitionMediaAssetIds(installedSiteDefinition),
        ];
      }
      const { accessGrantedAt, ...catalog } =
        await application.commands.grantAccess({
          actorId,
          workspaceId,
          idempotencyKey,
        });
      const capability = await createHumanMediaAccessToken(
        authenticated.identity,
        [
          ...new Set([
            ...catalog.occurrences.map((occurrence) => occurrence.assetId),
            ...draftReferencedAssetIds,
          ]),
        ],
        accessGrantedAt,
      );
      const libraryCapability = await createHumanMediaLibraryToken(
        authenticated.identity,
        accessGrantedAt,
      );
      return Response.json({
        ...catalog,
        accessToken: capability.token,
        accessTokenExpiresAt: capability.expiresAt,
        libraryToken: libraryCapability.token,
        libraryTokenExpiresAt: libraryCapability.expiresAt,
      });
    }
    if (body.operation === "replace") {
      const baseRevision = nonnegativeSafeInteger(
        body.baseRevision,
        "baseRevision",
      );
      const binding = await loadContentBinding(body, actorId);
      const occurrenceId = createMediaOccurrenceId(
        String(body.occurrenceId ?? ""),
      );
      const workspaceOccurrence = await application.queries.getOccurrence(
        binding.workspaceId,
        occurrenceId,
      );
      assertContentOccurrenceMutationSafe(
        binding,
        occurrenceId,
        baseRevision,
        workspaceOccurrence,
      );
      const replaceCommand = {
        actorId,
        occurrenceId,
        assetId: createMediaAssetId(String(body.assetId ?? "")),
        baseRevision,
        workspaceId: binding.workspaceId,
        idempotencyKey,
      } as const;
      const requireReplay = body.requireReplay === true;
      const occurrence = requireReplay
        ? await application.queries.getReplacementReceipt(
            replaceCommand,
          )
        : await application.commands.replaceOccurrence(replaceCommand);
      if (occurrence === null) {
        throw new ContentRevisionConflictError(binding.current.revision);
      }
      const result = await bindOccurrenceToContentRevision({
        actorId,
        idempotencyKey,
        occurrence,
        application,
        binding,
      });
      return Response.json(
        requireReplay ? { ...result, mutationReplay: true } : result,
        { status: 201 },
      );
    }
    if (body.operation === "crop") {
      const baseRevision = nonnegativeSafeInteger(
        body.baseRevision,
        "baseRevision",
      );
      const binding = await loadContentBinding(body, actorId);
      const crop = body.crop as Record<string, unknown> | undefined;
      const occurrenceId = createMediaOccurrenceId(
        String(body.occurrenceId ?? ""),
      );
      const workspaceOccurrence = await application.queries.getOccurrence(
        binding.workspaceId,
        occurrenceId,
      );
      assertContentOccurrenceMutationSafe(
        binding,
        occurrenceId,
        baseRevision,
        workspaceOccurrence,
      );
      const inheritedOccurrence = (
        binding.current.definition.home.media ?? []
      ).find((candidate) => candidate.occurrenceId === occurrenceId);
      const occurrence = await application.commands.cropOccurrence({
        actorId,
        occurrenceId,
        assetId:
          workspaceOccurrence?.assetId ??
          createMediaAssetId(inheritedOccurrence?.asset.assetId ?? ""),
        baseRevision,
        workspaceId: binding.workspaceId,
        crop: {
          x: finiteNumber(crop?.x, "crop.x"),
          y: finiteNumber(crop?.y, "crop.y"),
          width: finiteNumber(crop?.width, "crop.width"),
          height: finiteNumber(crop?.height, "crop.height"),
        },
        idempotencyKey,
      });
      return Response.json(
        await bindOccurrenceToContentRevision({
          actorId,
          idempotencyKey,
          occurrence,
          application,
          binding,
        }),
        { status: 201 },
      );
    }
    if (body.operation === "delete") {
      await application.commands.delete({
        actorId,
        assetId: createMediaAssetId(String(body.assetId ?? "")),
        idempotencyKey,
      });
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "invalid_command" }, { status: 400 });
  } catch (error) {
    return mediaError(error);
  }
}

function mediaError(error: unknown) {
  if (error instanceof MediaMutationInProgressError) {
    return Response.json(
      { error: "media_mutation_in_progress" },
      { status: 409, headers: { "retry-after": "30" } },
    );
  }
  if (error instanceof MediaAssetReferencedError) {
    return Response.json(
      { error: "media_asset_referenced", references: error.referenceCount },
      { status: 409 },
    );
  }
  if (error instanceof MediaOccurrenceConflictError) {
    return Response.json(
      { error: "media_revision_conflict", currentRevision: error.currentRevision },
      { status: 409 },
    );
  }
  if (error instanceof MediaValidationError || error instanceof TypeError) {
    return Response.json({ error: "validation_failed" }, { status: 422 });
  }
  if (
    error instanceof AccessIdentityError ||
    error instanceof AccessDeniedError ||
    error instanceof ContentWorkspaceAccessError ||
    error instanceof HumanRequestIntegrityError ||
    error instanceof MediaSiteAccessError
  ) {
    return Response.json({ error: "request_check_failed" }, { status: 403 });
  }
  if (
    error instanceof AccessIdentityUnavailableError ||
    error instanceof HumanAccessConfigurationError ||
    error instanceof ContentRevisionConfigurationError ||
    error instanceof MediaAssetConfigurationError
  ) {
    return Response.json(
      { error: "request_check_unavailable" },
      { status: 503 },
    );
  }
  if (error instanceof ContentRevisionConflictError) {
    return Response.json(
      {
        error: "content_revision_conflict",
        currentRevision: error.currentRevision,
      },
      { status: 409 },
    );
  }
  if (error instanceof ContentRevisionStaleError) {
    return Response.json(
      { error: "content_revision_stale" },
      { status: 409 },
    );
  }
  if (error instanceof ContentRevisionValidationError) {
    return Response.json(
      { error: "validation_failed", fields: error.fields },
      { status: 422 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "invalid_command" }, { status: 400 });
  }
  throw error;
}

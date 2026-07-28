import {
  AccessDeniedError,
  MediaAssetReferencedError,
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
  requireRenderedMediaOccurrenceId,
} from "@foundry/application";

import { AccessIdentityError } from "../../../../src/access-identity";
import {
  authorizeAuthenticatedHumanIdentity,
  loadHumanIdentityRequestContext,
} from "../../../../src/human-access-runtime";
import {
  HumanAccessConfigurationError,
} from "../../../../src/human-access-configuration";
import { verifyHumanMutation } from "../../../../src/human-mutation-runtime";
import { HumanRequestIntegrityError } from "../../../../src/human-request-integrity";
import {
  MediaAssetConfigurationError,
  loadMediaAssetApplication,
} from "../../../../src/media-asset-runtime";
import { loadContentRevisionApplication } from "../../../../src/content-revision-runtime";
import { revisionPreviewGatewayUrl } from "../../../../src/content-revision-links";

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

export async function GET(request: Request) {
  try {
    const { actorId } = await authorized(request);
    const application = await loadMediaAssetApplication(actorId);
    const requestedAsset = new URL(request.url).searchParams.get("assetId");
    if (requestedAsset !== null) {
      const source = await application.queries.getSource(
        createMediaAssetId(requestedAsset),
      );
      if (source === null) {
        return Response.json({ error: "media_not_found" }, { status: 404 });
      }
      return new Response(source.body.slice().buffer as ArrayBuffer, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": source.contentType,
          "x-content-type-options": "nosniff",
        },
      });
    }
    const [assets, occurrences] = await Promise.all([
      application.queries.listAssets(),
      application.queries.listOccurrences(),
    ]);
    return Response.json(
      { assets, occurrences },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return mediaError(error);
  }
}

function numberField(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? Number(value) : Number.NaN;
}

async function bindOccurrenceToContentRevision({
  body,
  actorId,
  idempotencyKey,
  occurrence,
  application,
}: {
  body: Record<string, unknown>;
  actorId: ReturnType<typeof createContentActorId>;
  idempotencyKey: string;
  occurrence: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof loadMediaAssetApplication>>["commands"]["replaceOccurrence"]
    >
  >;
  application: Awaited<ReturnType<typeof loadMediaAssetApplication>>;
}) {
  const workspaceId = createContentWorkspaceId(String(body.workspaceId ?? ""));
  let contentBaseRevision = Number(body.contentBaseRevision);
  if (!Number.isSafeInteger(contentBaseRevision) || contentBaseRevision < 0) {
    throw new MediaValidationError("contentBaseRevision");
  }
  const asset = await application.queries.getAsset(occurrence.assetId);
  if (asset === null) throw new MediaSiteAccessError();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(idempotencyKey),
  );
  const contentIdempotencyKey = `media-content-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  const contentApplication = await loadContentRevisionApplication(
    workspaceId,
    actorId,
  );
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
  let contentRevision;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      contentRevision =
        await contentApplication.commands.saveMediaOccurrence({
          actorId,
          workspaceId,
          schemaVersion: "1.0.0",
          baseRevision: contentBaseRevision,
          occurrence: boundOccurrence,
          idempotencyKey: contentIdempotencyKey,
        });
      break;
    } catch (error) {
      if (!(error instanceof ContentRevisionConflictError) || attempt === 2) {
        throw error;
      }
      contentBaseRevision = (
        await contentApplication.queries.getCurrent()
      ).revision;
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

export async function POST(request: Request) {
  try {
    const { authenticated, actorId } = await authorized(request);
    await verifyHumanMutation(request, authenticated.identity);
    const application = await loadMediaAssetApplication(actorId);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const source = form.get("source");
      if (!(source instanceof File) || source.size > 20 * 1024 * 1024) {
        throw new MediaValidationError("source");
      }
      const asset = await application.commands.upload({
        actorId,
        assetId: createMediaAssetId(String(form.get("assetId") ?? "")),
        fileName: source.name,
        contentType: source.type,
        byteLength: source.size,
        width: numberField(form, "width"),
        height: numberField(form, "height"),
        source: new Uint8Array(await source.arrayBuffer()),
        idempotencyKey,
      });
      return Response.json(asset, { status: 201 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (body.operation === "replace") {
      const occurrence = await application.commands.replaceOccurrence({
        actorId,
        occurrenceId: createMediaOccurrenceId(String(body.occurrenceId ?? "")),
        assetId: createMediaAssetId(String(body.assetId ?? "")),
        baseRevision: Number(body.baseRevision),
        idempotencyKey,
      });
      return Response.json(
        await bindOccurrenceToContentRevision({
          body,
          actorId,
          idempotencyKey,
          occurrence,
          application,
        }),
        { status: 201 },
      );
    }
    if (body.operation === "crop") {
      const crop = body.crop as Record<string, unknown> | undefined;
      const occurrence = await application.commands.cropOccurrence({
        actorId,
        occurrenceId: createMediaOccurrenceId(String(body.occurrenceId ?? "")),
        baseRevision: Number(body.baseRevision),
        crop: {
          x: Number(crop?.x),
          y: Number(crop?.y),
          width: Number(crop?.width),
          height: Number(crop?.height),
        },
        idempotencyKey,
      });
      return Response.json(
        await bindOccurrenceToContentRevision({
          body,
          actorId,
          idempotencyKey,
          occurrence,
          application,
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

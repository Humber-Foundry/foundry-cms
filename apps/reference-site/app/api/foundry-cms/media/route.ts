import {
  AccessDeniedError,
  MediaAssetReferencedError,
  MediaOccurrenceConflictError,
  MediaSiteAccessError,
  MediaValidationError,
  createContentActorId,
  createMediaAssetId,
  createMediaOccurrenceId,
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
      return Response.json(occurrence, { status: 201 });
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
      return Response.json(occurrence, { status: 201 });
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
    error instanceof HumanRequestIntegrityError ||
    error instanceof MediaSiteAccessError
  ) {
    return Response.json({ error: "request_check_failed" }, { status: 403 });
  }
  if (
    error instanceof HumanAccessConfigurationError ||
    error instanceof MediaAssetConfigurationError
  ) {
    return Response.json(
      { error: "request_check_unavailable" },
      { status: 503 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "invalid_command" }, { status: 400 });
  }
  throw error;
}

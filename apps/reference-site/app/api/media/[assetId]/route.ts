import {
  MediaSiteAccessError,
  createContentActorId,
  createMediaAssetId,
} from "@foundry/application";

import {
  MediaAssetConfigurationError,
  loadMediaAssetApplication,
} from "../../../../src/media-asset-runtime";
import { referenceSiteApplication } from "../../../../src/reference-installation";

const publicRendererActorId = createContentActorId(
  "integration-public-renderer",
);

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  try {
    const assetId = createMediaAssetId((await context.params).assetId);
    const published = await referenceSiteApplication.queries.getPublishedSite();
    const isPublished = (published.home.media ?? []).some(
      (occurrence) => occurrence.asset.assetId === assetId,
    );
    if (!isPublished) return new Response(null, { status: 404 });
    const application = await loadMediaAssetApplication(publicRendererActorId);
    const source = await application.queries.getSource(assetId);
    if (source === null) return new Response(null, { status: 404 });
    return new Response(
      source.body instanceof Uint8Array
        ? (source.body.slice().buffer as ArrayBuffer)
        : source.body,
      {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": source.contentType,
          "x-content-type-options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof MediaSiteAccessError) {
      return new Response(null, { status: 404 });
    }
    if (error instanceof MediaAssetConfigurationError) {
      return new Response(null, { status: 503 });
    }
    throw error;
  }
}

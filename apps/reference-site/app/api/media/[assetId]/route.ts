import {
  MediaSiteAccessError,
  createContentActorId,
  createMediaAssetId,
} from "@humber-foundry/application";
import { siteDefinitionMediaAssetIds } from "@humber-foundry/site-definition";

import {
  MediaAssetConfigurationError,
  loadMediaAssetApplication,
} from "../../../../src/media-asset-runtime";
import { installedSite } from "@/foundry/site-definition.server";

const publicRendererActorId = createContentActorId(
  "integration-public-renderer",
);

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  try {
    const assetId = createMediaAssetId((await context.params).assetId);
    const published = await installedSite.application.queries.getPublishedSite();
    // A photo the published site references is public — whether it is placed
    // as a media occurrence or chosen for a page-component image field.
    const isPublished = siteDefinitionMediaAssetIds(published).has(assetId);
    if (!isPublished) return new Response(null, { status: 404 });
    const application = await loadMediaAssetApplication(publicRendererActorId);
    const source = await application.queries.getPublishedSource(assetId);
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

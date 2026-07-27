import { createMediaAssetId } from "@foundry/application";

import {
  MediaAssetConfigurationError,
  loadPublicMediaAssetApplication,
} from "../../../../src/media-asset-runtime";

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  try {
    const { assetId } = await context.params;
    const application = await loadPublicMediaAssetApplication();
    const source = await application.queries.getSource(
      createMediaAssetId(assetId),
    );
    if (source === null) {
      return new Response(null, { status: 404 });
    }
    return new Response(source.body.slice().buffer as ArrayBuffer, {
      headers: {
        "cache-control": "public, max-age=3600",
        "content-type": source.contentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof TypeError) {
      return new Response(null, { status: 404 });
    }
    if (error instanceof MediaAssetConfigurationError) {
      return new Response(null, { status: 503 });
    }
    throw error;
  }
}

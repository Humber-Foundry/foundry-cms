import {
  hashPublishedSiteDefinition,
} from "@humber-foundry/application";

import { installedSiteDefinition } from "@/foundry/site-definition";

export const dynamic = "force-static";

export async function GET() {
  const commitSha = process.env.FOUNDRY_RELEASE_COMMIT_SHA;
  if (
    commitSha === undefined ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)
  ) {
    return Response.json(
      { error: "release_marker_unavailable" },
      {
        status: 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  return Response.json(
    {
      commitSha,
      contentHash: await hashPublishedSiteDefinition(
        installedSiteDefinition,
      ),
      schemaVersion: installedSiteDefinition.schemaVersion,
    },
    {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
      },
    },
  );
}

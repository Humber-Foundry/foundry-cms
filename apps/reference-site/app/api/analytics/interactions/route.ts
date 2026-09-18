import { getCloudflareContext } from "@opennextjs/cloudflare";

import { installedSiteDefinition } from "@/foundry/site-definition";
import {
  collectInteraction,
  writeInteractionPoint,
  type AnalyticsEngineDataset,
} from "../../../../src/analytics-interaction-collector";

/**
 * Anonymous, best-effort interaction collection.
 *
 * Nothing about the request is retained: no header, no query string, no IP, no
 * identifier. A failure here never changes the outcome of a form, publish,
 * consent or send operation, so the endpoint always answers 204.
 */

export const dynamic = "force-dynamic";

const maximumBodySize = 512;

/**
 * Public CMS object IDs a browser may report an interaction against. Every
 * page contributes its own id and its own sections' ids, not only the home
 * page, so a form or call-to-action on any page can be counted. See
 * ADR-0026.
 */
function publicSubjectIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const page of installedSiteDefinition.pages) {
    ids.add(page.id);
    for (const section of page.sections) ids.add(section.id);
  }
  for (const post of installedSiteDefinition.blog.posts) ids.add(post.id);
  return ids;
}

function noContent() {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  if (body.length > maximumBodySize) return noContent();

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return noContent();
  }

  const result = collectInteraction({
    payload,
    publicSubjectIds: publicSubjectIds(),
  });
  if (result.outcome === "rejected") return noContent();

  try {
    const { env } = await getCloudflareContext({ async: true });
    const dataset = (env as Record<string, unknown>)
      .FOUNDRY_INTERACTIONS as AnalyticsEngineDataset | undefined;
    if (dataset !== undefined) {
      writeInteractionPoint(dataset, result.point);
    }
  } catch {
    // Best effort by design: a dropped interaction can leave an estimated
    // count incomplete.
  }
  return noContent();
}

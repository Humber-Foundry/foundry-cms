import { installedSiteDefinition } from "../foundry/site-definition";

/**
 * Public CMS object IDs a browser may report an interaction against.
 *
 * Every page contributes its own id and its own sections' ids, not only the
 * home page, so a form or call-to-action on any page can be counted. The
 * anonymous interactions endpoint (`app/api/analytics/interactions/route.ts`)
 * validates a caller's claimed subject id against this set before it accepts
 * an interaction, so a caller cannot invent a fact for an id the site never
 * published. See ADR-0026.
 */
export function publicSubjectIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const page of installedSiteDefinition.pages) {
    ids.add(page.id);
    for (const section of page.sections) ids.add(section.id);
  }
  for (const post of installedSiteDefinition.blog.posts) ids.add(post.id);
  return ids;
}

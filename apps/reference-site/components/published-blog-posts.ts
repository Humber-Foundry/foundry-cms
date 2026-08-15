import type { SiteDefinition } from "@humber-foundry/site-definition";

/**
 * The posts the published site actually shows. Blog controls use this to tell
 * a draft apart from a post a visitor can already read.
 *
 * This moved out of the combined dashboard shell when `/dash` became a set of
 * separate destinations.
 */
export function verifiedPublicBlogPostIds(definition: SiteDefinition) {
  return definition.blog.posts
    .filter(({ targetVisibility }) => targetVisibility === "public")
    .map(({ id }) => id);
}

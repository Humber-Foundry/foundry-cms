import type { Metadata } from "next";

import {
  resolveBlogPostSeo,
  type BlogPost,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { publicMetadata } from "./public-metadata";

export function findPublicBlogPost(
  definition: SiteDefinition,
  slug: string,
): BlogPost | null {
  const post = findBlogPost(definition, slug);
  return post?.targetVisibility === "public" ? post : null;
}

export function findBlogPost(
  definition: SiteDefinition,
  slug: string,
): BlogPost | null {
  return definition.blog.posts.find((post) => post.slug === slug) ?? null;
}

export function blogPostMetadata(
  definition: SiteDefinition,
  post: BlogPost,
): Metadata {
  return publicMetadata(resolveBlogPostSeo(definition, post), {
    siteName: definition.site.name,
    kind: "article",
  });
}

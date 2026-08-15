import type { Metadata } from "next";

import type {
  BlogPost,
  SiteDefinition,
} from "@humber-foundry/site-definition";

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

export function blogPostMetadata(post: BlogPost): Metadata {
  return {
    title: post.seo.title,
    description: post.seo.description,
  };
}

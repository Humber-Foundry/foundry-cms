import type { Metadata } from "next";

import type {
  BlogPost,
  SiteDefinition,
} from "@foundry/site-definition";

export function findPublicBlogPost(
  definition: SiteDefinition,
  slug: string,
): BlogPost | null {
  return (
    definition.blog.posts.find(
      (post) => post.slug === slug && post.targetVisibility === "public",
    ) ?? null
  );
}

export function blogPostMetadata(post: BlogPost): Metadata {
  return {
    title: post.seo.title,
    description: post.seo.description,
  };
}

import { siteDesignAttributes } from "./design-tokens";
import type { BlogPost, SiteDefinition } from "./index";

export type BlogPostRenderModel =
  | Readonly<{
      route: `/blog/${string}`;
      absent: true;
    }>
  | Readonly<{
      route: `/blog/${string}`;
      metadata: BlogPost["seo"];
      mainImage: BlogPost["mainImage"];
      designAttributes: ReturnType<typeof siteDesignAttributes>;
      wordmark: Readonly<{
        label: string;
        mark: "F";
        name: string;
      }>;
      navigation: ReadonlyArray<
        Readonly<{ href: "/"; label: "Home" }>
      >;
      eyebrow: "Journal";
      title: string;
      excerpt: string;
      body: BlogPost["body"];
      footer: string;
      definitionVersion: SiteDefinition["definitionVersion"];
    }>;

export function createBlogPostRenderModel(
  definition: SiteDefinition,
  post: BlogPost,
): BlogPostRenderModel {
  const route = `/blog/${post.slug}` as const;
  if (post.targetVisibility === "unpublished") {
    return { route, absent: true };
  }
  return {
    route,
    metadata: post.seo,
    mainImage: post.mainImage,
    designAttributes: siteDesignAttributes(definition.design),
    wordmark: {
      label: `${definition.site.name} home`,
      mark: "F",
      name: definition.site.name,
    },
    navigation: [{ href: "/", label: "Home" }],
    eyebrow: "Journal",
    title: post.title,
    excerpt: post.excerpt,
    body: post.body,
    footer: definition.site.footer,
    definitionVersion: definition.definitionVersion,
  };
}

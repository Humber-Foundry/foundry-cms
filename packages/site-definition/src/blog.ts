import {
  isSiteDefinition,
  type BlogPost,
  type BlogPostId,
  type SiteDefinition,
  type SiteId,
} from "./index";

export class BlogPostSchemaError extends Error {
  constructor(
    readonly code:
      | "cross_site_identifier"
      | "post_already_exists"
      | "post_already_live"
      | "post_not_found"
      | "post_not_live"
      | "post_not_unpublished"
      | "slug_already_exists"
      | "schema_invalid",
  ) {
    super(code);
    this.name = "BlogPostSchemaError";
  }
}

function requireSite(definition: SiteDefinition, siteId: SiteId) {
  if (definition.site.id !== siteId) {
    throw new BlogPostSchemaError("cross_site_identifier");
  }
}

function requireValid(
  definition: SiteDefinition,
  isDefinition: (value: unknown) => value is SiteDefinition,
): SiteDefinition {
  if (!isDefinition(definition)) {
    throw new BlogPostSchemaError("schema_invalid");
  }
  return definition;
}

export function createBlogPostDefinition(
  definition: SiteDefinition,
  siteId: SiteId,
  post: Omit<
    BlogPost,
    "revision" | "collectionState" | "targetVisibility"
  >,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
): SiteDefinition {
  requireSite(definition, siteId);
  if (definition.blog.posts.some(({ id }) => id === post.id)) {
    throw new BlogPostSchemaError("post_already_exists");
  }
  if (definition.blog.posts.some(({ slug }) => slug === post.slug)) {
    throw new BlogPostSchemaError("slug_already_exists");
  }
  return requireValid({
    ...definition,
    blog: {
      ...definition.blog,
      posts: [
        ...definition.blog.posts,
        {
          ...post,
          revision: 1,
          collectionState: "active",
          targetVisibility: "public",
        },
      ],
    },
  }, isDefinition);
}

export function editBlogPostDefinition(
  definition: SiteDefinition,
  siteId: SiteId,
  postId: BlogPostId,
  replacement: Omit<
    BlogPost,
    "id" | "revision" | "collectionState" | "targetVisibility"
  >,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
): SiteDefinition {
  requireSite(definition, siteId);
  const index = definition.blog.posts.findIndex(({ id }) => id === postId);
  if (index < 0) {
    throw new BlogPostSchemaError("post_not_found");
  }
  if (
    definition.blog.posts.some(
      ({ id, slug }) => id !== postId && slug === replacement.slug,
    )
  ) {
    throw new BlogPostSchemaError("slug_already_exists");
  }
  const current = definition.blog.posts[index]!;
  const posts = [...definition.blog.posts];
  posts[index] = {
    id: current.id,
    revision: current.revision + 1,
    collectionState: current.collectionState,
    targetVisibility: current.targetVisibility,
    slug: replacement.slug,
    title: replacement.title,
    excerpt: replacement.excerpt,
    seo: replacement.seo,
    body: replacement.body,
  };
  return requireValid({
    ...definition,
    blog: { ...definition.blog, posts },
  }, isDefinition);
}

export function unpublishBlogPostDefinition(
  definition: SiteDefinition,
  siteId: SiteId,
  postId: BlogPostId,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
): SiteDefinition {
  requireSite(definition, siteId);
  if (!definition.blog.posts.some(({ id }) => id === postId)) {
    throw new BlogPostSchemaError("post_not_found");
  }
  const current = definition.blog.posts.find(({ id }) => id === postId)!;
  if (current.targetVisibility === "unpublished") {
    throw new BlogPostSchemaError("post_not_live");
  }
  return requireValid({
    ...definition,
    blog: {
      ...definition.blog,
      posts: definition.blog.posts.map((post) =>
        post.id === postId
          ? {
              ...post,
              revision: post.revision + 1,
              targetVisibility: "unpublished" as const,
            }
          : post,
      ),
    },
  }, isDefinition);
}

export function republishBlogPostDefinition(
  definition: SiteDefinition,
  siteId: SiteId,
  postId: BlogPostId,
  isDefinition: (value: unknown) => value is SiteDefinition = isSiteDefinition,
): SiteDefinition {
  requireSite(definition, siteId);
  const current = definition.blog.posts.find(({ id }) => id === postId);
  if (current === undefined) {
    throw new BlogPostSchemaError("post_not_found");
  }
  if (current.targetVisibility === "public") {
    throw new BlogPostSchemaError("post_already_live");
  }
  return requireValid({
    ...definition,
    blog: {
      ...definition.blog,
      posts: definition.blog.posts.map((post) =>
        post.id === postId
          ? {
              ...post,
              revision: post.revision + 1,
              targetVisibility: "public" as const,
            }
          : post,
      ),
    },
  }, isDefinition);
}

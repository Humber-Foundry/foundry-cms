import {
  createBlogPostRenderModel,
  resolveMediaImageSrc,
  type BlogPost,
  type MediaImageDelivery,
  type PageHrefBuilder,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { RichTextRenderer } from "./rich-text-renderer";
import { BlogFooter, SiteHeader } from "@/foundry/site-shell";

export function BlogPostRenderer({
  definition,
  post,
  preview = false,
  homeHref = "/",
  blogHref = "/blog",
  pageHref,
  mediaDelivery = "published",
  mediaAccessToken,
}: {
  definition: SiteDefinition;
  post: BlogPost;
  preview?: boolean;
  homeHref?: string;
  blogHref?: string;
  /**
   * Builds one page's address, for a navigation link that targets a page
   * other than the home page. Defaults to `pagePath` (the live public path),
   * the same default `SiteHeader` uses. The blog post preview route passes
   * its own preview-scoped builder here, the same way the home and page
   * preview routes already pass it to `SiteRenderer`. See ADR-0029.
   */
  pageHref?: PageHrefBuilder;
  mediaDelivery?: MediaImageDelivery;
  mediaAccessToken?: string;
}) {
  const model = createBlogPostRenderModel(
    definition,
    preview && post.targetVisibility === "unpublished"
      ? { ...post, targetVisibility: "public" }
      : post,
  );
  if ("absent" in model) {
    return null;
  }
  const mainImage = model.mainImage;
  return (
    <div className="site-canvas" {...model.designAttributes}>
      <SiteHeader
        definition={definition}
        homeHref={homeHref}
        blogHref={blogHref}
        pageHref={pageHref}
      />
      <main id="main-content" className="blog-post" tabIndex={-1}>
        <article>
          {mainImage === null ? null : (
            <figure className="blog-post-main-image">
              <img
                src={resolveMediaImageSrc(
                  mainImage.url,
                  mediaDelivery,
                  mediaAccessToken,
                )}
                alt={mainImage.alt}
              />
            </figure>
          )}
          <header>
            <p className="eyebrow">{model.eyebrow}</p>
            <h1>{model.title}</h1>
            <p className="blog-post-excerpt">{model.excerpt}</p>
          </header>
          <div className="rich-text">
            <RichTextRenderer
              document={model.body}
              mediaDelivery={mediaDelivery}
              mediaAccessToken={mediaAccessToken}
            />
          </div>
        </article>
      </main>
      <BlogFooter definition={definition} homeHref={homeHref} />
    </div>
  );
}

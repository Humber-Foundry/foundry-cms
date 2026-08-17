import {
  createBlogPostRenderModel,
  resolveMediaImageSrc,
  type BlogPost,
  type MediaImageDelivery,
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
  mediaDelivery = "published",
  mediaAccessToken,
}: {
  definition: SiteDefinition;
  post: BlogPost;
  preview?: boolean;
  homeHref?: string;
  blogHref?: string;
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

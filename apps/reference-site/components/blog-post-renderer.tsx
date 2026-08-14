import {
  createBlogPostRenderModel,
  type BlogPost,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { RichTextRenderer } from "./rich-text-renderer";
import { BlogFooter, SiteHeader } from "@/foundry/site-shell";

export function BlogPostRenderer({
  definition,
  post,
  preview = false,
}: {
  definition: SiteDefinition;
  post: BlogPost;
  preview?: boolean;
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
  return (
    <div className="site-canvas" {...model.designAttributes}>
      <SiteHeader definition={definition} />
      <main id="main-content" className="blog-post" tabIndex={-1}>
        <article>
          <header>
            <p className="eyebrow">{model.eyebrow}</p>
            <h1>{model.title}</h1>
            <p className="blog-post-excerpt">{model.excerpt}</p>
          </header>
          <div className="rich-text">
            <RichTextRenderer document={model.body} />
          </div>
        </article>
      </main>
      <BlogFooter definition={definition} />
    </div>
  );
}

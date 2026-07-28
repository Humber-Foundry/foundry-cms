import {
  siteDesignAttributes,
  type BlogPost,
  type SiteDefinition,
} from "@foundry/site-definition";

import { RichTextRenderer } from "./rich-text-renderer";

export function BlogPostRenderer({
  definition,
  post,
}: {
  definition: SiteDefinition;
  post: BlogPost;
}) {
  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label={`${definition.site.name} home`}>
          <span aria-hidden="true">F</span>
          {definition.site.name}
        </a>
        <nav aria-label="Primary navigation">
          <a href="/">Home</a>
        </nav>
      </header>
      <main className="blog-post">
        <article>
          <header>
            <p className="eyebrow">Journal</p>
            <h1>{post.title}</h1>
            <p className="blog-post-excerpt">{post.excerpt}</p>
          </header>
          <div className="rich-text">
            <RichTextRenderer document={post.body} />
          </div>
        </article>
      </main>
      <footer className="site-footer">
        <p>{definition.site.footer}</p>
        <p>Site Definition v{definition.definitionVersion}</p>
      </footer>
    </div>
  );
}

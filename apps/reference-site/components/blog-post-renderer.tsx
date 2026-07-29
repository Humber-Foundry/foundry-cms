import {
  createBlogPostRenderModel,
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
  const model = createBlogPostRenderModel(definition, post);
  if ("absent" in model) {
    return null;
  }
  return (
    <div className="site-canvas" {...model.designAttributes}>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label={model.wordmark.label}>
          <span aria-hidden="true">{model.wordmark.mark}</span>
          {model.wordmark.name}
        </a>
        <nav aria-label="Primary navigation">
          {model.navigation.map((item) => (
            <a key={item.href} href={item.href}>{item.label}</a>
          ))}
        </nav>
      </header>
      <main className="blog-post">
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
      <footer className="site-footer">
        <p>{model.footer}</p>
        <p>Site Definition v{model.definitionVersion}</p>
      </footer>
    </div>
  );
}

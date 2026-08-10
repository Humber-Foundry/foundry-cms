import type { SiteDefinition } from "@humber-foundry/site-definition";
import { siteDesignAttributes } from "@humber-foundry/site-definition";
import {
  installedPageComponentRegistry,
} from "@/foundry/page-components";
import type { PageComponentRenderContext } from "@/foundry/page-component-renderers";

export function SiteSection(context: PageComponentRenderContext) {
  const validation = installedPageComponentRegistry.validate(context.section);
  const registration = installedPageComponentRegistry.components[
    installedPageComponentRegistry.keyFor(context.section)
  ];
  if (!validation.ok || registration === undefined) {
    throw new TypeError(
      validation.ok
        ? "page_component_renderer_unregistered"
        : `page_component_renderer_unregistered:${JSON.stringify(validation.errors)}`,
    );
  }
  return registration.renderer(context);
}

export function SiteRenderer({
  definition,
  mediaDelivery = "published",
  mediaAccessToken,
  blogPostHref = (slug) => `/blog/${slug}`,
}: {
  definition: SiteDefinition;
  mediaDelivery?: "authenticated" | "published";
  mediaAccessToken?: string;
  blogPostHref?: (slug: string) => string;
}) {
  const publicPosts = definition.blog.posts.filter(
    ({ targetVisibility }) => targetVisibility === "public",
  );
  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label={`${definition.site.name} home`}>
          <span aria-hidden="true">F</span>
          {definition.site.name}
        </a>
        <nav aria-label="Primary navigation">
          {definition.site.navigation.map((item) => (
            <a key={item.id} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        {definition.home.sections.map((section) => (
          <SiteSection
            key={section.id}
            section={section}
            definition={definition}
            mediaDelivery={mediaDelivery}
            mediaAccessToken={mediaAccessToken}
          />
        ))}
        {publicPosts.length === 0 ? null : (
          <section className="blog-index" aria-labelledby="blog_index_title">
            <p className="eyebrow">Journal</p>
            <h2 id="blog_index_title">Latest posts</h2>
            <ul>
              {publicPosts.map((post) => (
                <li key={post.id}>
                  <a href={blogPostHref(post.slug)}>{post.title}</a>
                  <p>{post.excerpt}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <footer className="site-footer">
        <p>{definition.site.footer}</p>
        <p>Site Definition v{definition.definitionVersion}</p>
      </footer>
    </div>
  );
}

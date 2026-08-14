import type { SiteDefinition } from "@humber-foundry/site-definition";
import { siteDesignAttributes } from "@humber-foundry/site-definition";
import {
  installedPageComponentRegistry,
} from "@/foundry/page-components";
import type { PageComponentRenderContext } from "@/foundry/page-component-renderers";
import { SiteHeader } from "@/foundry/site-shell";

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
  editingSurface = false,
}: {
  definition: SiteDefinition;
  mediaDelivery?: "authenticated" | "published";
  mediaAccessToken?: string;
  blogPostHref?: (slug: string) => string;
  /** Set inside the editor: embeds sandbox and the main landmark defers. */
  editingSurface?: boolean;
}) {
  // Inside the editor the host page owns the main landmark; the site's
  // wrapper becomes a plain region so landmarks do not nest.
  const Landmark = editingSurface ? "div" : "main";
  const publicPosts = definition.blog.posts.filter(
    ({ targetVisibility }) => targetVisibility === "public",
  );
  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <SiteHeader definition={definition} />
      <Landmark id="main-content" tabIndex={-1}>
        {definition.home.sections.map((section) => (
          <SiteSection
            key={section.id}
            section={section}
            definition={definition}
            mediaDelivery={mediaDelivery}
            mediaAccessToken={mediaAccessToken}
            editingSurface={editingSurface}
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
      </Landmark>
    </div>
  );
}

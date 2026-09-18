import {
  defaultPageHref,
  homePageSlug,
  type PageHrefBuilder,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";
import { siteDesignAttributes } from "@humber-foundry/site-definition";
import {
  installedPageComponentRegistry,
} from "@/foundry/page-components";
import type { PageComponentRenderContext } from "@/foundry/page-component-renderers";
import { SiteHeader } from "@/foundry/site-shell";
import {
  PublicBlogPostList,
  publicBlogPosts,
} from "./blog-index";

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
  page,
  mediaDelivery = "published",
  mediaAccessToken,
  blogPostHref = (slug) => `/blog/${slug}`,
  homeHref = "/",
  blogHref = "/blog",
  pageHref,
  editingSurface = false,
}: {
  definition: SiteDefinition;
  /** The page this route serves. The home page keeps its old output. */
  page: SitePage;
  mediaDelivery?: "authenticated" | "published";
  mediaAccessToken?: string;
  blogPostHref?: (slug: string) => string;
  homeHref?: string;
  blogHref?: string;
  /**
   * Builds the public path of any page other than the home page, for a link
   * that targets one. Defaults to `pagePath`. A revision preview (#156)
   * passes its own builder here, so a page-scoped link resolves inside the
   * preview the same way `homeHref` already lets a home-page link do.
   */
  pageHref?: PageHrefBuilder;
  /** Set inside the editor: embeds sandbox and the main landmark defers. */
  editingSurface?: boolean;
}) {
  // Inside the editor the host page owns the main landmark; the site's
  // wrapper becomes a plain region so landmarks do not nest.
  const Landmark = editingSurface ? "div" : "main";
  // The "Latest posts" list is home-page furniture, written when a site held
  // one page. It stays there and does not repeat on every other page.
  const isHomePage = page.slug === homePageSlug;
  const posts = isHomePage ? publicBlogPosts(definition) : [];
  // The one page-href builder every link on this render resolves through:
  // `SiteHeader`'s navigation, and every hero or call-to-action button below.
  // Neither prints a raw stored href; both call `resolveSiteHref` with this.
  const resolvePageHref = defaultPageHref(homeHref, pageHref);
  return (
    <div className="site-canvas" {...siteDesignAttributes(definition.design)}>
      <SiteHeader
        definition={definition}
        homeHref={homeHref}
        blogHref={blogHref}
        currentPage={page}
        pageHref={pageHref}
      />
      <Landmark id="main-content" tabIndex={-1}>
        {page.sections.map((section) => (
          <SiteSection
            key={section.id}
            section={section}
            definition={definition}
            mediaDelivery={mediaDelivery}
            mediaAccessToken={mediaAccessToken}
            editingSurface={editingSurface}
            currentPage={page}
            pageHref={resolvePageHref}
            blogHref={blogHref}
          />
        ))}
        {posts.length === 0 ? null : (
          <section className="blog-index" aria-labelledby="blog_index_title">
            <p className="eyebrow">Journal</p>
            <h2 id="blog_index_title">Latest posts</h2>
            <PublicBlogPostList
              posts={posts}
              postHref={(post) => blogPostHref(post.slug)}
              headingTag="h3"
              mediaDelivery={mediaDelivery}
              mediaAccessToken={mediaAccessToken}
            />
          </section>
        )}
      </Landmark>
    </div>
  );
}

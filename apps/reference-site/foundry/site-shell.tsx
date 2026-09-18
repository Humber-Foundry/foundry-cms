import {
  homePageSlug,
  pagePath,
  resolveSiteHref,
  type PageHrefBuilder,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

export function SiteHeader({
  definition,
  homeHref = "/",
  blogHref = "/blog",
  currentPage = null,
  pageHref,
}: {
  definition: SiteDefinition;
  homeHref?: string;
  blogHref?: string;
  /** The page this route renders, or `null` on a route with no page, such as the Blog. */
  currentPage?: SitePage | null;
  /**
   * Builds one page's public path, for a navigation link that targets a page
   * other than the home page. Defaults to `pagePath`. `homeHref` still wins
   * for the home page itself, so a preview route's own home address is kept.
   */
  pageHref?: PageHrefBuilder;
}) {
  const resolvePageHref: PageHrefBuilder = (page) =>
    page.slug === homePageSlug ? homeHref : (pageHref ?? pagePath)(page);
  return (
    <header className="lh-site-header">
      <a className="lh-skip-link" href="#main-content">Skip to main content</a>
      <a className="lh-wordmark" href={homeHref} aria-label={`${definition.site.name} home`}>
        {definition.site.name}
      </a>
      <nav aria-label="Primary navigation">
        {definition.site.navigation.map((item) => (
          <a
            key={item.id}
            href={resolveSiteHref(definition, item.href, {
              currentPage,
              pageHref: resolvePageHref,
              blogHref,
            })}
          >
            {item.label}
          </a>
        ))}
        <a href={blogHref}>Blog</a>
      </nav>
    </header>
  );
}

export function BlogFooter({
  definition,
  homeHref = "/",
}: {
  definition: SiteDefinition;
  homeHref?: string;
}) {
  return (
    <footer className="lh-blog-footer">
      <p>{definition.site.footer}</p>
      <a href={homeHref}>Back to the main site</a>
    </footer>
  );
}

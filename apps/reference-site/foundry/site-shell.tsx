import type { SiteDefinition } from "@humber-foundry/site-definition";

function navigationHref(homeHref: string, href: string): string {
  return href.startsWith("#") ? `${homeHref}${href}` : href;
}

export function SiteHeader({
  definition,
  homeHref = "/",
  blogHref = "/blog",
}: {
  definition: SiteDefinition;
  homeHref?: string;
  blogHref?: string;
}) {
  return (
    <header className="lh-site-header">
      <a className="lh-skip-link" href="#main-content">Skip to main content</a>
      <a className="lh-wordmark" href={homeHref} aria-label={`${definition.site.name} home`}>
        {definition.site.name}
      </a>
      <nav aria-label="Primary navigation">
        {definition.site.navigation.map((item) => (
          <a key={item.id} href={navigationHref(homeHref, item.href)}>
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

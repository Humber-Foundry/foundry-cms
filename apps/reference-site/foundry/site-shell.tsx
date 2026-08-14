import type { SiteDefinition } from "@humber-foundry/site-definition";

export function SiteHeader({ definition }: { definition: SiteDefinition }) {
  return (
    <header className="lh-site-header">
      <a className="lh-skip-link" href="#main-content">Skip to main content</a>
      <a className="lh-wordmark" href="/" aria-label={`${definition.site.name} home`}>
        {definition.site.name}
      </a>
      <nav aria-label="Primary navigation">
        {definition.site.navigation.map((item) => (
          <a key={item.id} href={`/${item.href}`}>
            {item.label}
          </a>
        ))}
        <a href="/blog">Blog</a>
      </nav>
    </header>
  );
}

export function BlogFooter({ definition }: { definition: SiteDefinition }) {
  return (
    <footer className="lh-blog-footer">
      <p>{definition.site.footer}</p>
      <a href="/">Back to the main site</a>
    </footer>
  );
}

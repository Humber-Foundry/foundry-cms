import type {
  PageSection,
  SiteDefinition,
} from "@humber-foundry/site-definition";
import { siteDesignAttributes } from "@humber-foundry/site-definition";
import type { ReactNode } from "react";

import { MediaOccurrence } from "./media-occurrence";
import { sectionAnchor } from "@/src/section-anchor";
import { RichTextRenderer } from "@/components/rich-text-renderer";

function occurrenceFor(
  definition: SiteDefinition | undefined,
  occurrenceId: string,
) {
  return (definition?.home.media ?? []).find(
    (candidate) => candidate.occurrenceId === occurrenceId,
  ) ?? null;
}

export function SiteSection({
  section,
  definition,
  mediaDelivery = "published",
  mediaAccessToken,
  callToActionBody,
}: {
  section: PageSection;
  definition?: SiteDefinition;
  mediaDelivery?: "authenticated" | "published";
  mediaAccessToken?: string;
  callToActionBody?: ReactNode;
}) {
  switch (section.type) {
    case "hero": {
      const occurrence =
        section.id === "section_hero"
          ? occurrenceFor(definition, "occurrence_home_hero")
          : null;
      return (
        <section
          className="hero"
          data-component-variant={section.variant}
          id={sectionAnchor(section)}
          aria-labelledby={`${section.id}_title`}
        >
          <p className="eyebrow">{section.eyebrow}</p>
          <h1 id={`${section.id}_title`}>{section.title}</h1>
          <p className="hero-summary">{section.summary}</p>
          {occurrence === null ? null : (
            <MediaOccurrence
              className="site-media site-media-hero"
              occurrence={occurrence}
              delivery={mediaDelivery}
              accessToken={mediaAccessToken}
            />
          )}
          <div className="action-row">
            <a className="button button-primary" href={section.primaryAction.href}>
              {section.primaryAction.label}
            </a>
            <a className="text-link" href={section.secondaryAction.href}>
              {section.secondaryAction.label}
              <span aria-hidden="true"> ↘</span>
            </a>
          </div>
        </section>
      );
    }

    case "services": {
      const occurrence =
        section.id === "section_services"
          ? occurrenceFor(definition, "occurrence_home_detail")
          : null;
      return (
        <section
          className="services"
          data-component-variant={section.variant}
          id={sectionAnchor(section)}
          aria-labelledby={`${section.id}_title`}
        >
          <div className="section-heading">
            <p className="eyebrow">{section.eyebrow}</p>
            <h2 id={`${section.id}_title`}>{section.title}</h2>
            <p>{section.introduction}</p>
          </div>
          {occurrence === null ? null : (
            <MediaOccurrence
              className="site-media site-media-detail"
              occurrence={occurrence}
              delivery={mediaDelivery}
              accessToken={mediaAccessToken}
            />
          )}
          <ol className="service-list">
            {section.items.map((item) => (
              <li key={item.id}>
                <span className="service-number" aria-hidden="true">
                  {item.number}
                </span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      );
    }

    case "proof":
      return (
        <section
          className="proof"
          data-component-variant={section.variant}
          id={sectionAnchor(section)}
          aria-label="Foundry principle and outcomes"
        >
          <figure>
            <blockquote>“{section.quote}”</blockquote>
            <figcaption>{section.attribution}</figcaption>
          </figure>
          <dl className="metrics">
            {section.metrics.map((metric) => (
              <div key={metric.id}>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );

    case "callToAction":
      return (
        <section
          className="contact"
          data-component-variant={section.variant}
          id={sectionAnchor(section)}
          aria-labelledby={`${section.id}_title`}
        >
          <p className="eyebrow">{section.eyebrow}</p>
          <h2 id={`${section.id}_title`}>{section.title}</h2>
          <div className="rich-text">
            {callToActionBody ?? (
              <RichTextRenderer document={section.body} headingOffset={1} />
            )}
          </div>
          <a className="button button-light" href={section.action.href}>
            {section.action.label}
          </a>
        </section>
      );

    default: {
      const exhaustiveCheck: never = section;
      return exhaustiveCheck;
    }
  }
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

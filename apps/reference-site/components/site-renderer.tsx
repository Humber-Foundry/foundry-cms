import type {
  MediaAsset,
  MediaOccurrenceRevision,
} from "@foundry/application";
import type {
  PageSection,
  SiteDefinition,
} from "@foundry/site-definition";

import { MediaOccurrence } from "./media-occurrence";
import { sectionAnchor } from "@/src/section-anchor";

type MediaPresentation = Readonly<{
  assets: ReadonlyArray<MediaAsset>;
  occurrences: ReadonlyArray<MediaOccurrenceRevision>;
}>;

function occurrenceFor(
  media: MediaPresentation,
  occurrenceId: string,
) {
  const occurrence = media.occurrences.find(
    (candidate) => candidate.occurrenceId === occurrenceId,
  );
  if (occurrence === undefined) return null;
  const asset = media.assets.find(
    (candidate) => candidate.assetId === occurrence.assetId,
  );
  return asset === undefined ? null : { occurrence, asset };
}

export function SiteSection({
  section,
  media,
}: {
  section: PageSection;
  media: MediaPresentation;
}) {
  switch (section.type) {
    case "hero": {
      const presentation = occurrenceFor(media, "occurrence_home_hero");
      return (
        <section
          className="hero"
          id={sectionAnchor(section)}
          aria-labelledby={`${section.id}_title`}
        >
          <p className="eyebrow">{section.eyebrow}</p>
          <h1 id={`${section.id}_title`}>{section.title}</h1>
          <p className="hero-summary">{section.summary}</p>
          {presentation === null ? null : (
            <MediaOccurrence
              className="site-media site-media-hero"
              {...presentation}
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
      const presentation = occurrenceFor(media, "occurrence_home_detail");
      return (
        <section
          className="services"
          id={sectionAnchor(section)}
          aria-labelledby={`${section.id}_title`}
        >
          <div className="section-heading">
            <p className="eyebrow">{section.eyebrow}</p>
            <h2 id={`${section.id}_title`}>{section.title}</h2>
            <p>{section.introduction}</p>
          </div>
          {presentation === null ? null : (
            <MediaOccurrence
              className="site-media site-media-detail"
              {...presentation}
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
          id={sectionAnchor(section)}
          aria-labelledby={`${section.id}_title`}
        >
          <p className="eyebrow">{section.eyebrow}</p>
          <h2 id={`${section.id}_title`}>{section.title}</h2>
          <p>{section.body}</p>
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
  media = { assets: [], occurrences: [] },
}: {
  definition: SiteDefinition;
  media?: MediaPresentation;
}) {
  return (
    <>
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
          <SiteSection key={section.id} section={section} media={media} />
        ))}
      </main>
      <footer className="site-footer">
        <p>{definition.site.footer}</p>
        <p>Site Definition v{definition.definitionVersion}</p>
      </footer>
    </>
  );
}

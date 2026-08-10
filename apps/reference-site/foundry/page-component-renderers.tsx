import type { PageSection, SiteDefinition } from "@humber-foundry/site-definition";
import type { ReactNode } from "react";

import { MediaOccurrence } from "@/components/media-occurrence";
import { RichTextRenderer } from "@/components/rich-text-renderer";
import { sectionAnchor } from "@/src/section-anchor";

export type PageComponentRenderContext = Readonly<{
  section: PageSection;
  definition?: SiteDefinition;
  mediaDelivery?: "authenticated" | "published";
  mediaAccessToken?: string;
  callToActionBody?: ReactNode;
}>;

export type PageComponentRenderer = (
  context: PageComponentRenderContext,
) => ReactNode;

function occurrenceFor(
  definition: SiteDefinition | undefined,
  occurrenceId: string,
) {
  return (definition?.home.media ?? []).find(
    (candidate) => candidate.occurrenceId === occurrenceId,
  ) ?? null;
}

export const renderHeroPageComponent: PageComponentRenderer = ({
  section,
  definition,
  mediaDelivery = "published",
  mediaAccessToken,
}) => {
  if (section.type !== "hero") throw new TypeError("hero_page_component_required");
  const occurrence = section.id === "section_hero"
    ? occurrenceFor(definition, "occurrence_home_hero")
    : null;
  return (
    <section className="hero" data-component-variant={section.variant} id={sectionAnchor(section)} aria-labelledby={`${section.id}_title`}>
      <p className="eyebrow">{section.eyebrow}</p>
      <h1 id={`${section.id}_title`}>{section.title}</h1>
      <p className="hero-summary">{section.summary}</p>
      {occurrence === null ? null : <MediaOccurrence className="site-media site-media-hero" occurrence={occurrence} delivery={mediaDelivery} accessToken={mediaAccessToken} />}
      <div className="action-row">
        <a className="button button-primary" href={section.primaryAction.href}>{section.primaryAction.label}</a>
        <a className="text-link" href={section.secondaryAction.href}>{section.secondaryAction.label}<span aria-hidden="true"> ↘</span></a>
      </div>
    </section>
  );
};

export const renderServicesPageComponent: PageComponentRenderer = ({
  section,
  definition,
  mediaDelivery = "published",
  mediaAccessToken,
}) => {
  if (section.type !== "services") throw new TypeError("services_page_component_required");
  const occurrence = section.id === "section_services"
    ? occurrenceFor(definition, "occurrence_home_detail")
    : null;
  return (
    <section className="services" data-component-variant={section.variant} id={sectionAnchor(section)} aria-labelledby={`${section.id}_title`}>
      <div className="section-heading"><p className="eyebrow">{section.eyebrow}</p><h2 id={`${section.id}_title`}>{section.title}</h2><p>{section.introduction}</p></div>
      {occurrence === null ? null : <MediaOccurrence className="site-media site-media-detail" occurrence={occurrence} delivery={mediaDelivery} accessToken={mediaAccessToken} />}
      <ol className="service-list">{section.items.map((item) => <li key={item.id}><span className="service-number" aria-hidden="true">{item.number}</span><div><h3>{item.title}</h3><p>{item.description}</p></div></li>)}</ol>
    </section>
  );
};

export const renderProofPageComponent: PageComponentRenderer = ({ section }) => {
  if (section.type !== "proof") throw new TypeError("proof_page_component_required");
  return (
    <section className="proof" data-component-variant={section.variant} id={sectionAnchor(section)} aria-label="Foundry principle and outcomes">
      <figure><blockquote>“{section.quote}”</blockquote><figcaption>{section.attribution}</figcaption></figure>
      <dl className="metrics">{section.metrics.map((metric) => <div key={metric.id}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>
    </section>
  );
};

export const renderCallToActionPageComponent: PageComponentRenderer = ({
  section,
  callToActionBody,
}) => {
  if (section.type !== "callToAction") throw new TypeError("call_to_action_page_component_required");
  return (
    <section className="contact" data-component-variant={section.variant} id={sectionAnchor(section)} aria-labelledby={`${section.id}_title`}>
      <p className="eyebrow">{section.eyebrow}</p><h2 id={`${section.id}_title`}>{section.title}</h2>
      <div className="rich-text">{callToActionBody ?? <RichTextRenderer document={section.body} headingOffset={1} />}</div>
      <a className="button button-light" href={section.action.href}>{section.action.label}</a>
    </section>
  );
};

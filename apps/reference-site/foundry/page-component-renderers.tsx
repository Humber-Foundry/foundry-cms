import type { PageSection, SiteDefinition } from "@humber-foundry/site-definition";
import type { ReactNode } from "react";

import { MediaOccurrence } from "@/components/media-occurrence";
import { RichTextRenderer } from "@/components/rich-text-renderer";
import { sectionAnchor } from "@/src/section-anchor";

/**
 * Renders one field's text editable in place inside the section's own markup.
 * The editor supplies this while the section is selected; on the public site
 * and in previews it is absent and renderers fall back to the plain string.
 */
export type InlineTextRenderer = (
  path: string,
  value: string,
  options?: Readonly<{ multiline?: boolean; label?: string }>,
) => ReactNode;

/**
 * Renders one image field editable in place: the photo the field holds, with a
 * "Change photo" control on the image itself that opens the shared picker and
 * swaps the photo through the normal draft flow (ADR-0012). The editor supplies
 * this only while the section is selected; the public site and previews leave it
 * absent, and renderers draw the plain `<img>`.
 */
export type InlineImageRenderer = (
  path: string,
  displaySrc: string,
  options: Readonly<{ alt: string }>,
) => ReactNode;

export type PageComponentRenderContext = Readonly<{
  section: PageSection;
  definition?: SiteDefinition;
  mediaDelivery?: "authenticated" | "published";
  mediaAccessToken?: string;
  callToActionBody?: ReactNode;
  inlineText?: InlineTextRenderer;
  inlineImage?: InlineImageRenderer;
  /**
   * True on editing surfaces (the canvas and browse mode), which render
   * inside the authenticated dashboard. Third-party embeds are sandboxed
   * there; the public site and the exact preview render them live.
   */
  editingSurface?: boolean;
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

/**
 * Wraps one field's text so it renders editable where it stands when the editor
 * supplies an inline-text renderer, and as the plain string it always was on
 * the public site and in previews.
 */
function inlineOr(inlineText: InlineTextRenderer | undefined) {
  return (
    path: string,
    value: string,
    options?: Readonly<{ multiline?: boolean; label?: string }>,
  ): ReactNode => (inlineText === undefined ? value : inlineText(path, value, options));
}

export const renderHeroPageComponent: PageComponentRenderer = ({
  section,
  definition,
  mediaDelivery = "published",
  mediaAccessToken,
  inlineText,
}) => {
  if (section.type !== "hero") throw new TypeError("hero_page_component_required");
  const t = inlineOr(inlineText);
  const occurrence = section.id === "section_hero"
    ? occurrenceFor(definition, "occurrence_home_hero")
    : null;
  return (
    <section className="hero" data-component-variant={section.variant} id={sectionAnchor(section)} aria-labelledby={`${section.id}_title`}>
      <p className="eyebrow">{t("eyebrow", section.eyebrow, { label: "Eyebrow" })}</p>
      <h1 id={`${section.id}_title`}>{t("title", section.title, { label: "Title" })}</h1>
      <p className="hero-summary">{t("summary", section.summary, { multiline: true, label: "Summary" })}</p>
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
  inlineText,
}) => {
  if (section.type !== "services") throw new TypeError("services_page_component_required");
  const t = inlineOr(inlineText);
  const occurrence = section.id === "section_services"
    ? occurrenceFor(definition, "occurrence_home_detail")
    : null;
  return (
    <section className="services" data-component-variant={section.variant} id={sectionAnchor(section)} aria-labelledby={`${section.id}_title`}>
      <div className="section-heading"><p className="eyebrow">{t("eyebrow", section.eyebrow, { label: "Eyebrow" })}</p><h2 id={`${section.id}_title`}>{t("title", section.title, { label: "Title" })}</h2><p>{t("introduction", section.introduction, { multiline: true, label: "Introduction" })}</p></div>
      {occurrence === null ? null : <MediaOccurrence className="site-media site-media-detail" occurrence={occurrence} delivery={mediaDelivery} accessToken={mediaAccessToken} />}
      <ol className="service-list">{section.items.map((item) => <li key={item.id}><span className="service-number" aria-hidden="true">{item.number}</span><div><h3>{item.title}</h3><p>{item.description}</p></div></li>)}</ol>
    </section>
  );
};

export const renderProofPageComponent: PageComponentRenderer = ({ section, inlineText }) => {
  if (section.type !== "proof") throw new TypeError("proof_page_component_required");
  const t = inlineOr(inlineText);
  return (
    <section className="proof" data-component-variant={section.variant} id={sectionAnchor(section)} aria-label="Foundry principle and outcomes">
      <figure><blockquote>“{t("quote", section.quote, { multiline: true, label: "Quote" })}”</blockquote><figcaption>{t("attribution", section.attribution, { label: "Attribution" })}</figcaption></figure>
      <dl className="metrics">{section.metrics.map((metric) => <div key={metric.id}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>
    </section>
  );
};

export const renderCallToActionPageComponent: PageComponentRenderer = ({
  section,
  callToActionBody,
  inlineText,
}) => {
  if (section.type !== "callToAction") throw new TypeError("call_to_action_page_component_required");
  const t = inlineOr(inlineText);
  return (
    <section className="contact" data-component-variant={section.variant} id={sectionAnchor(section)} aria-labelledby={`${section.id}_title`}>
      <p className="eyebrow">{t("eyebrow", section.eyebrow, { label: "Eyebrow" })}</p><h2 id={`${section.id}_title`}>{t("title", section.title, { label: "Title" })}</h2>
      <div className="rich-text">{callToActionBody ?? <RichTextRenderer document={section.body} headingOffset={1} />}</div>
      <a className="button button-light" href={section.action.href}>{section.action.label}</a>
    </section>
  );
};

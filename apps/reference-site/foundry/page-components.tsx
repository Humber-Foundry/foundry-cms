import type { ReactNode } from "react";

import {
  createPageComponentRegistry,
  createRegisteredPageComponent,
  foundationPageComponentRegistry,
  type PageComponentField,
  type PageSection,
  type RegisteredPageSection,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

export const imageCopyStoryComponent = createRegisteredPageComponent({
  type: "imageCopyStory",
  label: "Image and copy story",
  fields: {
    eyebrow: { control: "text", label: "Eyebrow", defaultValue: "A shared practice" },
    title: { control: "text", label: "Title", defaultValue: "Make room for a better question" },
    body: { control: "textarea", label: "Story", defaultValue: "Begin with curiosity, listen closely, and make the next step together." },
    imageSrc: { control: "image", label: "Image", defaultValue: "/foundry-workshop.svg" },
    imageAlt: { control: "text", label: "Image description", defaultValue: "People sharing ideas around a workshop table" },
    imagePosition: {
      control: "select",
      label: "Image position",
      defaultValue: "start",
      options: [
        { label: "Start", value: "start" },
        { label: "End", value: "end" },
      ],
    },
  },
});

export const photoBandComponent = createRegisteredPageComponent({
  type: "photoBand",
  label: "Full-width image",
  fields: {
    imageSrc: { control: "image", label: "Image", defaultValue: "/foundry-gathering.svg" },
    imageAlt: { control: "text", label: "Image description", defaultValue: "A bright gathering space ready for a group" },
    caption: { control: "text", label: "Caption", defaultValue: "A place to notice what becomes possible together." },
  },
});

export const connectorCardsComponent = createRegisteredPageComponent({
  type: "connectorCards",
  label: "Connector cards",
  fields: {
    eyebrow: { control: "text", label: "Eyebrow", defaultValue: "Connectors" },
    title: { control: "text", label: "Title", defaultValue: "Bring the right people into the room" },
    introduction: { control: "textarea", label: "Introduction", defaultValue: "Good work grows through generous relationships and clear invitations." },
    cards: {
      control: "array",
      label: "Cards",
      minItems: 1,
      maxItems: 6,
      fields: {
        title: { control: "text", label: "Title", defaultValue: "A thoughtful connection" },
        body: { control: "textarea", label: "Body", defaultValue: "Name who should meet and why the conversation matters." },
      },
      defaultValue: [
        { title: "Ideas to people", body: "Find the collaborators who can move an idea into useful action." },
        { title: "People to purpose", body: "Create the conditions for a group to work with trust and direction." },
        { title: "Purpose to practice", body: "Turn shared intent into habits that can last beyond one gathering." },
      ],
    },
  },
});

export const invitationNewsletterComponent = createRegisteredPageComponent({
  type: "invitationNewsletter",
  label: "Invitation and newsletter",
  fields: {
    eyebrow: { control: "text", label: "Eyebrow", defaultValue: "An invitation" },
    title: { control: "text", label: "Title", defaultValue: "Stay close to the useful questions" },
    body: { control: "textarea", label: "Body", defaultValue: "Occasional notes about gathering people, making change, and finding clarity in the middle." },
    actionLabel: { control: "text", label: "Action label", defaultValue: "Join the list" },
    actionHref: { control: "url", label: "Action URL", defaultValue: "#newsletter" },
    note: { control: "text", label: "Privacy note", defaultValue: "A thoughtful note now and then. Unsubscribe anytime." },
  },
});

export const installedPageComponentRegistry = createPageComponentRegistry(
  foundationPageComponentRegistry,
  [
    imageCopyStoryComponent,
    photoBandComponent,
    connectorCardsComponent,
    invitationNewsletterComponent,
  ],
);

export const installedCustomPageComponents = Object.freeze([
  imageCopyStoryComponent,
  photoBandComponent,
  connectorCardsComponent,
  invitationNewsletterComponent,
]);

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

function registeredProps(section: PageSection): Record<string, unknown> {
  if (section.type !== "registered") {
    throw new TypeError("registered_page_component_required");
  }
  const validation = installedPageComponentRegistry.validate(section);
  if (!validation.ok) throw new TypeError("page_component_invalid");
  return section.props as Record<string, unknown>;
}

function text(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  if (typeof value !== "string") throw new TypeError("page_component_prop_invalid");
  return value;
}

export const installedCustomPageComponentRenderers = Object.freeze<
  Record<string, PageComponentRenderer>
>({
  imageCopyStory: ({ section }) => {
    const props = registeredProps(section);
    return (
      <section
        className="story-section"
        data-image-position={text(props, "imagePosition")}
        id={section.id}
        aria-labelledby={`${section.id}_title`}
      >
        <figure>
          <img src={text(props, "imageSrc")} alt={text(props, "imageAlt")} />
        </figure>
        <div className="story-copy">
          <p className="handwritten-label">{text(props, "eyebrow")}</p>
          <h2 id={`${section.id}_title`}>{text(props, "title")}</h2>
          <p>{text(props, "body")}</p>
        </div>
      </section>
    );
  },
  photoBand: ({ section }) => {
    const props = registeredProps(section);
    return (
      <figure className="photo-band" id={section.id}>
        <img src={text(props, "imageSrc")} alt={text(props, "imageAlt")} />
        <figcaption>{text(props, "caption")}</figcaption>
      </figure>
    );
  },
  connectorCards: ({ section }) => {
    const props = registeredProps(section);
    const cards = props.cards as ReadonlyArray<Readonly<Record<string, string>>>;
    return (
      <section className="connector-section" id={section.id} aria-labelledby={`${section.id}_title`}>
        <div className="connector-heading">
          <p className="handwritten-label">{text(props, "eyebrow")}</p>
          <h2 id={`${section.id}_title`}>{text(props, "title")}</h2>
          <p>{text(props, "introduction")}</p>
        </div>
        <ul className="connector-grid">
          {cards.map((card, index) => (
            <li key={`${card.title}-${index}`}>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  },
  invitationNewsletter: ({ section }) => {
    const props = registeredProps(section);
    return (
      <section className="invitation-section" id={section.id} aria-labelledby={`${section.id}_title`}>
        <p className="handwritten-label">{text(props, "eyebrow")}</p>
        <h2 id={`${section.id}_title`}>{text(props, "title")}</h2>
        <p>{text(props, "body")}</p>
        <a className="invitation-action" href={text(props, "actionHref")}>
          {text(props, "actionLabel")}
        </a>
        <small>{text(props, "note")}</small>
      </section>
    );
  },
});

export function createPuckField(field: PageComponentField): Record<string, unknown> {
  if (field.control === "array") {
    return {
      type: "array",
      label: field.label,
      min: field.minItems,
      max: field.maxItems,
      arrayFields: Object.fromEntries(
        Object.entries(field.fields).map(([key, nested]) => [key, createPuckField(nested)]),
      ),
      getItemSummary: (item: Record<string, unknown>) =>
        typeof item.title === "string" ? item.title : field.label,
    };
  }
  if (field.control === "select") {
    return { type: "select", label: field.label, options: field.options };
  }
  return {
    type: field.control === "textarea" ? "textarea" : "text",
    label: field.label,
  };
}

export function asRegisteredPageSection(
  type: string,
  props: Record<string, unknown>,
): RegisteredPageSection {
  return {
    id: String(props.id),
    type: "registered",
    component: type,
    props: Object.fromEntries(
      installedPageComponentRegistry.components[type]!.editableFields.map((key) => [key, props[key]]),
    ),
  };
}

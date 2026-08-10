import {
  createPageComponentRegistryFromRegistrations,
  createRegisteredPageComponent,
  foundationPageComponentRegistry,
  type PageComponentField,
  type PageComponentRegistration,
  type PageComponentRegistry,
  type PageSection,
  type RegisteredPageComponentProps,
  type RegisteredPageSection,
} from "@humber-foundry/site-definition";
import {
  renderCallToActionPageComponent,
  renderHeroPageComponent,
  renderProofPageComponent,
  renderServicesPageComponent,
  type PageComponentRenderer,
} from "./page-component-renderers";

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
    actionHref: { control: "url", label: "Action URL", defaultValue: "mailto:hello@example.com" },
    note: { control: "text", label: "Privacy note", defaultValue: "A thoughtful note now and then. Unsubscribe anytime." },
  },
});

export type InstalledPageComponentRegistration = PageComponentRegistration &
  Readonly<{ renderer: PageComponentRenderer }>;

export type InstalledPageComponentRegistry = Omit<
  PageComponentRegistry,
  "components"
> & Readonly<{
  components: Readonly<Record<string, InstalledPageComponentRegistration>>;
}>;

function installPageComponent(
  registration: PageComponentRegistration,
  renderer: PageComponentRenderer,
): InstalledPageComponentRegistration {
  return Object.freeze({ ...registration, renderer });
}

function registeredProps<
  const Fields extends Readonly<Record<string, PageComponentField>>,
>(
  registration: PageComponentRegistration & Readonly<{ fields: Fields }>,
  section: PageSection,
): RegisteredPageComponentProps<Fields> {
  if (section.type !== "registered") {
    throw new TypeError("registered_page_component_required");
  }
  const validation = registration.validate(section);
  if (!validation.ok) throw new TypeError("page_component_invalid");
  return section.props as RegisteredPageComponentProps<Fields>;
}

const installedRegistrations = Object.freeze([
  installPageComponent(
    foundationPageComponentRegistry.components.hero!,
    renderHeroPageComponent,
  ),
  installPageComponent(
    foundationPageComponentRegistry.components.services!,
    renderServicesPageComponent,
  ),
  installPageComponent(
    foundationPageComponentRegistry.components.proof!,
    renderProofPageComponent,
  ),
  installPageComponent(
    foundationPageComponentRegistry.components.callToAction!,
    renderCallToActionPageComponent,
  ),
  installPageComponent(imageCopyStoryComponent, ({ section }) => {
    const props = registeredProps(imageCopyStoryComponent, section);
    return (
      <section
        className="story-section"
        data-image-position={props.imagePosition}
        id={section.id}
        aria-labelledby={`${section.id}_title`}
      >
        <figure>
          <img src={props.imageSrc} alt={props.imageAlt} />
        </figure>
        <div className="story-copy">
          <p className="handwritten-label">{props.eyebrow}</p>
          <h2 id={`${section.id}_title`}>{props.title}</h2>
          <p>{props.body}</p>
        </div>
      </section>
    );
  }),
  installPageComponent(photoBandComponent, ({ section }) => {
    const props = registeredProps(photoBandComponent, section);
    return (
      <figure className="photo-band" id={section.id}>
        <img src={props.imageSrc} alt={props.imageAlt} />
        <figcaption>{props.caption}</figcaption>
      </figure>
    );
  }),
  installPageComponent(connectorCardsComponent, ({ section }) => {
    const props = registeredProps(connectorCardsComponent, section);
    const cards = props.cards;
    return (
      <section className="connector-section" id={section.id} aria-labelledby={`${section.id}_title`}>
        <div className="connector-heading">
          <p className="handwritten-label">{props.eyebrow}</p>
          <h2 id={`${section.id}_title`}>{props.title}</h2>
          <p>{props.introduction}</p>
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
  }),
  installPageComponent(invitationNewsletterComponent, ({ section }) => {
    const props = registeredProps(invitationNewsletterComponent, section);
    return (
      <section className="invitation-section" id={section.id} aria-labelledby={`${section.id}_title`}>
        <p className="handwritten-label">{props.eyebrow}</p>
        <h2 id={`${section.id}_title`}>{props.title}</h2>
        <p>{props.body}</p>
        <a className="invitation-action" href={props.actionHref}>
          {props.actionLabel}
        </a>
        <small>{props.note}</small>
      </section>
    );
  }),
]);

export const installedPageComponentRegistry =
  createPageComponentRegistryFromRegistrations(
    installedRegistrations,
  ) as InstalledPageComponentRegistry;

export function createPuckField(field: PageComponentField): Record<string, unknown> {
  if (field.control === "object") {
    return {
      type: "object",
      label: field.label,
      objectFields: Object.fromEntries(
        Object.entries(field.fields).map(([key, nested]) => [key, createPuckField(nested)]),
      ),
    };
  }
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
  const candidateId = String(props.id);
  const id = /^[a-z][a-z0-9_]*$/u.test(candidateId)
    ? candidateId
    : `section_${type.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}_${candidateId
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "_")
        .replace(/^_+|_+$/gu, "")}`;
  return {
    id,
    type: "registered",
    component: type,
    props: Object.fromEntries(
      Object.keys(installedPageComponentRegistry.components[type]!.fields).map(
        (key) => [key, props[key]],
      ),
    ),
  };
}

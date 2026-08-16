import {
  createPageComponentRegistryFromRegistrations,
  createRegisteredPageComponent,
  foundationPageComponentRegistry,
  resolveMediaImageSrc,
  type PageComponentField,
  type PageComponentRegistration,
  type PageComponentRegistry,
  type PageSection,
  type RegisteredPageComponentProps,
  type RegisteredPageSection,
} from "@humber-foundry/site-definition";
import type { ReactNode } from "react";
import {
  renderCallToActionPageComponent,
  renderHeroPageComponent,
  renderProofPageComponent,
  renderServicesPageComponent,
  type InlineTextRenderer,
  type PageComponentRenderer,
} from "./page-component-renderers";
import { AttentionNotes } from "../components/attention-notes";

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

const text = (label: string, defaultValue: string) =>
  ({ control: "text", label, defaultValue }) as const;
const textarea = (label: string, defaultValue: string) =>
  ({ control: "textarea", label, defaultValue }) as const;
const image = (label: string, defaultValue: string) =>
  ({ control: "image", label, defaultValue }) as const;

/**
 * A story section with movable "attention notes" — sticky-note text a visitor
 * can drag around, or nudge with the arrow keys. It carries the editor's
 * in-place text editing so each sentence is edited where it stands.
 */
export const attentionStoryComponent = createRegisteredPageComponent({
  type: "attentionStory",
  label: "Attention story",
  fields: {
    title: text("Title", "How it works"),
    introduction: textarea("Introduction", "People call it many things. Accurate, but incomplete."),
    statementBefore: text("Statement before highlight", "What it comes down to is "),
    statementHighlight: text("Highlighted statement", "paying attention"),
    body: textarea("Body", "To what is said, and to what sits just beneath the surface — the patterns and quiet signals that show where a group is stuck, and where movement is possible."),
    attentionLabel: text("Notes heading", "Worth paying attention to:"),
    attentionHint: text("Notes invitation", "go on — move them around"),
    notes: {
      control: "array",
      label: "Attention notes",
      minItems: 1,
      maxItems: 8,
      fields: {
        body: textarea("Note", "the space between people"),
        tone: {
          control: "select",
          label: "Paper colour",
          defaultValue: "green",
          options: [
            { label: "Green", value: "green" },
            { label: "Periwinkle", value: "periwinkle" },
            { label: "Yellow", value: "yellow" },
          ],
        },
      },
      defaultValue: [
        { body: "the space between people", tone: "green" },
        { body: "the words we use, and how they open or close connection", tone: "periwinkle" },
        { body: "small shifts in understanding as people think out loud", tone: "yellow" },
        { body: "what happens just before a group arrives, and what lingers after", tone: "green" },
      ],
    },
    quote: text("Pull quote", "That is not accidental. It is the work."),
    imageSrc: image("Image", "/foundry-workshop.svg"),
    imageAlt: textarea("Image description", "A presenter writing on a whiteboard while a group looks on."),
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

function Highlight({ children }: { children: ReactNode }) {
  return <span className="marker-highlight">{children}</span>;
}

/**
 * The renderer's bridge to in-place editing. When the editor supplies an
 * inline-text renderer (the section is selected in the canvas), each wrapped
 * string renders editable where it stands; everywhere else it renders as the
 * plain string it always was. Labels and multiline behaviour come from the
 * component's own field registration.
 */
function inlineTextFor(
  inlineText: InlineTextRenderer | undefined,
  registration: Readonly<{ fields: Readonly<Record<string, PageComponentField>> }>,
) {
  return (path: string, value: string): ReactNode => {
    if (inlineText === undefined) return value;
    const [head, , itemKey] = path.split(".");
    const field = registration.fields[head!];
    const resolved =
      field !== undefined && field.control === "array" && itemKey !== undefined
        ? field.fields[itemKey]
        : field;
    return inlineText(path, value, {
      multiline: resolved?.control === "textarea",
      label: resolved?.label ?? head!,
    });
  };
}

/**
 * The fields each registered renderer edits in place. The editor hides these
 * from the side panel so every piece of text has exactly one editing surface;
 * array fields stay in the panel because items are added and removed there.
 */
export const inlineEditedTextFields: Readonly<Record<string, ReadonlySet<string>>> = {
  attentionStory: new Set([
    "title", "introduction", "statementBefore", "statementHighlight", "body",
    "attentionLabel", "attentionHint", "quote",
  ]),
};

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
  installPageComponent(imageCopyStoryComponent, ({ section, mediaDelivery = "published", mediaAccessToken }) => {
    const props = registeredProps(imageCopyStoryComponent, section);
    return (
      <section
        className="story-section"
        data-image-position={props.imagePosition}
        id={section.id}
        aria-labelledby={`${section.id}_title`}
      >
        <figure>
          <img src={resolveMediaImageSrc(props.imageSrc, mediaDelivery, mediaAccessToken)} alt={props.imageAlt} />
        </figure>
        <div className="story-copy">
          <p className="handwritten-label">{props.eyebrow}</p>
          <h2 id={`${section.id}_title`}>{props.title}</h2>
          <p>{props.body}</p>
        </div>
      </section>
    );
  }),
  installPageComponent(photoBandComponent, ({ section, mediaDelivery = "published", mediaAccessToken }) => {
    const props = registeredProps(photoBandComponent, section);
    return (
      <figure className="photo-band" id={section.id}>
        <img src={resolveMediaImageSrc(props.imageSrc, mediaDelivery, mediaAccessToken)} alt={props.imageAlt} />
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
  installPageComponent(attentionStoryComponent, ({ section, inlineText, mediaDelivery = "published", mediaAccessToken }) => {
    const props = registeredProps(attentionStoryComponent, section);
    const t = inlineTextFor(inlineText, attentionStoryComponent);
    return (
      <section className="lh-section" id={section.id} aria-labelledby={`${section.id}_title`}>
        <div className="lh-contained">
          <div className="lh-story-grid lh-story-grid-wide">
            <div>
              <h2 id={`${section.id}_title`}>{t("title", props.title)}</h2>
              <p>{t("introduction", props.introduction)}</p>
              <p className="lh-big-line">
                {t("statementBefore", props.statementBefore)}
                <Highlight>{t("statementHighlight", props.statementHighlight)}</Highlight>.
              </p>
              <p>{t("body", props.body)}</p>
            </div>
            <figure className="lh-bare-photo">
              <img src={resolveMediaImageSrc(props.imageSrc, mediaDelivery, mediaAccessToken)} alt={props.imageAlt} width="1067" height="1600" loading="lazy" />
            </figure>
          </div>
          <AttentionNotes
            label={t("attentionLabel", props.attentionLabel)}
            hint={t("attentionHint", props.attentionHint)}
            notes={props.notes}
          />
          <blockquote>{t("quote", props.quote)}</blockquote>
        </div>
      </section>
    );
  }),
]);

export const installedPageComponentRegistry =
  createPageComponentRegistryFromRegistrations(
    installedRegistrations,
  ) as InstalledPageComponentRegistry;

export function createPuckField(field: PageComponentField): Record<string, unknown> {
  if (field.editable === false) {
    return { type: "custom", visible: false, render: () => null };
  }
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
        typeof item.title === "string"
          ? item.title
          : typeof item.label === "string"
            ? item.label
            : typeof item.body === "string"
              ? item.body
              : field.label,
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

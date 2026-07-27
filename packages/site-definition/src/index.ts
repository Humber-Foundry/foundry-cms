import {
  RICH_TEXT_VERSION,
  type RichTextDocument,
} from "./rich-text";

export * from "./rich-text";

declare const siteIdBrand: unique symbol;

export type SiteId = string & {
  readonly [siteIdBrand]: "SiteId";
};

export function createSiteId(value: string): SiteId {
  if (!/^site_[a-z0-9_]+$/.test(value)) {
    throw new TypeError(
      `Site IDs must start with "site_" and contain lowercase letters, numbers, or underscores: ${value}`,
    );
  }

  return value as SiteId;
}

export type SiteHref = `#${string}` | `mailto:${string}`;

export type SiteLink = Readonly<{
  id: string;
  label: string;
  href: SiteHref;
}>;

export type HeroSection = Readonly<{
  id: string;
  type: "hero";
  eyebrow: string;
  title: string;
  summary: string;
  primaryAction: SiteLink;
  secondaryAction: SiteLink;
}>;

export type ServicesSection = Readonly<{
  id: string;
  type: "services";
  eyebrow: string;
  title: string;
  introduction: string;
  items: ReadonlyArray<
    Readonly<{
      id: string;
      number: string;
      title: string;
      description: string;
    }>
  >;
}>;

export type ProofSection = Readonly<{
  id: string;
  type: "proof";
  quote: string;
  attribution: string;
  metrics: ReadonlyArray<
    Readonly<{
      id: string;
      value: string;
      label: string;
    }>
  >;
}>;

export type CallToActionSection = Readonly<{
  id: string;
  type: "callToAction";
  eyebrow: string;
  title: string;
  body: RichTextDocument;
  action: SiteLink;
}>;

export type PageSection =
  | HeroSection
  | ServicesSection
  | ProofSection
  | CallToActionSection;

export type SiteDefinition = Readonly<{
  definitionVersion: "1.1.0";
  schemaVersion: "1.1.0";
  site: Readonly<{
    id: SiteId;
    name: string;
    description: string;
    navigation: ReadonlyArray<SiteLink>;
    footer: string;
  }>;
  home: Readonly<{
    id: string;
    seo: Readonly<{
      title: string;
      description: string;
    }>;
    sections: ReadonlyArray<PageSection>;
  }>;
}>;

export const siteDefinitionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://foundrycms.dev/schemas/site-definition/1.1.0",
  title: "Foundry CMS Site Definition",
  type: "object",
  additionalProperties: false,
  required: ["definitionVersion", "schemaVersion", "site", "home"],
  properties: {
    definitionVersion: { const: "1.1.0" },
    schemaVersion: { const: "1.1.0" },
    site: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "description", "navigation", "footer"],
      properties: {
        id: { $ref: "#/$defs/siteId" },
        name: { $ref: "#/$defs/text" },
        description: { $ref: "#/$defs/text" },
        navigation: {
          type: "array",
          items: { $ref: "#/$defs/link" },
        },
        footer: { $ref: "#/$defs/text" },
      },
    },
    home: {
      type: "object",
      additionalProperties: false,
      required: ["id", "seo", "sections"],
      properties: {
        id: { $ref: "#/$defs/id" },
        seo: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description"],
          properties: {
            title: { $ref: "#/$defs/text" },
            description: { $ref: "#/$defs/text" },
          },
        },
        sections: {
          type: "array",
          items: {
            oneOf: [
              { $ref: "#/$defs/heroSection" },
              { $ref: "#/$defs/servicesSection" },
              { $ref: "#/$defs/proofSection" },
              { $ref: "#/$defs/callToActionSection" },
            ],
          },
        },
      },
    },
  },
  $defs: {
    id: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]*$",
    },
    siteId: {
      type: "string",
      pattern: "^site_[a-z0-9_]+$",
    },
    text: {
      type: "string",
      minLength: 1,
    },
    link: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "href"],
      properties: {
        id: { $ref: "#/$defs/id" },
        label: { $ref: "#/$defs/text" },
        href: { $ref: "#/$defs/href" },
      },
    },
    href: {
      type: "string",
      anyOf: [
        { pattern: "^#[a-z][a-z0-9_]*$" },
        { pattern: "^mailto:[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
      ],
    },
    serviceItem: {
      type: "object",
      additionalProperties: false,
      required: ["id", "number", "title", "description"],
      properties: {
        id: { $ref: "#/$defs/id" },
        number: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        description: { $ref: "#/$defs/text" },
      },
    },
    metric: {
      type: "object",
      additionalProperties: false,
      required: ["id", "value", "label"],
      properties: {
        id: { $ref: "#/$defs/id" },
        value: { $ref: "#/$defs/text" },
        label: { $ref: "#/$defs/text" },
      },
    },
    heroSection: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "type",
        "eyebrow",
        "title",
        "summary",
        "primaryAction",
        "secondaryAction",
      ],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "hero" },
        eyebrow: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        summary: { $ref: "#/$defs/text" },
        primaryAction: { $ref: "#/$defs/link" },
        secondaryAction: { $ref: "#/$defs/link" },
      },
    },
    servicesSection: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "eyebrow", "title", "introduction", "items"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "services" },
        eyebrow: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        introduction: { $ref: "#/$defs/text" },
        items: {
          type: "array",
          items: { $ref: "#/$defs/serviceItem" },
        },
      },
    },
    proofSection: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "quote", "attribution", "metrics"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "proof" },
        quote: { $ref: "#/$defs/text" },
        attribution: { $ref: "#/$defs/text" },
        metrics: {
          type: "array",
          items: { $ref: "#/$defs/metric" },
        },
      },
    },
    callToActionSection: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "eyebrow", "title", "body", "action"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "callToAction" },
        eyebrow: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        body: { $ref: "#/$defs/richTextDocument" },
        action: { $ref: "#/$defs/link" },
      },
    },
    richTextDocument: {
      type: "object",
      additionalProperties: false,
      required: ["version", "type", "children"],
      properties: {
        version: { const: RICH_TEXT_VERSION },
        type: { const: "document" },
        children: {
          type: "array",
          items: {
            oneOf: [
              { $ref: "#/$defs/richTextParagraph" },
              { $ref: "#/$defs/richTextHeading" },
              { $ref: "#/$defs/richTextBlockquote" },
              { $ref: "#/$defs/richTextBulletList" },
              { $ref: "#/$defs/richTextOrderedList" },
            ],
          },
        },
      },
    },
    richTextText: {
      type: "object",
      additionalProperties: false,
      required: ["type", "text", "marks"],
      properties: {
        type: { const: "text" },
        text: { type: "string", pattern: "^[^\\r\\n]*$" },
        marks: {
          type: "array",
          uniqueItems: true,
          maxItems: 3,
          items: {
            oneOf: [
              { const: "bold" },
              { const: "italic" },
              { $ref: "#/$defs/richTextLink" },
            ],
          },
          allOf: [
            {
              contains: { const: "bold" },
              minContains: 0,
              maxContains: 1,
            },
            {
              contains: { const: "italic" },
              minContains: 0,
              maxContains: 1,
            },
            {
              contains: { $ref: "#/$defs/richTextLink" },
              minContains: 0,
              maxContains: 1,
            },
          ],
        },
      },
    },
    richTextLink: {
      type: "object",
      additionalProperties: false,
      required: ["type", "href"],
      properties: {
        type: { const: "link" },
        href: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          pattern:
            "^(?:https?://[^\\s]+|mailto:[^\\s@]+@[^\\s@]+\\.[^\\s@]+|/(?!/)[^\\s]*|#[A-Za-z][A-Za-z0-9_-]*)$",
        },
      },
    },
    richTextParagraph: {
      type: "object",
      additionalProperties: false,
      required: ["type", "children"],
      properties: {
        type: { const: "paragraph" },
        children: {
          type: "array",
          items: { $ref: "#/$defs/richTextText" },
        },
      },
    },
    richTextHeading: {
      type: "object",
      additionalProperties: false,
      required: ["type", "level", "children"],
      properties: {
        type: { const: "heading" },
        level: { type: "integer", minimum: 2, maximum: 5 },
        children: {
          type: "array",
          items: { $ref: "#/$defs/richTextText" },
        },
      },
    },
    richTextBlockquote: {
      type: "object",
      additionalProperties: false,
      required: ["type", "children"],
      properties: {
        type: { const: "blockquote" },
        children: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/richTextParagraph" },
        },
      },
    },
    richTextListItem: {
      type: "object",
      additionalProperties: false,
      required: ["type", "children"],
      properties: {
        type: { const: "listItem" },
        children: {
          type: "array",
          minItems: 1,
          maxItems: 1,
          items: { $ref: "#/$defs/richTextParagraph" },
        },
      },
    },
    richTextBulletList: {
      type: "object",
      additionalProperties: false,
      required: ["type", "children"],
      properties: {
        type: { const: "bulletList" },
        children: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/richTextListItem" },
        },
      },
    },
    richTextOrderedList: {
      type: "object",
      additionalProperties: false,
      required: ["type", "children"],
      properties: {
        type: { const: "orderedList" },
        children: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/richTextListItem" },
        },
      },
    },
  },
} as const;

export const referenceSiteDefinition = {
  definitionVersion: "1.1.0",
  schemaVersion: "1.1.0",
  site: {
    id: createSiteId("site_foundry_reference"),
    name: "Foundry Reference",
    description:
      "A representative, client-neutral site powered by a versioned Foundry Site Definition.",
    navigation: [
      {
        id: "nav_work",
        label: "What we make",
        href: "#section_services",
      },
      {
        id: "nav_approach",
        label: "How it works",
        href: "#section_proof",
      },
      {
        id: "nav_contact",
        label: "Start a project",
        href: "#section_contact",
      },
    ],
    footer:
      "An executable Foundry CMS reference installation, built for client ownership.",
  },
  home: {
    id: "page_home",
    seo: {
      title: "Foundry Reference — Independent work, thoughtfully made",
      description:
        "See a representative public site rendered from Foundry CMS’s versioned Site Definition.",
    },
    sections: [
      {
        id: "section_hero",
        type: "hero",
        eyebrow: "Independent work, thoughtfully made",
        title: "Turn a good idea into something people can use.",
        summary:
          "Foundry brings structure to the fuzzy middle—shaping clear digital products, useful identities, and durable publishing systems.",
        primaryAction: {
          id: "action_start",
          label: "Start a conversation",
          href: "#section_contact",
        },
        secondaryAction: {
          id: "action_explore",
          label: "Explore the approach",
          href: "#section_proof",
        },
      },
      {
        id: "section_services",
        type: "services",
        eyebrow: "A practical studio model",
        title: "From first sketch to a working system.",
        introduction:
          "Small teams do their best work when strategy, design, and engineering stay in the same conversation.",
        items: [
          {
            id: "service_shape",
            number: "01",
            title: "Shape the opportunity",
            description:
              "Clarify the audience, the job to be done, and the smallest useful version worth making.",
          },
          {
            id: "service_design",
            number: "02",
            title: "Design the experience",
            description:
              "Create an accessible visual system with a clear hierarchy and a calm path through the work.",
          },
          {
            id: "service_build",
            number: "03",
            title: "Build for ownership",
            description:
              "Deliver maintainable software and content tools that remain useful after handoff.",
          },
        ],
      },
      {
        id: "section_proof",
        type: "proof",
        quote:
          "The best handoff is not a folder of files. It is a system the next person can understand, operate, and trust.",
        attribution: "The Foundry principle",
        metrics: [
          { id: "metric_source", value: "1", label: "Shared content source" },
          { id: "metric_schema", value: "100%", label: "Schema-bound output" },
          { id: "metric_control", value: "0", label: "Vendor control planes" },
        ],
      },
      {
        id: "section_contact",
        type: "callToAction",
        eyebrow: "Begin with the real question",
        title: "What should exist when this work is done?",
        body: {
          version: RICH_TEXT_VERSION,
          type: "document",
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: "text",
                  text: "Bring the rough notes, the constraints, and the thing that still feels unresolved. That is enough to start.",
                  marks: [],
                },
              ],
            },
          ],
        },
        action: {
          id: "action_email",
          label: "Write the first note",
          href: "mailto:hello@example.com",
        },
      },
    ],
  },
} as const satisfies SiteDefinition;

export * from "./editable-fields";

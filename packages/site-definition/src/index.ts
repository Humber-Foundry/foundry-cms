import publishedSite from "./published-site.json";

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
  body: string;
  action: SiteLink;
}>;

export type PageSection =
  | HeroSection
  | ServicesSection
  | ProofSection
  | CallToActionSection;

export type SiteDefinition = Readonly<{
  definitionVersion: "1.0.0";
  schemaVersion: "1.0.0";
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
  $id: "https://foundrycms.dev/schemas/site-definition/1.0.0",
  title: "Foundry CMS Site Definition",
  type: "object",
  additionalProperties: false,
  required: ["definitionVersion", "schemaVersion", "site", "home"],
  properties: {
    definitionVersion: { const: "1.0.0" },
    schemaVersion: { const: "1.0.0" },
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
        body: { $ref: "#/$defs/text" },
        action: { $ref: "#/$defs/link" },
      },
    },
  },
} as const;

export const referenceSiteDefinition = {
  ...publishedSite,
  site: {
    ...publishedSite.site,
    id: createSiteId(publishedSite.site.id),
  },
} as SiteDefinition;

export * from "./editable-fields";
export * from "./component-composition";

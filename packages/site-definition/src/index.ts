import type {
  CallToActionVariant,
  HeroVariant,
  ProofVariant,
  ServicesVariant,
  SiteDesign,
} from "./design-tokens";
import { designContract } from "./design-tokens";
import publishedSite from "./published-site.json";
import validateSiteDefinition from "./site-definition-validator.mjs";

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
  variant: HeroVariant;
  eyebrow: string;
  title: string;
  summary: string;
  primaryAction: SiteLink;
  secondaryAction: SiteLink;
}>;

export type ServicesSection = Readonly<{
  id: string;
  type: "services";
  variant: ServicesVariant;
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
  variant: ProofVariant;
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
  variant: CallToActionVariant;
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
  definitionVersion: "1.1.0";
  schemaVersion: "1.1.0";
  design: SiteDesign;
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

export type StoredSiteDefinitionSchemaVersion = "1.0.0" | "1.1.0";

export const siteDefinitionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://foundrycms.dev/schemas/site-definition/1.1.0",
  title: "Foundry CMS Site Definition",
  type: "object",
  additionalProperties: false,
  required: [
    "definitionVersion",
    "schemaVersion",
    "design",
    "site",
    "home",
  ],
  properties: {
    definitionVersion: { const: "1.1.0" },
    schemaVersion: { const: "1.1.0" },
    design: {
      type: "object",
      additionalProperties: false,
      required: ["typography", "colour", "spacing", "layout"],
      properties: {
        typography: {
          type: "object",
          additionalProperties: false,
          required: ["heading"],
          properties: {
            heading: {
              enum: designContract.tokens["typography.heading"].values,
            },
          },
        },
        colour: {
          type: "object",
          additionalProperties: false,
          required: ["accent"],
          properties: {
            accent: {
              enum: designContract.tokens["colour.accent"].values,
            },
          },
        },
        spacing: {
          type: "object",
          additionalProperties: false,
          required: ["section"],
          properties: {
            section: {
              enum: designContract.tokens["spacing.section"].values,
            },
          },
        },
        layout: {
          type: "object",
          additionalProperties: false,
          required: ["contentWidth"],
          properties: {
            contentWidth: {
              enum: designContract.tokens["layout.contentWidth"].values,
            },
          },
        },
      },
    },
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
        "variant",
        "eyebrow",
        "title",
        "summary",
        "primaryAction",
        "secondaryAction",
      ],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "hero" },
        variant: { enum: designContract.variants.hero.values },
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
      required: [
        "id",
        "type",
        "variant",
        "eyebrow",
        "title",
        "introduction",
        "items",
      ],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "services" },
        variant: { enum: designContract.variants.services.values },
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
      required: [
        "id",
        "type",
        "variant",
        "quote",
        "attribution",
        "metrics",
      ],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "proof" },
        variant: { enum: designContract.variants.proof.values },
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
      required: [
        "id",
        "type",
        "variant",
        "eyebrow",
        "title",
        "body",
        "action",
      ],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "callToAction" },
        variant: { enum: designContract.variants.callToAction.values },
        eyebrow: { $ref: "#/$defs/text" },
        title: { $ref: "#/$defs/text" },
        body: { $ref: "#/$defs/text" },
        action: { $ref: "#/$defs/link" },
      },
    },
  },
} as const;

export function isSiteDefinition(value: unknown): value is SiteDefinition {
  return validateSiteDefinition(value);
}

export const referenceSiteDefinition = {
  ...publishedSite,
  site: {
    ...publishedSite.site,
    id: createSiteId(publishedSite.site.id),
  },
} as SiteDefinition;

export * from "./editable-fields";
export * from "./component-composition";
export * from "./design-tokens";

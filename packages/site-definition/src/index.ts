import {
  RICH_TEXT_VERSION,
  SAFE_RICH_TEXT_LINK_PATTERN,
  validateRichTextDocument,
  type RichTextDocument,
} from "./rich-text";
import publishedSite from "./published-site.json";
import {
  projectPublishedSiteDefinition,
  projectSiteDefinitionSchema,
} from "./site-definition-projection.mjs";

export * from "./rich-text";

declare const siteIdBrand: unique symbol;

export { bindSiteMediaOccurrence } from "./media";

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

export type SiteMediaCrop = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type SiteMediaOccurrence = Readonly<{
  occurrenceId: "occurrence_home_hero" | "occurrence_home_detail";
  revision: number;
  asset: Readonly<{
    assetId: string;
    width: number;
    height: number;
    contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  }>;
  crop: SiteMediaCrop | null;
}>;

export const siteDefinitionValidationKeywords = [
  {
    keyword: "xFoundryCropWithinSource",
    schemaType: "boolean",
    type: "object",
    validate(
      enabled: boolean,
      crop: Readonly<{
        x?: unknown;
        y?: unknown;
        width?: unknown;
        height?: unknown;
      }>,
    ) {
      return (
        !enabled ||
        (typeof crop.x === "number" &&
          typeof crop.y === "number" &&
          typeof crop.width === "number" &&
          typeof crop.height === "number" &&
          crop.x + crop.width <= 1 &&
          crop.y + crop.height <= 1)
      );
    },
  },
  {
    keyword: "xFoundryCanonicalRichText",
    schemaType: "boolean",
    type: "object",
    validate(enabled: boolean, document: unknown) {
      if (!enabled) {
        return true;
      }
      try {
        validateRichTextDocument(document as RichTextDocument);
        return true;
      } catch {
        return false;
      }
    },
  },
] as const;

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
    media?: ReadonlyArray<SiteMediaOccurrence>;
    seo: Readonly<{
      title: string;
      description: string;
    }>;
    sections: ReadonlyArray<PageSection>;
  }>;
}>;

export type SiteDefinitionSchemaVersion = "1.0.0" | "1.1.0";

function isSiteDefinitionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function upgradeSiteDefinition(value: unknown): SiteDefinition {
  const upgraded = projectSiteDefinitionSchema(value);
  if (
    !isSiteDefinitionRecord(upgraded) ||
    !isSiteDefinitionRecord(upgraded.home) ||
    !Array.isArray(upgraded.home.sections)
  ) {
    throw new TypeError("site_definition_invalid");
  }
  for (const section of upgraded.home.sections) {
    if (
      isSiteDefinitionRecord(section) &&
      section.type === "callToAction"
    ) {
      validateRichTextDocument(section.body as RichTextDocument);
    }
  }
  return upgraded as SiteDefinition;
}

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
        media: {
          type: "array",
          items: { $ref: "#/$defs/mediaOccurrence" },
          allOf: [
            {
              contains: {
                type: "object",
                properties: {
                  occurrenceId: { const: "occurrence_home_hero" },
                },
                required: ["occurrenceId"],
              },
              minContains: 0,
              maxContains: 1,
            },
            {
              contains: {
                type: "object",
                properties: {
                  occurrenceId: { const: "occurrence_home_detail" },
                },
                required: ["occurrenceId"],
              },
              minContains: 0,
              maxContains: 1,
            },
          ],
        },
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
    mediaOccurrence: {
      type: "object",
      additionalProperties: false,
      required: ["occurrenceId", "revision", "asset", "crop"],
      properties: {
        occurrenceId: {
          enum: ["occurrence_home_hero", "occurrence_home_detail"],
        },
        revision: { type: "integer", minimum: 1 },
        asset: {
          type: "object",
          additionalProperties: false,
          required: ["assetId", "width", "height", "contentType"],
          properties: {
            assetId: { type: "string", pattern: "^asset_[a-z0-9_]+$" },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
            contentType: {
              enum: ["image/jpeg", "image/png", "image/webp", "image/avif"],
            },
          },
        },
        crop: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              xFoundryCropWithinSource: true,
              additionalProperties: false,
              required: ["x", "y", "width", "height"],
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 },
                width: { type: "number", exclusiveMinimum: 0, maximum: 1 },
                height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
              },
            },
          ],
        },
      },
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
      xFoundryCanonicalRichText: true,
      $comment:
        "Cross-node canonicality, including adjacent equivalent mark runs and CommonMark delimiter flanking, is enforced by validateRichTextDocument through xFoundryCanonicalRichText.",
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
        text: {
          type: "string",
          minLength: 1,
          pattern: "^[^\\u0000\\r\\n]*$",
        },
        marks: {
          type: "array",
          oneOf: [
            { maxItems: 0 },
            {
              minItems: 1,
              maxItems: 1,
              prefixItems: [{ const: "bold" }],
            },
            {
              minItems: 1,
              maxItems: 1,
              prefixItems: [{ const: "italic" }],
            },
            {
              minItems: 1,
              maxItems: 1,
              prefixItems: [{ $ref: "#/$defs/richTextLink" }],
            },
            {
              minItems: 2,
              maxItems: 2,
              prefixItems: [{ const: "bold" }, { const: "italic" }],
            },
            {
              minItems: 2,
              maxItems: 2,
              prefixItems: [
                { const: "bold" },
                { $ref: "#/$defs/richTextLink" },
              ],
            },
            {
              minItems: 2,
              maxItems: 2,
              prefixItems: [
                { const: "italic" },
                { $ref: "#/$defs/richTextLink" },
              ],
            },
            {
              minItems: 3,
              maxItems: 3,
              prefixItems: [
                { const: "bold" },
                { const: "italic" },
                { $ref: "#/$defs/richTextLink" },
              ],
            },
          ],
        },
      },
      allOf: [
        {
          if: {
            properties: {
              marks: {
                type: "array",
                contains: { enum: ["bold", "italic"] },
              },
            },
            required: ["marks"],
          },
          then: {
            properties: {
              text: {
                type: "string",
                pattern: "^\\S(?:[^\\r\\n]*\\S)?$",
              },
            },
          },
        },
      ],
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
          pattern: SAFE_RICH_TEXT_LINK_PATTERN,
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

export function createReferenceSiteDefinition(
  published: unknown,
): SiteDefinition {
  const current = upgradeSiteDefinition(
    projectPublishedSiteDefinition(published),
  );
  return {
    ...current,
    site: {
      ...current.site,
      id: createSiteId(current.site.id),
    },
  };
}

export const referenceSiteDefinition = createReferenceSiteDefinition(
  publishedSite,
);

export * from "./editable-fields";
export * from "./component-composition";

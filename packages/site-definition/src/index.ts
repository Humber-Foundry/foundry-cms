import {
  RICH_TEXT_VERSION,
  SAFE_RICH_TEXT_LINK_PATTERN,
  validateRichTextDocument,
  type RichTextDocument,
} from "./rich-text";
import type {
  CallToActionVariant,
  HeroVariant,
  ProofVariant,
  ServicesVariant,
  SiteDesign,
} from "./design-tokens";
import { designContract } from "./design-tokens";
export { designContract } from "./design-tokens";
import publishedSite from "./published-site.json";
import {
  projectPublishedSiteDefinition,
  projectSiteDefinitionSchema,
} from "./site-definition-projection.mjs";
import validateSiteDefinition from "./site-definition-validator.mjs";
import { isSiteDefinitionWithPageComponents } from "./page-component-registry";

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

declare const blogPostIdBrand: unique symbol;
export type BlogPostId = string & {
  readonly [blogPostIdBrand]: "BlogPostId";
};

export function createBlogPostId(value: string): BlogPostId {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    throw new TypeError("blog_post_id_invalid");
  }
  return value as BlogPostId;
}

/**
 * A picture used when a page, post or campaign is shared as a link.
 *
 * `url` is either a path on this site, such as `/api/media/asset_hero`, or an
 * absolute `https://` address. Relative paths become absolute at render time
 * using the site's canonical origin, because link previews and email clients
 * cannot resolve a path.
 */
export type SeoShareImage = Readonly<{
  url: string;
  alt: string;
}>;

/**
 * The owner-filled metadata that decides how one piece of content looks in
 * search results and in link previews. Every field may be left blank; the
 * renderer supplies a fallback. See `seo.ts` for the fallback rules.
 *
 * Site pages, blog posts and newsletter campaigns all use this same field set,
 * so one drafting tool can fill any of the three.
 */
export type SeoMetadata = Readonly<{
  title: string;
  description: string;
  keywords: ReadonlyArray<string>;
  shareImage: SeoShareImage | null;
}>;

export type BlogPost = Readonly<{
  id: BlogPostId;
  revision: number;
  collectionState: "active";
  targetVisibility: "public" | "unpublished";
  slug: string;
  title: string;
  excerpt: string;
  seo: SeoMetadata;
  body: RichTextDocument;
}>;

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
  body: RichTextDocument;
  action: SiteLink;
}>;

/**
 * Installation-defined components use one stable envelope so adopting a site
 * never requires adding its private component names to the foundation union.
 * The installation registry owns the schema for `props`.
 */
export type RegisteredPageSection = Readonly<{
  id: string;
  type: "registered";
  component: string;
  props: Readonly<Record<string, unknown>>;
  variant?: undefined;
}>;

export type PageSection =
  | HeroSection
  | ServicesSection
  | ProofSection
  | CallToActionSection
  | RegisteredPageSection;

export type SiteDefinition = Readonly<{
  definitionVersion: "1.5.0";
  schemaVersion: "1.5.0";
  design: SiteDesign;
  site: Readonly<{
    id: SiteId;
    name: string;
    description: string;
    /**
     * The public address this site serves from, such as
     * `https://example.com`, with no trailing slash. It is the base for every
     * canonical and share URL the public pages emit. An empty string means the
     * installation has not set it yet, and the renderer then emits no
     * canonical or share URL rather than a wrong one.
     */
    canonicalOrigin: string;
    navigation: ReadonlyArray<SiteLink>;
    footer: string;
  }>;
  home: Readonly<{
    id: string;
    media?: ReadonlyArray<SiteMediaOccurrence>;
    seo: SeoMetadata;
    sections: ReadonlyArray<PageSection>;
  }>;
  blog: Readonly<{
    id: "blog";
    posts: ReadonlyArray<BlogPost>;
  }>;
}>;

export type SiteDefinitionSchemaVersion = SiteDefinition["schemaVersion"];
export type StoredSiteDefinitionSchemaVersion =
  | "1.0.0"
  | "1.1.0"
  | "1.2.0"
  | "1.3.0"
  | "1.4.0"
  | SiteDefinitionSchemaVersion;

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
    !Array.isArray(upgraded.home.sections) ||
    !isSiteDefinitionRecord(upgraded.blog) ||
    !Array.isArray(upgraded.blog.posts)
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
  for (const post of upgraded.blog.posts) {
    if (!isSiteDefinitionRecord(post)) {
      throw new TypeError("site_definition_invalid");
    }
    validateRichTextDocument(post.body as RichTextDocument);
  }
  return upgraded as SiteDefinition;
}

export const siteDefinitionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://foundrycms.dev/schemas/site-definition/1.5.0",
  title: "Foundry CMS Site Definition",
  type: "object",
  additionalProperties: false,
  required: [
    "definitionVersion",
    "schemaVersion",
    "design",
    "site",
    "home",
    "blog",
  ],
  properties: {
    definitionVersion: { const: "1.5.0" },
    schemaVersion: { const: "1.5.0" },
    design: {
      type: "object",
      additionalProperties: false,
      required: ["typography", "colour", "spacing", "layout"],
      properties: {
        typography: {
          type: "object",
          additionalProperties: false,
          required: ["heading", "body"],
          properties: {
            heading: {
              enum: designContract.tokens["typography.heading"].values,
            },
            body: {
              enum: designContract.tokens["typography.body"].values,
            },
          },
        },
        colour: {
          type: "object",
          additionalProperties: false,
          required: ["accent", "neutral"],
          properties: {
            accent: {
              enum: designContract.tokens["colour.accent"].values,
            },
            neutral: {
              enum: designContract.tokens["colour.neutral"].values,
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
      required: [
        "id",
        "name",
        "description",
        "canonicalOrigin",
        "navigation",
        "footer",
      ],
      properties: {
        id: { $ref: "#/$defs/siteId" },
        name: { $ref: "#/$defs/text" },
        description: { $ref: "#/$defs/text" },
        canonicalOrigin: { $ref: "#/$defs/canonicalOrigin" },
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
        seo: { $ref: "#/$defs/seoMetadata" },
        sections: {
          type: "array",
          items: {
            oneOf: [
              { $ref: "#/$defs/heroSection" },
              { $ref: "#/$defs/servicesSection" },
              { $ref: "#/$defs/proofSection" },
              { $ref: "#/$defs/callToActionSection" },
              { $ref: "#/$defs/registeredPageSection" },
            ],
          },
        },
      },
    },
    blog: {
      type: "object",
      additionalProperties: false,
      required: ["id", "posts"],
      properties: {
        id: { const: "blog" },
        posts: {
          type: "array",
          items: { $ref: "#/$defs/blogPost" },
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
    canonicalOrigin: {
      type: "string",
      maxLength: 2_000,
      pattern: "^$|^https?://[^\\s/?#]+$",
    },
    seoShareImageUrl: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
      // A leading "//" is a protocol-relative address naming another host.
      // Only a single-slash path on this site, or an explicit https
      // address, is accepted.
      pattern: "^(?:/(?!/)[^\\s]*|https://[^\\s/?#]+[^\\s]*)$",
    },
    seoMetadata: {
      $comment:
        "Every field may be blank. `seo.ts` supplies the fallback used when " +
        "one is. Blank is how an owner asks for the fallback.",
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "keywords", "shareImage"],
      properties: {
        title: { type: "string", maxLength: 300 },
        description: { type: "string", maxLength: 1_000 },
        keywords: {
          type: "array",
          maxItems: 12,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 60,
            pattern: "^[^,\\s](?:[^,]*[^,\\s])?$",
          },
        },
        shareImage: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["url", "alt"],
              properties: {
                url: { $ref: "#/$defs/seoShareImageUrl" },
                alt: { type: "string", maxLength: 300 },
              },
            },
          ],
        },
      },
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
    registeredPageSection: {
      type: "object",
      additionalProperties: false,
      required: ["id", "type", "component", "props"],
      properties: {
        id: { $ref: "#/$defs/id" },
        type: { const: "registered" },
        component: {
          type: "string",
          pattern: "^[a-z][A-Za-z0-9]*$",
        },
        props: {
          type: "object",
        },
      },
    },
    blogPost: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "revision",
        "collectionState",
        "targetVisibility",
        "slug",
        "title",
        "excerpt",
        "seo",
        "body",
      ],
      properties: {
        id: {
          type: "string",
          pattern:
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        },
        revision: { type: "integer", minimum: 1 },
        collectionState: { const: "active" },
        targetVisibility: { enum: ["public", "unpublished"] },
        slug: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 120,
        },
        title: { $ref: "#/$defs/text" },
        excerpt: { $ref: "#/$defs/text" },
        seo: { $ref: "#/$defs/seoMetadata" },
        body: { $ref: "#/$defs/richTextDocument" },
      },
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
        body: { $ref: "#/$defs/richTextDocument" },
        action: { $ref: "#/$defs/link" },
      },
    },
    richTextDocument: {
      type: "object",
      additionalProperties: false,
      $comment:
        "Cross-node canonicality, including adjacent equivalent mark runs and CommonMark delimiter flanking, is enforced by validateRichTextDocument through isSiteDefinition.",
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
          pattern: "^[^\\u0000\\r\\n\\uD800-\\uDFFF]*$",
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

export function isSiteDefinition(value: unknown): value is SiteDefinition {
  return isSiteDefinitionWithPageComponents(value);
}

export function isBaseSiteDefinition(value: unknown): value is SiteDefinition {
  if (!validateSiteDefinition(value)) return false;
  try {
    const definition = value as SiteDefinition;
    definition.home.sections.forEach((section) => {
      if (section.type === "callToAction") validateRichTextDocument(section.body);
    });
    const postIds = new Set<string>();
    const postSlugs = new Set<string>();
    definition.blog.posts.forEach((post) => {
      validateRichTextDocument(post.body);
      if (postIds.has(post.id) || postSlugs.has(post.slug)) {
        throw new TypeError("blog_post_identity_duplicate");
      }
      postIds.add(post.id);
      postSlugs.add(post.slug);
    });
    return true;
  } catch {
    return false;
  }
}

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
export * from "./page-component-registry";
export * from "./design-tokens";
export * from "./design-presets";
export * from "./blog";
export * from "./blog-rendering";
export * from "./seo";

import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import { siteDefinitionValidationKeywords } from "../scripts/site-definition-validation-keywords.mjs";
import {
  homePage,
  homePageSlug,
  reservedPageSlugs,
  applySiteDefinitionEdits,
  createBlogPostId,
  createReferenceSiteDefinition,
  createRichTextDocumentFromPlainText,
  DuplicateEditableSiteFieldPathError,
  createSiteId,
  isSiteDefinition,
  listEditableSiteFields,
  serializeRichTextDocument,
  serializeSiteDefinitionRichTextForPublication,
  upgradeSiteDefinition,
  validateRichTextDocument,
  type SerializedRichTextDocument,
  type RichTextDocument,
  referenceSiteDefinition,
  siteDefinitionSchema,
  type SiteDefinition,
} from "./index";
import publishedSite from "./published-site.json";

/**
 * The same definition in the shape it was stored in before 1.7.0: one `home`
 * object instead of a `pages` collection, with no slug and no title, because
 * neither field existed then.
 *
 * A fixture that claims a schema version older than 1.7.0 must use that
 * version's shape, or it never exercises the page-collection projection step.
 *
 * The return type is `any` on purpose. No current type describes an older
 * schema shape, and every caller feeds it to a reader that takes an unknown
 * stored value.
 */
function withLegacyHomeShape(definition: SiteDefinition): any {
  const copy = structuredClone(definition);
  const { pages: _pages, ...rest } = copy as unknown as Record<string, any>;
  const { slug: _slug, title: _title, ...home } = homePage(copy);
  return { ...rest, home };
}

describe("reference Site Definition", () => {
  const ajv = new Ajv2020({ allErrors: true });
  for (const keyword of siteDefinitionValidationKeywords) {
    ajv.addKeyword(keyword);
  }
  const validate = ajv.compile(siteDefinitionSchema);

  it("declares stable product and schema versions", () => {
    expect(referenceSiteDefinition.definitionVersion).toBe("1.7.0");
    expect(referenceSiteDefinition.schemaVersion).toBe("1.7.0");
    expect(siteDefinitionSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(siteDefinitionSchema.$id).toBe(
      "https://foundrycms.dev/schemas/site-definition/1.7.0",
    );
    expect(
      siteDefinitionSchema.$defs.richTextDocument.$comment,
    ).toContain("isSiteDefinition");
  });

  it("stages the rich-text schema upgrade without rewriting published bytes", () => {
    const stored = publishedSite as unknown as Record<string, any>;
    const storedCallToAction = stored.home.sections.find(
      (section: Record<string, unknown>) =>
        section.type === "callToAction",
    );
    const runtimeCallToAction = homePage(referenceSiteDefinition).sections.find(
      (section) => section.type === "callToAction",
    );

    expect(stored.definitionVersion).toBe("1.1.0");
    expect(stored.schemaVersion).toBe("1.1.0");
    expect(typeof storedCallToAction?.body).toBe("string");
    expect(runtimeCallToAction).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          version: "1.0.0",
          type: "document",
        }),
      }),
    );
  });

  it("does not inject optional media into an already-current definition", () => {
    const current = structuredClone(referenceSiteDefinition);
    const { media: _media, ...homePageWithoutMedia } = homePage(current);

    const loaded = createReferenceSiteDefinition({
      ...current,
      pages: [homePageWithoutMedia],
    });

    expect(Object.hasOwn(homePage(loaded), "media")).toBe(false);
    expect(isSiteDefinition(loaded)).toBe(true);
  });

  it("rejects unpaired UTF-16 surrogates in the text schema without rejecting scalar pairs", () => {
    const textPattern = new RegExp(
      siteDefinitionSchema.$defs.richTextText.properties.text.pattern,
      "u",
    );

    expect(textPattern.test("\uD800")).toBe(false);
    expect(textPattern.test("\uDFFF")).toBe(false);
    expect(textPattern.test("Visible 😀 text")).toBe(true);
  });

  it("uses unique stable identifiers for every page section", () => {
    const identifiers = homePage(referenceSiteDefinition).sections.map(
      (section) => section.id,
    );

    expect(identifiers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers.every((id) => id.startsWith("section_"))).toBe(true);
  });

  it("rejects values that are not stable site identifiers", () => {
    expect(() => createSiteId("section_hero")).toThrow(TypeError);
    expect(createSiteId("site_second_example")).toBe("site_second_example");
  });

  it("validates the complete reference definition", () => {
    expect(validate(referenceSiteDefinition), validate.errors?.toString()).toBe(
      true,
    );
    expect(isSiteDefinition(referenceSiteDefinition)).toBe(true);
  });

  it("gives a stored 1.3 definition the body font and page tone it never had", () => {
    const stored = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
    stored.definitionVersion = "1.3.0";
    stored.schemaVersion = "1.3.0";
    delete stored.design.typography.body;
    delete stored.design.colour.neutral;

    const upgraded = upgradeSiteDefinition(stored);

    // The values the stylesheet already used before either token existed, so
    // an upgraded site looks exactly as it did.
    expect(upgraded.design).toEqual({
      typography: { heading: "editorial", body: "modern" },
      colour: { accent: "moss", neutral: "warm" },
      spacing: { section: "relaxed" },
      layout: { contentWidth: "standard" },
    });
    expect(isSiteDefinition(upgraded)).toBe(true);
  });

  it("keeps a stored 1.3 definition's own design values while filling the new ones", () => {
    const stored = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
    stored.definitionVersion = "1.3.0";
    stored.schemaVersion = "1.3.0";
    stored.design.typography.heading = "modern";
    stored.design.colour.accent = "clay";
    stored.design.spacing.section = "compact";
    stored.design.layout.contentWidth = "wide";
    delete stored.design.typography.body;
    delete stored.design.colour.neutral;

    expect(upgradeSiteDefinition(stored).design).toEqual({
      typography: { heading: "modern", body: "modern" },
      colour: { accent: "clay", neutral: "warm" },
      spacing: { section: "compact" },
      layout: { contentWidth: "wide" },
    });
  });

  it("gives a stored 1.0 definition with no design block the whole default design", () => {
    const stored = withLegacyHomeShape(referenceSiteDefinition);
    stored.definitionVersion = "1.0.0";
    stored.schemaVersion = "1.0.0";
    delete stored.design;
    for (const section of stored.home.sections) {
      delete section.variant;
    }

    const upgraded = upgradeSiteDefinition(stored);

    expect(upgraded.design).toEqual({
      typography: { heading: "editorial", body: "modern" },
      colour: { accent: "moss", neutral: "warm" },
      spacing: { section: "relaxed" },
      layout: { contentWidth: "standard" },
    });
    expect(isSiteDefinition(upgraded)).toBe(true);
  });

  it("projects a preserved 1.0 definition into the current rich-text schema", () => {
    const legacy = withLegacyHomeShape(referenceSiteDefinition);
    legacy.definitionVersion = "1.0.0";
    legacy.schemaVersion = "1.0.0";
    legacy.home.sections[3].body =
      "Preserve this legacy draft.\nAcross paragraphs.";

    const upgraded = upgradeSiteDefinition(legacy);
    const callToAction = homePage(upgraded).sections.find(
      (section) => section.type === "callToAction",
    )!;

    expect(upgraded).not.toBe(legacy);
    expect(upgraded.definitionVersion).toBe("1.7.0");
    expect(upgraded.schemaVersion).toBe("1.7.0");
    expect(callToAction).toEqual(
      expect.objectContaining({
        body: {
          version: "1.0.0",
          type: "document",
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: "text",
                  text: "Preserve this legacy draft.",
                  marks: [],
                },
              ],
            },
            {
              type: "paragraph",
              children: [
                {
                  type: "text",
                  text: "Across paragraphs.",
                  marks: [],
                },
              ],
            },
          ],
        },
      }),
    );
    expect(validate(upgraded), validate.errors?.toString()).toBe(true);
  });

  it.each([
    {
      name: "an empty text run",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].text = "";
      },
    },
    {
      name: "a link containing a backslash",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].marks = [
          { type: "link", href: "https://example.com/a\\b" },
        ];
      },
    },
    {
      name: "a link containing a control character",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].marks = [
          { type: "link", href: "https://example.com/a\u0007b" },
        ];
      },
    },
    {
      name: "non-canonical mark ordering",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].marks = ["italic", "bold"];
      },
    },
    {
      name: "marked edge whitespace",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].text = " marked";
        document.children[0].children[0].marks = ["bold"];
      },
    },
    {
      name: "a NUL text character",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].text = "before\u0000after";
      },
    },
    {
      name: "an unpaired UTF-16 surrogate",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].text = "before\uD800after";
      },
    },
    {
      name: "an unpaired UTF-16 surrogate in a link",
      mutate(document: Record<string, any>) {
        document.children[0].children[0].marks = [
          { type: "link", href: "https://example.com/\uD800" },
        ];
      },
    },
    {
      name: "non-flanking emphasis across inline nodes",
      mutate(document: Record<string, any>) {
        document.children[0].children = [
          { type: "text", text: "a", marks: [] },
          { type: "text", text: "!marked", marks: ["bold"] },
        ];
      },
    },
    {
      name: "a three-node joined emphasis delimiter run",
      mutate(document: Record<string, any>) {
        document.children[0].children = [
          { type: "text", text: "a", marks: ["bold"] },
          { type: "text", text: "b", marks: ["bold", "italic"] },
          { type: "text", text: "c", marks: ["italic"] },
        ];
      },
    },
    ...["https://?", "https://#", "http://[::1"].map((href) => ({
      name: `a malformed absolute link (${href})`,
      mutate(document: Record<string, any>) {
        document.children[0].children[0].marks = [
          { type: "link", href },
        ];
      },
    })),
  ])(
    "keeps JSON Schema and runtime rich-text rejection aligned for $name",
    ({ mutate }) => {
      const malformed = structuredClone(
        referenceSiteDefinition,
      ) as unknown as Record<string, any>;
      const document = malformed.pages[0].sections[3].body;
      mutate(document);

      expect(isSiteDefinition(malformed)).toBe(false);
      expect(() =>
        validateRichTextDocument(document as RichTextDocument),
      ).toThrow();
    },
  );

  it("preserves the Git-published media manifest at runtime", () => {
    const published = {
      ...structuredClone(referenceSiteDefinition),
      pages: [
        {
          ...structuredClone(homePage(referenceSiteDefinition)),
          media: [
            {
              occurrenceId: "occurrence_home_hero",
              revision: 4,
              asset: {
                assetId: "asset_published",
                width: 1200,
                height: 800,
                contentType: "image/png",
              },
              crop: null,
            },
          ],
        },
      ],
    } satisfies SiteDefinition;

    expect(homePage(createReferenceSiteDefinition(published)).media).toEqual(
      homePage(published).media,
    );
  });

  it("keeps media optional for definitions saved before media manifests", () => {
    const legacy = structuredClone(referenceSiteDefinition) as unknown as Record<
      string,
      any
    >;
    delete legacy.pages[0].media;
    expect(validate(legacy), validate.errors?.toString()).toBe(true);
  });

  it.each([
    {
      name: "a non-string site identifier",
      change: (definition: Record<string, any>) => {
        definition.site.id = 42;
      },
    },
    {
      name: "a non-array sections value",
      change: (definition: Record<string, any>) => {
        definition.pages[0].sections = "hero";
      },
    },
    {
      name: "an unknown nested property",
      change: (definition: Record<string, any>) => {
        definition.pages[0].seo.injected = true;
      },
    },
    {
      name: "fields from the wrong section variant",
      change: (definition: Record<string, any>) => {
        definition.pages[0].sections[0].metrics = [];
      },
    },
    {
      name: "an executable link target",
      change: (definition: Record<string, any>) => {
        definition.site.navigation[0].href = "data:text/html,<script></script>";
      },
    },
    {
      name: "an arbitrary off-site link target",
      change: (definition: Record<string, any>) => {
        definition.site.navigation[0].href = "https://example.com";
      },
    },
    {
      name: "an unknown design token",
      change: (definition: Record<string, any>) => {
        definition.design.colour.custom = "red";
      },
    },
    {
      name: "an executable design value",
      change: (definition: Record<string, any>) => {
        definition.design.colour.accent = "url(javascript:alert(1))";
      },
    },
    {
      name: "a variant registered for a different component",
      change: (definition: Record<string, any>) => {
        definition.pages[0].sections[0].variant = "cards";
      },
    },
    {
      name: "a crop that extends beyond the source",
      change: (definition: Record<string, any>) => {
        definition.pages[0].media = [{
          occurrenceId: "occurrence_home_hero",
          revision: 1,
          asset: {
            assetId: "asset_hero",
            width: 1600,
            height: 900,
            contentType: "image/png",
          },
          crop: { x: 0.8, y: 0, width: 0.5, height: 1 },
        }];
      },
    },
    {
      name: "duplicate media occurrence identities",
      change: (definition: Record<string, any>) => {
        const occurrence = {
          occurrenceId: "occurrence_home_hero",
          revision: 1,
          asset: {
            assetId: "asset_hero",
            width: 1600,
            height: 900,
            contentType: "image/png",
          },
          crop: null,
        };
        definition.pages[0].media = [
          occurrence,
          {
            ...occurrence,
            asset: { ...occurrence.asset, assetId: "asset_other" },
          },
        ];
      },
    },
    {
      // "//host/x" is a protocol-relative address for another host. It looks
      // like a path on this site but is not one, so it must not pass as one.
      name: "a protocol-relative share image address",
      change: (definition: Record<string, any>) => {
        definition.pages[0].seo.shareImage = {
          url: "//attacker.example/card.png",
          alt: "",
        };
      },
    },
    {
      name: "an insecure share image address",
      change: (definition: Record<string, any>) => {
        definition.pages[0].seo.shareImage = {
          url: "http://attacker.example/card.png",
          alt: "",
        };
      },
    },
    {
      name: "an executable share image address",
      change: (definition: Record<string, any>) => {
        definition.pages[0].seo.shareImage = {
          url: "javascript:alert(1)",
          alt: "",
        };
      },
    },
    {
      name: "more keywords than an owner may set",
      change: (definition: Record<string, any>) => {
        definition.pages[0].seo.keywords = Array.from(
          { length: 13 },
          (_unused, index) => `keyword-${index}`,
        );
      },
    },
  ])("rejects $name", ({ change }) => {
    const malformed = structuredClone(referenceSiteDefinition) as unknown as Record<
      string,
      any
    >;
    change(malformed);

    expect(validate(malformed)).toBe(false);
    expect(isSiteDefinition(malformed)).toBe(false);
  });

  it("exposes editable copy through stable item identifiers", () => {
    const fields = listEditableSiteFields(referenceSiteDefinition);

    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "page_home.seo.title",
          value: homePage(referenceSiteDefinition).seo.title,
        }),
        expect.objectContaining({
          path: "nav_work.label",
          value: "What we make",
        }),
        expect.objectContaining({
          path: "section_hero.title",
          value: "Turn a good idea into something people can use.",
        }),
        expect.objectContaining({
          path: "site_foundry_reference.footer",
          value:
            "An executable Foundry CMS reference installation, built for client ownership.",
        }),
        // A navigation item's link is editable through the page picker
        // (#155), alongside its label. See ADR-0022.
        expect.objectContaining({
          path: "nav_work.href",
          value: "#section_services",
        }),
      ]),
    );
    expect(fields.some((field) => field.path.endsWith(".id"))).toBe(false);
  });

  it("labels each Page field with the section card it belongs to", () => {
    const fields = listEditableSiteFields(referenceSiteDefinition);
    const sectionOf = (path: string) =>
      fields.find((field) => field.path === path)?.section;

    // Site-wide settings and each content section carry their own card name,
    // so the editor splits the long Page list into short cards by area.
    expect(sectionOf("site_foundry_reference.name")).toBe("Site settings");
    expect(sectionOf("site_foundry_reference.description")).toBe(
      "Site settings",
    );
    expect(sectionOf("section_hero.title")).toBe("Hero");

    // Fields the owner reaches through their own destination card need no
    // finer section, so Navigation, Footer and SEO stay one card each.
    expect(sectionOf("nav_work.label")).toBeUndefined();
    expect(sectionOf("site_foundry_reference.footer")).toBeUndefined();
    expect(sectionOf("page_home.seo.title")).toBeUndefined();
  });

  it("applies copy edits without changing the source definition", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      {
        path: "section_hero.title",
        value: "A new immutable headline",
      },
      {
        path: "nav_work.label",
        value: "Our work",
      },
    ]);

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        site: expect.objectContaining({
          navigation: expect.arrayContaining([
            expect.objectContaining({ id: "nav_work", label: "Our work" }),
          ]),
        }),
        pages: [expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({
              id: "section_hero",
              title: "A new immutable headline",
            }),
          ]),
        })],
      }),
    });
    expect(homePage(referenceSiteDefinition).sections[0]).toEqual(
      expect.objectContaining({
        title: "Turn a good idea into something people can use.",
      }),
    );
  });

  it("rejects a duplicate post slug through the generic field editor", () => {
    const firstPostId = createBlogPostId(
      "00000000-0000-4000-8000-000000000005",
    );
    const secondPostId = createBlogPostId(
      "00000000-0000-4000-8000-000000000006",
    );
    const definition: SiteDefinition = {
      ...referenceSiteDefinition,
      blog: {
        ...referenceSiteDefinition.blog,
        posts: [
          {
            id: firstPostId,
            revision: 1,
            collectionState: "active",
            targetVisibility: "public",
            slug: "first",
            title: "First",
            excerpt: "First excerpt",
            seo: { title: "First", description: "First excerpt",
              keywords: [],
              shareImage: null,
            },
            mainImage: null,
            body: createRichTextDocumentFromPlainText("First body"),
          },
          {
            id: secondPostId,
            revision: 1,
            collectionState: "active",
            targetVisibility: "public",
            slug: "second",
            title: "Second",
            excerpt: "Second excerpt",
            seo: { title: "Second", description: "Second excerpt",
              keywords: [],
              shareImage: null,
            },
            mainImage: null,
            body: createRichTextDocumentFromPlainText("Second body"),
          },
        ],
      },
    };

    expect(
      applySiteDefinitionEdits(definition, [
        { path: `${secondPostId}.slug`, value: "first" },
      ]),
    ).toEqual({
      ok: false,
      errors: {
        [`${firstPostId}.slug`]:
          "Choose a URL slug that is unique within this site.",
        [`${secondPostId}.slug`]:
          "Choose a URL slug that is unique within this site.",
      },
    });
    expect(
      applySiteDefinitionEdits(definition, [
        { path: `${secondPostId}.slug`, value: "Not Valid" },
      ]),
    ).toEqual({
      ok: false,
      errors: {
        [`${secondPostId}.slug`]:
          "Use at most 120 lowercase letters, numbers, and single hyphens.",
      },
    });
  });

  it("stores rich-text edits as the canonical versioned AST", () => {
    const body = {
      version: "1.0.0",
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", text: "A ", marks: [] },
            { type: "text", text: "clear next step", marks: ["bold"] },
          ],
        },
      ],
    } as const satisfies RichTextDocument;
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      {
        path: "section_contact.body",
        format: "richText",
        value: serializeRichTextDocument(body),
      },
    ]);

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        pages: [expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({
              id: "section_contact",
              body,
            }),
          ]),
        })],
      }),
    });
    expect(
      listEditableSiteFields(referenceSiteDefinition).find(
        (field) => field.path === "section_contact.body",
      ),
    ).toMatchObject({
      format: "richText",
      value: serializeRichTextDocument(
        homePage(referenceSiteDefinition).sections.find(
          (section) => section.type === "callToAction",
        )!.body,
      ),
    });
  });

  it("returns field feedback for unsafe canonical rich text", () => {
    expect(
      applySiteDefinitionEdits(referenceSiteDefinition, [
        {
          path: "section_contact.body",
          format: "richText",
          value: JSON.stringify({
            version: "1.0.0",
            type: "document",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "text",
                    text: "Run this",
                    marks: [{ type: "link", href: "javascript:alert(1)" }],
                  },
                ],
              },
            ],
          }) as SerializedRichTextDocument,
        },
      ]),
    ).toEqual({
      ok: false,
      errors: {
        "section_contact.body":
          "Rich text is invalid or contains unsupported or unsafe content.",
      },
    });
  });

  it.each([
    [
      "an empty document",
      {
        version: "1.0.0",
        type: "document",
        children: [],
      },
    ],
    [
      "an empty paragraph",
      {
        version: "1.0.0",
        type: "document",
        children: [{ type: "paragraph", children: [] }],
      },
    ],
    [
      "whitespace-only text",
      {
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text: " \t ", marks: [] }],
          },
        ],
      },
    ],
    [
      "zero-width format text",
      {
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text: "\u200B", marks: [] }],
          },
        ],
      },
    ],
    ...[
      ["variation selector", "\uFE0F"],
      ["combining grapheme joiner", "\u034F"],
    ].map(
      ([name, text]) =>
        [
          name,
          {
            version: "1.0.0",
            type: "document",
            children: [
              {
                type: "paragraph",
                children: [{ type: "text", text, marks: [] }],
              },
            ],
          },
        ] as const,
    ),
  ] satisfies ReadonlyArray<readonly [string, RichTextDocument]>)(
    "requires visible text instead of nonempty serialized JSON for $name",
    (_name, body) => {
      expect(
        applySiteDefinitionEdits(referenceSiteDefinition, [
          {
            path: "section_contact.body",
            format: "richText",
            value: serializeRichTextDocument(body),
          },
        ]),
      ).toEqual({
        ok: false,
        errors: {
          "section_contact.body": "Enter at least one visible character.",
        },
      });
    },
  );

  it("creates deterministic Markdown publication artifacts for rich text", () => {
    expect(
      serializeSiteDefinitionRichTextForPublication(referenceSiteDefinition),
    ).toEqual([
      {
        fieldPath: "section_contact.body",
        filePath: "content/rich-text/section_contact/body.md",
        markdown:
          "Bring the rough notes, the constraints, and the thing that still feels unresolved\\. That is enough to start\\.\n",
      },
    ]);
  });

  it("returns field-level feedback for unknown and invalid edits", () => {
    expect(
      applySiteDefinitionEdits(referenceSiteDefinition, [
        { path: "section_missing.title", value: "Unknown" },
        { path: "section_hero.title", value: "   " },
        { path: "section_hero.href", value: "https://example.com" },
      ]),
    ).toEqual({
      ok: false,
      errors: {
        "section_missing.title": "This field is not in Site Definition 1.7.0.",
        "section_hero.title": "Enter at least one visible character.",
        "section_hero.href": "This field is not in Site Definition 1.7.0.",
      },
    });
  });

  it("returns validation feedback for prototype-named field paths", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path: "__proto__", value: "Unknown" },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual(["__proto__"]);
      expect(result.errors["__proto__"]).toBe(
        "This field is not in Site Definition 1.7.0.",
      );
    }
  });

  it("rejects duplicate generated editable paths", () => {
    const duplicate = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
    duplicate.pages[0].sections[1].id = duplicate.pages[0].sections[0].id;

    expect(() =>
      listEditableSiteFields(duplicate as SiteDefinition),
    ).toThrow(DuplicateEditableSiteFieldPathError);
  });
});

describe("the page collection", () => {
  const validate = new Ajv2020({ allErrors: true });
  for (const keyword of siteDefinitionValidationKeywords) {
    validate.addKeyword(keyword);
  }
  const validateDefinition = validate.compile(siteDefinitionSchema);

  function withPages(
    pages: ReadonlyArray<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      ...(structuredClone(referenceSiteDefinition) as Record<string, unknown>),
      pages,
    };
  }

  function secondPage(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const home = structuredClone(homePage(referenceSiteDefinition)) as Record<
      string,
      unknown
    >;
    return {
      ...home,
      id: "page_about",
      slug: "about",
      title: "About us",
      sections: [],
      ...overrides,
    };
  }

  it("accepts a definition with more than one page", () => {
    const definition = withPages([
      structuredClone(homePage(referenceSiteDefinition)),
      secondPage(),
    ]);

    expect(
      validateDefinition(definition),
      validateDefinition.errors?.toString(),
    ).toBe(true);
    expect(isSiteDefinition(definition)).toBe(true);
  });

  it("accepts a media occurrence built from its own page's id", () => {
    const definition = withPages([
      structuredClone(homePage(referenceSiteDefinition)),
      secondPage({
        media: [
          {
            occurrenceId: "occurrence_page_about_detail",
            revision: 1,
            asset: {
              assetId: "asset_about_detail",
              width: 800,
              height: 600,
              contentType: "image/jpeg",
            },
            crop: null,
          },
        ],
      }),
    ]);

    expect(
      validateDefinition(definition),
      validateDefinition.errors?.toString(),
    ).toBe(true);
    expect(isSiteDefinition(definition)).toBe(true);
  });

  it("rejects a media occurrence built for a different page", () => {
    // Passes the loosened JSON Schema pattern (it ends in "_detail"), but
    // names the home page, not "page_about". isBaseSiteDefinition is the
    // only check that can compare an occurrence id to the id of the page
    // that holds it. See ADR-0026.
    const definition = withPages([
      structuredClone(homePage(referenceSiteDefinition)),
      secondPage({
        media: [
          {
            occurrenceId: "occurrence_home_detail",
            revision: 1,
            asset: {
              assetId: "asset_about_detail",
              width: 800,
              height: 600,
              contentType: "image/jpeg",
            },
            crop: null,
          },
        ],
      }),
    ]);

    expect(
      validateDefinition(definition),
      validateDefinition.errors?.toString(),
    ).toBe(true);
    expect(isSiteDefinition(definition)).toBe(false);
  });

  it("rejects an occurrence id with no page-id segment", () => {
    const definition = withPages([
      structuredClone(homePage(referenceSiteDefinition)),
      secondPage({
        media: [
          {
            occurrenceId: "occurrence_detail",
            revision: 1,
            asset: {
              assetId: "asset_about_detail",
              width: 800,
              height: 600,
              contentType: "image/jpeg",
            },
            crop: null,
          },
        ],
      }),
    ]);

    expect(validateDefinition(definition)).toBe(false);
    expect(isSiteDefinition(definition)).toBe(false);
  });

  it("rejects a duplicate page id and a duplicate page slug", () => {
    const home = structuredClone(homePage(referenceSiteDefinition));
    const duplicateId = withPages([home, secondPage({ id: home.id })]);
    const duplicateSlug = withPages([
      home,
      secondPage(),
      secondPage({ id: "page_team" }),
    ]);

    // The JSON Schema cannot compare one property across array items, so the
    // duplicate check lives in isSiteDefinition.
    expect(isSiteDefinition(duplicateId)).toBe(false);
    expect(isSiteDefinition(duplicateSlug)).toBe(false);
  });

  it("rejects a reserved slug", () => {
    for (const slug of reservedPageSlugs) {
      const definition = withPages([
        structuredClone(homePage(referenceSiteDefinition)),
        secondPage({ slug }),
      ]);
      expect(validateDefinition(definition), slug).toBe(false);
      expect(isSiteDefinition(definition), slug).toBe(false);
    }
  });

  it.each([
    "About",
    "about us",
    "about--us",
    "-about",
    "about/team",
    "about?x=1",
    "a".repeat(121),
  ])("rejects the invalid slug %s", (slug) => {
    const definition = withPages([
      structuredClone(homePage(referenceSiteDefinition)),
      secondPage({ slug }),
    ]);

    expect(validateDefinition(definition)).toBe(false);
    expect(isSiteDefinition(definition)).toBe(false);
  });

  it("requires exactly one page with the root slug", () => {
    const home = structuredClone(homePage(referenceSiteDefinition));
    expect(validateDefinition(withPages([secondPage()]))).toBe(false);
    expect(
      validateDefinition(
        withPages([home, secondPage({ id: "page_second_home", slug: "" })]),
      ),
    ).toBe(false);
    expect(validateDefinition(withPages([]))).toBe(false);
  });

  it("requires a page title", () => {
    const definition = withPages([
      structuredClone(homePage(referenceSiteDefinition)),
      secondPage({ title: "" }),
    ]);

    expect(validateDefinition(definition)).toBe(false);
  });
});

describe("the 1.6.0 to 1.7.0 projection", () => {
  function storedAt160(): Record<string, any> {
    const stored = withLegacyHomeShape(referenceSiteDefinition);
    stored.definitionVersion = "1.6.0";
    stored.schemaVersion = "1.6.0";
    return stored;
  }

  it("upgrades one home object into exactly one page", () => {
    const stored = storedAt160();

    const upgraded = upgradeSiteDefinition(stored);

    expect(upgraded.definitionVersion).toBe("1.7.0");
    expect(upgraded.schemaVersion).toBe("1.7.0");
    expect(upgraded.pages).toHaveLength(1);
    expect(Object.hasOwn(upgraded, "home")).toBe(false);
    expect(isSiteDefinition(upgraded)).toBe(true);
  });

  it("keeps the upgraded page content byte for byte", () => {
    const stored = storedAt160();
    // A 1.6.0 home object carries media, so the fixture must too, or the test
    // would not notice the projection dropping it.
    stored.home.media = [
      {
        occurrenceId: "occurrence_home_hero",
        revision: 1,
        asset: {
          assetId: "asset_home_hero",
          width: 1200,
          height: 630,
          contentType: "image/jpeg",
        },
        crop: null,
      },
    ];
    const storedHome = structuredClone(stored.home);

    const page = homePage(upgradeSiteDefinition(stored));

    expect(page.slug).toBe(homePageSlug);
    // Everything the 1.6.0 home object held survives, and nothing else is
    // added: the page is the old home object plus a slug and a title. Key
    // order is not compared, because every stored digest sorts keys first.
    const { slug: _slug, title: _title, ...carried } = page;
    expect(carried).toStrictEqual(storedHome);
  });

  it("changes nothing outside the page collection", () => {
    const stored = storedAt160();
    const { home: _home, ...outsideThePages } = structuredClone(stored);

    const upgraded = upgradeSiteDefinition(stored) as unknown as Record<
      string,
      unknown
    >;
    const { pages: _pages, ...upgradedOutsideThePages } = upgraded;

    expect(upgradedOutsideThePages).toStrictEqual({
      ...outsideThePages,
      definitionVersion: "1.7.0",
      schemaVersion: "1.7.0",
    });
  });

  it("titles the upgraded page with the site name", () => {
    const stored = storedAt160();

    expect(homePage(upgradeSiteDefinition(stored)).title).toBe(
      stored.site.name,
    );
  });

  it("leaves a definition already stored at 1.7.0 untouched", () => {
    const stored = structuredClone(referenceSiteDefinition);

    expect(upgradeSiteDefinition(stored)).toBe(stored);
  });

  it("refuses a schema version it has no projection for", () => {
    const stored = storedAt160();
    stored.definitionVersion = "1.8.0";
    stored.schemaVersion = "1.8.0";

    expect(() => upgradeSiteDefinition(stored)).toThrow(
      "site_definition_version_unsupported",
    );
  });
});

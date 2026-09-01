import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import { siteDefinitionValidationKeywords } from "../scripts/site-definition-validation-keywords.mjs";
import {
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

describe("reference Site Definition", () => {
  const ajv = new Ajv2020({ allErrors: true });
  for (const keyword of siteDefinitionValidationKeywords) {
    ajv.addKeyword(keyword);
  }
  const validate = ajv.compile(siteDefinitionSchema);

  it("declares stable product and schema versions", () => {
    expect(referenceSiteDefinition.definitionVersion).toBe("1.6.0");
    expect(referenceSiteDefinition.schemaVersion).toBe("1.6.0");
    expect(siteDefinitionSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(siteDefinitionSchema.$id).toBe(
      "https://foundrycms.dev/schemas/site-definition/1.6.0",
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
    const runtimeCallToAction = referenceSiteDefinition.home.sections.find(
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
    const { media: _media, ...homeWithoutMedia } = current.home;

    const loaded = createReferenceSiteDefinition({
      ...current,
      home: homeWithoutMedia,
    });

    expect(Object.hasOwn(loaded.home, "media")).toBe(false);
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
    const identifiers = referenceSiteDefinition.home.sections.map(
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
    const stored = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
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
    const legacy = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
    legacy.definitionVersion = "1.0.0";
    legacy.schemaVersion = "1.0.0";
    legacy.home.sections[3].body =
      "Preserve this legacy draft.\nAcross paragraphs.";

    const upgraded = upgradeSiteDefinition(legacy);
    const callToAction = upgraded.home.sections.find(
      (section) => section.type === "callToAction",
    )!;

    expect(upgraded).not.toBe(legacy);
    expect(upgraded.definitionVersion).toBe("1.6.0");
    expect(upgraded.schemaVersion).toBe("1.6.0");
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
      const document = malformed.home.sections[3].body;
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
      home: {
        ...structuredClone(referenceSiteDefinition.home),
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
    } satisfies SiteDefinition;

    expect(createReferenceSiteDefinition(published).home.media).toEqual(
      published.home.media,
    );
  });

  it("keeps media optional for definitions saved before media manifests", () => {
    const legacy = structuredClone(referenceSiteDefinition) as unknown as Record<
      string,
      any
    >;
    delete legacy.home.media;
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
        definition.home.sections = "hero";
      },
    },
    {
      name: "an unknown nested property",
      change: (definition: Record<string, any>) => {
        definition.home.seo.injected = true;
      },
    },
    {
      name: "fields from the wrong section variant",
      change: (definition: Record<string, any>) => {
        definition.home.sections[0].metrics = [];
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
        definition.home.sections[0].variant = "cards";
      },
    },
    {
      name: "a crop that extends beyond the source",
      change: (definition: Record<string, any>) => {
        definition.home.media = [{
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
        definition.home.media = [
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
        definition.home.seo.shareImage = {
          url: "//attacker.example/card.png",
          alt: "",
        };
      },
    },
    {
      name: "an insecure share image address",
      change: (definition: Record<string, any>) => {
        definition.home.seo.shareImage = {
          url: "http://attacker.example/card.png",
          alt: "",
        };
      },
    },
    {
      name: "an executable share image address",
      change: (definition: Record<string, any>) => {
        definition.home.seo.shareImage = {
          url: "javascript:alert(1)",
          alt: "",
        };
      },
    },
    {
      name: "more keywords than an owner may set",
      change: (definition: Record<string, any>) => {
        definition.home.seo.keywords = Array.from(
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
          value: referenceSiteDefinition.home.seo.title,
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
      ]),
    );
    expect(fields.some((field) => field.path.endsWith(".id"))).toBe(false);
    expect(fields.some((field) => field.path.endsWith(".href"))).toBe(false);
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
        home: expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({
              id: "section_hero",
              title: "A new immutable headline",
            }),
          ]),
        }),
      }),
    });
    expect(referenceSiteDefinition.home.sections[0]).toEqual(
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
        home: expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({
              id: "section_contact",
              body,
            }),
          ]),
        }),
      }),
    });
    expect(
      listEditableSiteFields(referenceSiteDefinition).find(
        (field) => field.path === "section_contact.body",
      ),
    ).toMatchObject({
      format: "richText",
      value: serializeRichTextDocument(
        referenceSiteDefinition.home.sections.find(
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
        "section_missing.title": "This field is not in Site Definition 1.6.0.",
        "section_hero.title": "Enter at least one visible character.",
        "section_hero.href": "This field is not in Site Definition 1.6.0.",
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
        "This field is not in Site Definition 1.6.0.",
      );
    }
  });

  it("rejects duplicate generated editable paths", () => {
    const duplicate = structuredClone(
      referenceSiteDefinition,
    ) as unknown as Record<string, any>;
    duplicate.home.sections[1].id = duplicate.home.sections[0].id;

    expect(() =>
      listEditableSiteFields(duplicate as SiteDefinition),
    ).toThrow(DuplicateEditableSiteFieldPathError);
  });
});

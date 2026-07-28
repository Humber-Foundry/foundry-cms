import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import {
  applySiteDefinitionEdits,
  createReferenceSiteDefinition,
  DuplicateEditableSiteFieldPathError,
  createSiteId,
  listEditableSiteFields,
  serializeRichTextDocument,
  serializeSiteDefinitionRichTextForPublication,
  upgradeSiteDefinition,
  validateRichTextDocument,
  type SerializedRichTextDocument,
  type RichTextDocument,
  referenceSiteDefinition,
  siteDefinitionSchema,
  siteDefinitionValidationKeywords,
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
    expect(referenceSiteDefinition.definitionVersion).toBe("1.1.0");
    expect(referenceSiteDefinition.schemaVersion).toBe("1.1.0");
    expect(siteDefinitionSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(siteDefinitionSchema.$id).toBe(
      "https://foundrycms.dev/schemas/site-definition/1.1.0",
    );
    expect(
      siteDefinitionSchema.$defs.richTextDocument.$comment,
    ).toContain("validateRichTextDocument");
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

    expect(stored.definitionVersion).toBe("1.0.0");
    expect(stored.schemaVersion).toBe("1.0.0");
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
    expect(upgraded.definitionVersion).toBe("1.1.0");
    expect(upgraded.schemaVersion).toBe("1.1.0");
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

      expect(validate(malformed)).toBe(false);
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

  it("continues to validate saved 1.0 definitions created before media manifests", () => {
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
  ])("rejects $name", ({ change }) => {
    const malformed = structuredClone(referenceSiteDefinition) as unknown as Record<
      string,
      any
    >;
    change(malformed);

    expect(validate(malformed)).toBe(false);
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
        "section_missing.title": "This field is not in Site Definition 1.1.0.",
        "section_hero.title": "Enter at least one visible character.",
        "section_hero.href": "This field is not in Site Definition 1.1.0.",
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
        "This field is not in Site Definition 1.1.0.",
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

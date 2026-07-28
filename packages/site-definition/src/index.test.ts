import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import {
  applySiteDefinitionEdits,
  createReferenceSiteDefinition,
  DuplicateEditableSiteFieldPathError,
  createSiteId,
  isSiteDefinition,
  listEditableSiteFields,
  referenceSiteDefinition,
  siteDefinitionSchema,
  siteDefinitionValidationKeywords,
  type SiteDefinition,
} from "./index";

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

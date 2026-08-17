import { describe, expect, it } from "vitest";

import {
  applySiteDefinitionEdits,
  designContract,
  listEditableSiteFields,
  referenceSiteDefinition,
  updateEditableSiteField,
} from "./index";

describe("controlled design tokens", () => {
  it("registers exposed typography, colour, spacing, layout, and component variants", () => {
    expect(designContract.tokens).toEqual({
      "typography.heading": expect.objectContaining({
        values: ["editorial", "modern", "system", "technical"],
      }),
      "typography.body": expect.objectContaining({
        values: ["modern", "editorial", "system"],
      }),
      "colour.accent": expect.objectContaining({
        values: ["moss", "clay", "harbour", "indigo", "plum", "graphite"],
      }),
      "colour.neutral": expect.objectContaining({
        values: ["warm", "cool", "bright"],
      }),
      "spacing.section": expect.objectContaining({
        values: ["airy", "relaxed", "compact"],
      }),
      "layout.contentWidth": expect.objectContaining({
        values: ["narrow", "standard", "wide"],
      }),
    });
    expect(designContract.variants).toEqual({
      hero: expect.objectContaining({ values: ["editorial", "focused"] }),
      services: expect.objectContaining({ values: ["list", "cards"] }),
      proof: expect.objectContaining({ values: ["panel", "plain"] }),
      callToAction: expect.objectContaining({ values: ["moss", "ink"] }),
    });
  });

  it("exposes only registered values through stable design field paths", () => {
    const fields = listEditableSiteFields(referenceSiteDefinition);

    expect(fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "design.typography.heading",
          group: "Design",
          value: "editorial",
          values: ["editorial", "modern", "system", "technical"],
        }),
        expect.objectContaining({
          path: "design.typography.body",
          group: "Design",
          value: "modern",
          values: ["modern", "editorial", "system"],
        }),
        expect.objectContaining({
          path: "design.colour.accent",
          group: "Design",
          value: "moss",
          values: ["moss", "clay", "harbour", "indigo", "plum", "graphite"],
        }),
        expect.objectContaining({
          path: "design.colour.neutral",
          group: "Design",
          value: "warm",
          values: ["warm", "cool", "bright"],
        }),
        expect.objectContaining({
          path: "section_hero.variant",
          group: "Design",
          value: "editorial",
          values: ["editorial", "focused"],
        }),
      ]),
    );
  });

  it("applies registered token and component-variant changes immutably", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path: "design.typography.heading", value: "modern" },
      { path: "design.typography.body", value: "editorial" },
      { path: "design.colour.accent", value: "clay" },
      { path: "design.colour.neutral", value: "bright" },
      { path: "design.spacing.section", value: "compact" },
      { path: "design.layout.contentWidth", value: "wide" },
      { path: "section_hero.variant", value: "focused" },
    ]);

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        design: {
          typography: { heading: "modern", body: "editorial" },
          colour: { accent: "clay", neutral: "bright" },
          spacing: { section: "compact" },
          layout: { contentWidth: "wide" },
        },
        home: expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({
              id: "section_hero",
              type: "hero",
              variant: "focused",
            }),
          ]),
        }),
      }),
    });
    expect(referenceSiteDefinition.design.typography.heading).toBe(
      "editorial",
    );
    expect(referenceSiteDefinition.home.sections[0].variant).toBe(
      "editorial",
    );
  });

  it.each([
    ["unknown token", "design.typography.caption", "modern"],
    ["unknown value", "design.typography.heading", "url(https://bad.example)"],
    ["raw CSS", "design.colour.accent", "color:red"],
    ["unknown class", "section_hero.variant", "hero--attacker"],
    ["wrong component relationship", "section_hero.variant", "cards"],
  ])("fails closed for %s", (_name, path, value) => {
    expect(
      applySiteDefinitionEdits(referenceSiteDefinition, [{ path, value }]),
    ).toEqual({
      ok: false,
      errors: {
        [path]:
          path === "design.typography.caption"
            ? "This field is not in Site Definition 1.6.0."
            : "Choose a value registered by Site Definition 1.6.0.",
      },
    });
  });

  it("rejects an invalid value before it can enter interactive editor state", () => {
    expect(
      updateEditableSiteField(referenceSiteDefinition, {
        path: "section_hero.variant",
        value: "url(javascript:alert(1))",
      }),
    ).toBeNull();
  });

  it("allows a transient blank in ordinary copy until save validation", () => {
    expect(
      updateEditableSiteField(referenceSiteDefinition, {
        path: "section_hero.title",
        value: "",
      }),
    ).toEqual(
      expect.objectContaining({
        home: expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({ id: "section_hero", title: "" }),
          ]),
        }),
      }),
    );
  });
});

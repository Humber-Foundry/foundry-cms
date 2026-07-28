import { describe, expect, it } from "vitest";

import {
  applySiteDefinitionEdits,
  designContract,
  listEditableSiteFields,
  referenceSiteDefinition,
} from "./index";

describe("controlled design tokens", () => {
  it("registers exposed typography, colour, spacing, layout, and component variants", () => {
    expect(designContract.tokens).toEqual({
      "typography.heading": expect.objectContaining({
        values: ["editorial", "modern"],
      }),
      "colour.accent": expect.objectContaining({
        values: ["moss", "clay"],
      }),
      "spacing.section": expect.objectContaining({
        values: ["relaxed", "compact"],
      }),
      "layout.contentWidth": expect.objectContaining({
        values: ["standard", "wide"],
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
          values: ["editorial", "modern"],
        }),
        expect.objectContaining({
          path: "design.colour.accent",
          group: "Design",
          value: "moss",
          values: ["moss", "clay"],
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
      { path: "design.colour.accent", value: "clay" },
      { path: "design.spacing.section", value: "compact" },
      { path: "design.layout.contentWidth", value: "wide" },
      { path: "section_hero.variant", value: "focused" },
    ]);

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        design: {
          typography: { heading: "modern" },
          colour: { accent: "clay" },
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
    ["unknown token", "design.typography.body", "modern"],
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
          path === "design.typography.body"
            ? "This field is not in Site Definition 1.0.0."
            : "Choose a value registered by Site Definition 1.0.0.",
      },
    });
  });
});

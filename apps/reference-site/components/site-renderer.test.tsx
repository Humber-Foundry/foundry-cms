import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  applySiteDefinitionEdits,
  referenceSiteDefinition,
  type PageSection,
  type SiteDefinition,
} from "@foundry/site-definition";

import { SiteRenderer, SiteSection } from "./site-renderer";

describe("SiteRenderer controlled design projection", () => {
  it("renders registered tokens and variants as deterministic semantic attributes", () => {
    const result = applySiteDefinitionEdits(referenceSiteDefinition, [
      { path: "design.typography.heading", value: "modern" },
      { path: "design.colour.accent", value: "clay" },
      { path: "design.spacing.section", value: "compact" },
      { path: "design.layout.contentWidth", value: "wide" },
      { path: "section_hero.variant", value: "focused" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const first = renderToStaticMarkup(
      <SiteRenderer definition={result.definition} />,
    );
    const second = renderToStaticMarkup(
      <SiteRenderer definition={structuredClone(result.definition)} />,
    );

    expect(first).toBe(second);
    expect(first).toContain('data-typography-heading="modern"');
    expect(first).toContain('data-colour-accent="clay"');
    expect(first).toContain('data-spacing-section="compact"');
    expect(first).toContain('data-layout-content-width="wide"');
    expect(first).toContain('data-component-variant="focused"');
    expect(first).not.toContain("color:red");
    expect(first).not.toContain("url(https://bad.example)");
  });
});

describe("site renderer media placement", () => {
  it("does not reuse a canonical occurrence on a duplicated component", () => {
    const canonical = referenceSiteDefinition.home.sections.find(
      (section) => section.id === "section_hero",
    );
    if (canonical?.type !== "hero") {
      throw new Error("expected_canonical_hero");
    }
    const duplicate = {
      ...structuredClone(canonical),
      id: "section_hero_copy",
    } as PageSection;
    const definition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        media: [
          {
            occurrenceId: "occurrence_home_hero",
            revision: 1,
            asset: {
              assetId: "asset_hero",
              width: 1600,
              height: 900,
              contentType: "image/png",
            },
            crop: null,
          },
        ],
      },
    } as SiteDefinition;

    const canonicalMarkup = renderToStaticMarkup(
      <SiteSection
        section={canonical}
        definition={definition}
      />,
    );
    const duplicateMarkup = renderToStaticMarkup(
      <SiteSection
        section={duplicate}
        definition={definition}
      />,
    );

    expect(canonicalMarkup).toContain(
      'data-media-occurrence="occurrence_home_hero"',
    );
    expect(duplicateMarkup).not.toContain("data-media-occurrence");
  });
});

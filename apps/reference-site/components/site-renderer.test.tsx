import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  applySiteDefinitionEdits,
  referenceSiteDefinition,
} from "@foundry/site-definition";

import { SiteRenderer } from "./site-renderer";

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

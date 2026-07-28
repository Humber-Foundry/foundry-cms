import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  referenceSiteDefinition,
  type PageSection,
  type SiteDefinition,
} from "@foundry/site-definition";

import { SiteSection } from "./site-renderer";

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

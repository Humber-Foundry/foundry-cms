import { describe, expect, it } from "vitest";

import { homePage, referenceSiteDefinition } from "@humber-foundry/site-definition";

import { sectionAnchor } from "./section-anchor";

describe("section anchors", () => {
  it("uses each stable section identifier as its public anchor", () => {
    for (const section of homePage(referenceSiteDefinition).sections) {
      expect(sectionAnchor(section)).toBe(section.id);
    }
  });

  it("keeps navigation targets within the stable section identifiers", () => {
    const anchors = new Set(
      homePage(referenceSiteDefinition).sections.map(sectionAnchor),
    );
    const hero = homePage(referenceSiteDefinition).sections.find(
      (section) => section.type === "hero",
    );
    const links = [
      ...referenceSiteDefinition.site.navigation,
      ...(hero?.type === "hero"
        ? [hero.primaryAction, hero.secondaryAction]
        : []),
    ];

    for (const link of links) {
      expect(link.href.startsWith("#")).toBe(true);
      expect(anchors.has(link.href.slice(1))).toBe(true);
    }
  });
});

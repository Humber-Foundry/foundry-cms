import { describe, expect, it } from "vitest";

import {
  applyPageComposition,
  createDefaultPageSection,
  pageCompositionContract,
  referenceSiteDefinition,
  toPageComposition,
} from "./index";

describe("page component composition", () => {
  it("registers one stable page slot and the only component types it accepts", () => {
    expect(pageCompositionContract.slot).toEqual({
      id: "slot_home_sections",
      path: "home.sections",
      minItems: 1,
      maxItems: 12,
      allowedComponents: [
        "hero",
        "services",
        "proof",
        "callToAction",
      ],
    });
    expect(Object.keys(pageCompositionContract.components)).toEqual([
      "hero",
      "services",
      "proof",
      "callToAction",
    ]);
    expect(pageCompositionContract.components.hero.editableProps).toEqual([
      "eyebrow",
      "title",
      "summary",
    ]);
  });

  it("adds, orders, duplicates, removes, and configures registered components immutably", () => {
    const source = referenceSiteDefinition;
    const added = createDefaultPageSection(
      "callToAction",
      "section_second_contact",
    );
    const hero = structuredClone(source.home.sections[0]);
    const duplicateHero = {
      ...structuredClone(hero),
      id: "section_hero_copy",
      title: "A copied hero",
    };
    const result = applyPageComposition(source, {
      slotId: "slot_home_sections",
      components: [
        source.home.sections[2],
        duplicateHero,
        source.home.sections[1],
        source.home.sections[3],
        added,
      ],
    });

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        home: expect.objectContaining({
          sections: [
            source.home.sections[2],
            duplicateHero,
            source.home.sections[1],
            source.home.sections[3],
            added,
          ],
        }),
      }),
    });
    expect(source).toBe(referenceSiteDefinition);
    expect(source.home.sections.map(({ id }) => id)).toEqual([
      "section_hero",
      "section_services",
      "section_proof",
      "section_contact",
    ]);
  });

  it("round-trips the canonical slot payload with stable component identifiers", () => {
    expect(toPageComposition(referenceSiteDefinition)).toEqual({
      slotId: "slot_home_sections",
      components: referenceSiteDefinition.home.sections,
    });
  });

  it("accepts semantically equal protected scaffolding regardless of object key order", () => {
    const composition = structuredClone(
      toPageComposition(referenceSiteDefinition),
    );
    const hero = composition.components[0]!;
    if (hero.type !== "hero") {
      throw new Error("expected_hero_fixture");
    }
    const reordered = {
      ...composition,
      components: [
        {
          ...hero,
          primaryAction: {
            href: hero.primaryAction.href,
            label: hero.primaryAction.label,
            id: hero.primaryAction.id,
          },
        },
        ...composition.components.slice(1),
      ],
    };

    expect(
      applyPageComposition(referenceSiteDefinition, reordered),
    ).toEqual({
      ok: true,
      definition: referenceSiteDefinition,
    });
  });

  it("keeps components referenced by protected links outside removal", () => {
    const composition = {
      ...toPageComposition(referenceSiteDefinition),
      components: referenceSiteDefinition.home.sections.filter(
        ({ id }) => id !== "section_contact",
      ),
    };

    expect(
      applyPageComposition(referenceSiteDefinition, composition),
    ).toEqual({
      ok: false,
      errors: {
        "section_contact.id":
          "This component is referenced by protected page scaffolding.",
      },
    });
  });

  it.each([
    {
      name: "an unknown slot",
      change: (composition: Record<string, any>) => {
        composition.slotId = "slot_routes";
      },
      path: "slot_routes",
    },
    {
      name: "an unregistered component",
      change: (composition: Record<string, any>) => {
        composition.components[0].type = "script";
      },
      path: "section_hero.type",
    },
    {
      name: "a duplicate stable identifier",
      change: (composition: Record<string, any>) => {
        composition.components[1].id = composition.components[0].id;
      },
      path: "section_hero.id",
    },
    {
      name: "protected component scaffolding",
      change: (composition: Record<string, any>) => {
        composition.components[0].primaryAction.href =
          "mailto:attacker@example.com";
      },
      path: "section_hero.primaryAction",
    },
    {
      name: "a protected nested identifier change",
      change: (composition: Record<string, any>) => {
        composition.components[0].primaryAction.id = "changed_action";
      },
      path: "section_hero.primaryAction",
    },
    {
      name: "a type change for an existing component",
      change: (composition: Record<string, any>) => {
        composition.components[0] = createDefaultPageSection(
          "proof",
          "section_hero",
        );
      },
      path: "section_hero.type",
    },
  ])("rejects $name", ({ change, path }) => {
    const composition = structuredClone(
      toPageComposition(referenceSiteDefinition),
    ) as unknown as Record<string, any>;
    change(composition);

    const result = applyPageComposition(referenceSiteDefinition, composition);

    expect(result).toEqual({
      ok: false,
      errors: expect.objectContaining({
        [path]: expect.any(String),
      }),
    });
  });
});

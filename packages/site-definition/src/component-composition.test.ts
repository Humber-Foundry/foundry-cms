import { describe, expect, it } from "vitest";

import {
  applyPageComposition,
  createDefaultPageSection,
  pageCompositionContract,
  referenceSiteDefinition,
  toPageComposition,
  type SiteDefinition,
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

  it("derives inserted Hero links from the active Site Definition", () => {
    const proof = referenceSiteDefinition.home.sections[2];
    const clientDefinition = {
      ...referenceSiteDefinition,
      site: {
        ...referenceSiteDefinition.site,
        navigation: [],
      },
      home: {
        ...referenceSiteDefinition.home,
        sections: [proof],
      },
    };
    const hero = createDefaultPageSection(
      "hero",
      "section_client_hero",
      clientDefinition,
    );

    expect(hero).toEqual(
      expect.objectContaining({
        primaryAction: expect.objectContaining({
          href: "#section_proof",
        }),
        secondaryAction: expect.objectContaining({
          href: "#section_proof",
        }),
      }),
    );
    expect(
      applyPageComposition(clientDefinition, {
        slotId: "slot_home_sections",
        components: [hero, proof],
      }),
    ).toEqual({
      ok: true,
      definition: expect.objectContaining({
        home: expect.objectContaining({
          sections: [hero, proof],
        }),
      }),
    });
  });

  it("derives an inserted call-to-action destination from the active Site Definition", () => {
    const existing = referenceSiteDefinition.home.sections[3];
    if (existing.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const clientDefinition = {
      ...referenceSiteDefinition,
      site: {
        ...referenceSiteDefinition.site,
        navigation: [],
      },
      home: {
        ...referenceSiteDefinition.home,
        sections: [
          ...referenceSiteDefinition.home.sections.slice(0, 3),
          {
            ...existing,
            action: {
              ...existing.action,
              label: "Contact Acme",
              href: "mailto:studio@acme.example",
            },
          },
        ],
      },
    } as SiteDefinition;
    const inserted = createDefaultPageSection(
      "callToAction",
      "section_second_contact",
      clientDefinition,
    );

    expect(inserted).toEqual(
      expect.objectContaining({
        action: expect.objectContaining({
          label: "Contact Acme",
          href: "mailto:studio@acme.example",
        }),
      }),
    );
    expect(
      applyPageComposition(clientDefinition, {
        slotId: "slot_home_sections",
        components: [...clientDefinition.home.sections, inserted],
      }).ok,
    ).toBe(true);
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

  it("allows nested human-readable copy while protecting nested identity and links", () => {
    const composition = structuredClone(
      toPageComposition(referenceSiteDefinition),
    );
    const hero = composition.components[0]!;
    if (hero.type !== "hero") {
      throw new Error("expected_hero_fixture");
    }
    (hero.primaryAction as { label: string }).label =
      "A revised action label";

    expect(
      applyPageComposition(referenceSiteDefinition, composition),
    ).toEqual({
      ok: true,
      definition: expect.objectContaining({
        home: expect.objectContaining({
          sections: expect.arrayContaining([
            expect.objectContaining({
              id: "section_hero",
              primaryAction: expect.objectContaining({
                id: "action_start",
                label: "A revised action label",
                href: "#section_contact",
              }),
            }),
          ]),
        }),
      }),
    });
  });

  it.each([
    {
      name: "a missing nested field",
      change: (composition: Record<string, any>) => {
        delete composition.components[0].primaryAction.label;
      },
      path: "section_hero.primaryAction",
    },
    {
      name: "an unknown nested field",
      change: (composition: Record<string, any>) => {
        composition.components[0].primaryAction.script = "injected";
      },
      path: "section_hero.primaryAction",
    },
    {
      name: "blank nested copy",
      change: (composition: Record<string, any>) => {
        composition.components[0].primaryAction.label = "   ";
      },
      path: "section_hero.primaryAction.label",
    },
  ])("rejects malformed schema content: $name", ({ change, path }) => {
    const composition = structuredClone(
      toPageComposition(referenceSiteDefinition),
    ) as unknown as Record<string, any>;
    change(composition);

    expect(
      applyPageComposition(referenceSiteDefinition, composition),
    ).toEqual({
      ok: false,
      errors: expect.objectContaining({
        [path]: expect.any(String),
      }),
    });
  });

  it("rejects nested identifiers that collide with protected IDs outside the page slot", () => {
    const original = structuredClone(
      toPageComposition(referenceSiteDefinition),
    );
    const callToAction = original.components[3]!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const composition = {
      ...original,
      components: [
        ...original.components,
        {
          ...structuredClone(callToAction),
          id: "section_second_contact",
          action: {
            ...structuredClone(callToAction.action),
            id: "nav_work",
          },
        },
      ],
    };

    expect(
      applyPageComposition(referenceSiteDefinition, composition),
    ).toEqual({
      ok: false,
      errors: {
        "section_second_contact.id":
          "Every component and nested item needs a unique stable identifier.",
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

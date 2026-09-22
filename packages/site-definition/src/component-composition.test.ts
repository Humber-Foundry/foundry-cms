import { describe, expect, it } from "vitest";

import {
  applyPageComposition,
  createDefaultPageSection,
  homePage,
  pageCompositionContract,
  referenceSiteDefinition,
  remapPageSectionNestedIds,
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
        "contactForm",
      ],
    });
    expect(Object.keys(pageCompositionContract.components)).toEqual([
      "hero",
      "services",
      "proof",
      "callToAction",
      "contactForm",
    ]);
    expect(pageCompositionContract.components.hero.editableProps).toEqual([
      "eyebrow",
      "title",
      "summary",
    ]);
    // The contact form's own fields are fixed, and the form it posts to is
    // fixed. Only the words around them are the owner's to write.
    expect(
      pageCompositionContract.components.contactForm.editableProps,
    ).toEqual(["title", "body", "actionLabel"]);
  });

  it("adds, orders, duplicates, removes, and configures registered components immutably", () => {
    const source = referenceSiteDefinition;
    const added = createDefaultPageSection(
      "callToAction",
      "section_second_contact",
    );
    const hero = structuredClone(
      homePage(source).sections.find((section) => section.type === "hero")!,
    );
    const duplicateHero = {
      ...structuredClone(hero),
      id: "section_hero_copy",
      title: "A copied hero",
      primaryAction: {
        ...structuredClone(hero.primaryAction),
        id: "section_hero_copy_item_1",
      },
      secondaryAction: {
        ...structuredClone(hero.secondaryAction),
        id: "section_hero_copy_item_2",
      },
    };
    const result = applyPageComposition(source, homePage(source), {
      slotId: "slot_home_sections",
      components: [
        homePage(source).sections[2],
        duplicateHero,
        homePage(source).sections[1],
        homePage(source).sections[3],
        added,
      ],
    });

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        pages: [expect.objectContaining({
          sections: [
            homePage(source).sections[2],
            duplicateHero,
            homePage(source).sections[1],
            homePage(source).sections[3],
            added,
          ],
        })],
      }),
    });
    expect(source).toBe(referenceSiteDefinition);
    expect(homePage(source).sections.map(({ id }) => id)).toEqual([
      "section_hero",
      "section_services",
      "section_proof",
      "section_contact",
    ]);
  });

  it("validates components added and duplicated in the same command", () => {
    const first = createDefaultPageSection("proof", "section_added_proof", {
      definition: referenceSiteDefinition,
      page: homePage(referenceSiteDefinition),
    });
    const duplicate = remapPageSectionNestedIds({
      ...structuredClone(first),
      id: "section_added_proof_copy",
    });

    const result = applyPageComposition(
      referenceSiteDefinition,
      homePage(referenceSiteDefinition),
      {
        slotId: "slot_home_sections",
        components: [
          ...homePage(referenceSiteDefinition).sections,
          first,
          duplicate,
        ],
      },
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a stale composition variant for an existing component", () => {
    const hero = homePage(referenceSiteDefinition).sections[0]!;
    if (hero.type !== "hero") {
      throw new Error("expected_hero_fixture");
    }
    const liveDefinition: SiteDefinition = {
      ...referenceSiteDefinition,
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [
            { ...hero, variant: "focused" },
            ...homePage(referenceSiteDefinition).sections.slice(1),
          ],
        },
      ],
    };
    const staleComposition = structuredClone(
      toPageComposition(homePage(referenceSiteDefinition)),
    );

    expect(applyPageComposition(
      liveDefinition,
      homePage(liveDefinition),
      staleComposition,
    )).toEqual({
      ok: false,
      errors: {
        "section_hero.variant":
          "This component scaffolding is protected by the Site Definition.",
      },
    });
  });

  it("derives new component scaffolding from earlier additions in one command", () => {
    const proof = homePage(referenceSiteDefinition).sections.find(
      (section) => section.type === "proof",
    )!;
    const replacedCallToAction =
      homePage(referenceSiteDefinition).sections.find(
        (section) => section.type === "callToAction",
      )!;
    const base = {
      ...referenceSiteDefinition,
      site: { ...referenceSiteDefinition.site, navigation: [] },
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [proof, replacedCallToAction],
        },
      ],
    } as SiteDefinition;
    const callToAction = createDefaultPageSection(
      "callToAction",
      "section_added_contact",
      { definition: base, page: homePage(base) },
    );
    const withCallToAction = {
      ...base,
      pages: [
        {
          ...homePage(base),
          sections: [proof, callToAction],
        },
      ],
    } as SiteDefinition;
    const hero = createDefaultPageSection("hero", "section_added_hero", {
      definition: withCallToAction,
      page: homePage(withCallToAction),
    });

    const result = applyPageComposition(base, homePage(base), {
      slotId: "slot_home_sections",
      components: [proof, callToAction, hero],
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("round-trips the canonical slot payload with stable component identifiers", () => {
    expect(toPageComposition(homePage(referenceSiteDefinition))).toEqual({
      slotId: "slot_home_sections",
      components: homePage(referenceSiteDefinition).sections,
    });
  });

  it("accepts component identifiers allowed by the published Site Definition schema", () => {
    const hero = homePage(referenceSiteDefinition).sections[0]!;
    const definition: SiteDefinition = {
      ...referenceSiteDefinition,
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [
            { ...hero, id: "hero" },
            ...homePage(referenceSiteDefinition).sections.slice(1),
          ],
        },
      ],
    };

    expect(
      applyPageComposition(
        definition,
        homePage(definition),
        toPageComposition(homePage(definition,
      ))),
    ).toEqual({
      ok: true,
      definition,
    });
  });

  it("derives inserted Hero links from the active Site Definition", () => {
    const proof = homePage(referenceSiteDefinition).sections[2];
    const clientDefinition = {
      ...referenceSiteDefinition,
      site: {
        ...referenceSiteDefinition.site,
        navigation: [],
      },
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [proof],
        },
      ],
    };
    const hero = createDefaultPageSection("hero", "section_client_hero", {
      definition: clientDefinition,
      page: homePage(clientDefinition),
    });

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
      applyPageComposition(clientDefinition, homePage(clientDefinition), {
        slotId: "slot_home_sections",
        components: [hero, proof],
      }),
    ).toEqual({
      ok: true,
      definition: expect.objectContaining({
        pages: [expect.objectContaining({
          sections: [hero, proof],
        })],
      }),
    });
  });

  it("derives an inserted call-to-action destination from the active Site Definition", () => {
    const existing = homePage(referenceSiteDefinition).sections[3];
    if (existing.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const clientDefinition = {
      ...referenceSiteDefinition,
      site: {
        ...referenceSiteDefinition.site,
        navigation: [],
      },
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [
            ...homePage(referenceSiteDefinition).sections.slice(0, 3),
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
      ],
    } as SiteDefinition;
    const inserted = createDefaultPageSection(
      "callToAction",
      "section_second_contact",
      { definition: clientDefinition, page: homePage(clientDefinition) },
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
      applyPageComposition(clientDefinition, homePage(clientDefinition), {
        slotId: "slot_home_sections",
        components: [...homePage(clientDefinition).sections, inserted],
      }).ok,
    ).toBe(true);
  });

  it("accepts semantically equal protected scaffolding regardless of object key order", () => {
    const composition = structuredClone(
      toPageComposition(homePage(referenceSiteDefinition)),
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
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        reordered,
      ),
    ).toEqual({
      ok: true,
      definition: referenceSiteDefinition,
    });
  });

  it("keeps components referenced by protected links outside removal", () => {
    const composition = {
      ...toPageComposition(homePage(referenceSiteDefinition)),
      components: homePage(referenceSiteDefinition).sections.filter(
        ({ id }) => id !== "section_contact",
      ),
    };

    expect(
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        composition,
      ),
    ).toEqual({
      ok: false,
      errors: {
        "section_contact.id":
          "This component is referenced by protected page scaffolding.",
      },
    });
  });

  it("protects schema-valid component IDs referenced by fragment links", () => {
    const definition: SiteDefinition = {
      ...referenceSiteDefinition,
      site: {
        ...referenceSiteDefinition.site,
        navigation: referenceSiteDefinition.site.navigation.map((link) =>
          link.href === "#section_contact"
            ? { ...link, href: "#contact" as const }
            : link,
        ),
      },
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: homePage(referenceSiteDefinition).sections.map((section) => {
            if (section.type === "hero") {
              return {
                ...section,
                primaryAction: {
                  ...section.primaryAction,
                  href: "#contact" as const,
                },
              };
            }
            return section.type === "callToAction"
              ? { ...section, id: "contact" }
              : section;
          }),
        },
      ],
    };
    const composition = {
      ...toPageComposition(homePage(definition)),
      components: homePage(definition).sections.filter(
        ({ id }) => id !== "contact",
      ),
    };

    expect(applyPageComposition(
      definition,
      homePage(definition),
      composition,
    )).toEqual({
      ok: false,
      errors: {
        "contact.id":
          "This component is referenced by protected page scaffolding.",
      },
    });
  });

  it("ignores schema-valid fragment links that are not component roots", () => {
    const definition: SiteDefinition = {
      ...referenceSiteDefinition,
      site: {
        ...referenceSiteDefinition.site,
        navigation: [
          {
            ...referenceSiteDefinition.site.navigation[0]!,
            href: "#section_services_title",
          },
          ...referenceSiteDefinition.site.navigation.slice(1),
        ],
      },
    };

    expect(
      applyPageComposition(
        definition,
        homePage(definition),
        toPageComposition(homePage(definition,
      ))),
    ).toEqual({ ok: true, definition });
  });

  it("allows nested human-readable copy while protecting nested identity and links", () => {
    const composition = structuredClone(
      toPageComposition(homePage(referenceSiteDefinition)),
    );
    const hero = composition.components[0]!;
    if (hero.type !== "hero") {
      throw new Error("expected_hero_fixture");
    }
    (hero.primaryAction as { label: string }).label =
      "A revised action label";

    expect(
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        composition,
      ),
    ).toEqual({
      ok: true,
      definition: expect.objectContaining({
        pages: [expect.objectContaining({
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
        })],
      }),
    });
  });

  it.each([
    {
      name: "an empty document",
      body: {
        version: "1.0.0",
        type: "document",
        children: [],
      },
    },
    {
      name: "an empty paragraph",
      body: {
        version: "1.0.0",
        type: "document",
        children: [{ type: "paragraph", children: [] }],
      },
    },
    {
      name: "a whitespace-only paragraph",
      body: {
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text: "   ", marks: [] }],
          },
        ],
      },
    },
    {
      name: "a zero-width-only paragraph",
      body: {
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", text: "\u200B", marks: [] },
            ],
          },
        ],
      },
    },
    ...[
      ["a variation-selector-only paragraph", "\uFE0F"],
      ["a grapheme-joiner-only paragraph", "\u034F"],
    ].map(([name, text]) => ({
      name,
      body: {
        version: "1.0.0",
        type: "document",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", text, marks: [] }],
          },
        ],
      },
    })),
  ])("rejects required rich text with $name", ({ body }) => {
    const composition = structuredClone(
      toPageComposition(homePage(referenceSiteDefinition)),
    );
    const callToAction = composition.components.find(
      (section) => section.type === "callToAction",
    );
    if (callToAction?.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    (
      callToAction as unknown as {
        body: typeof callToAction.body;
      }
    ).body = body as typeof callToAction.body;

    expect(
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        composition,
      ),
    ).toEqual({
      ok: false,
      errors: {
        "section_contact.body": "Enter at least one visible character.",
      },
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
      toPageComposition(homePage(referenceSiteDefinition)),
    ) as unknown as Record<string, any>;
    change(composition);

    expect(
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        composition,
      ),
    ).toEqual({
      ok: false,
      errors: expect.objectContaining({
        [path]: expect.any(String),
      }),
    });
  });

  it("rejects nested identifiers that collide with protected IDs outside the page slot", () => {
    const original = structuredClone(
      toPageComposition(homePage(referenceSiteDefinition)),
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
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        composition,
      ),
    ).toEqual({
      ok: false,
      errors: {
        "section_second_contact.action":
          "This component scaffolding is protected by the Site Definition.",
      },
    });
  });

  it("rejects caller-selected nested identifiers on duplicated components", () => {
    const composition = structuredClone(
      toPageComposition(homePage(referenceSiteDefinition)),
    );
    const proof = composition.components[2]!;
    if (proof.type !== "proof") {
      throw new Error("expected_proof_fixture");
    }
    const duplicate = {
      ...structuredClone(proof),
      id: "section_second_proof",
      metrics: proof.metrics.map((metric) => ({
        ...structuredClone(metric),
        id: "action_start",
      })),
    };

    expect(
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        {
          ...composition,
          components: [
            ...composition.components.filter(
              ({ id }) => id !== "section_hero",
            ),
            duplicate,
          ],
        },
      ).ok,
    ).toBe(false);
  });

  it("binds duplicate nested identifiers to schema paths, not object key order", () => {
    const composition = structuredClone(
      toPageComposition(homePage(referenceSiteDefinition)),
    );
    const hero = composition.components[0]!;
    if (hero.type !== "hero") {
      throw new Error("expected_hero_fixture");
    }
    const duplicate = {
      id: "section_second_hero",
      type: "hero" as const,
      secondaryAction: {
        ...structuredClone(hero.secondaryAction),
        id: "section_second_hero_item_1",
      },
      primaryAction: {
        ...structuredClone(hero.primaryAction),
        id: "section_second_hero_item_2",
      },
      eyebrow: hero.eyebrow,
      title: hero.title,
      summary: hero.summary,
    };

    expect(
      applyPageComposition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        {
          ...composition,
          components: [...composition.components, duplicate],
        },
      ).ok,
    ).toBe(false);
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
      name: "an unregistered composition field",
      change: (composition: Record<string, any>) => {
        composition.unregistered = "executable boundary";
      },
      path: "slot_home_sections",
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
      toPageComposition(homePage(referenceSiteDefinition)),
    ) as unknown as Record<string, any>;
    change(composition);

    const result = applyPageComposition(
      referenceSiteDefinition,
      homePage(referenceSiteDefinition),
      composition,
    );

    expect(result).toEqual({
      ok: false,
      errors: expect.objectContaining({
        [path]: expect.any(String),
      }),
    });
  });
});

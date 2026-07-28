import { describe, expect, it } from "vitest";

import {
  referenceSiteDefinition,
  type PageSection,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  definitionToPuckData,
  pageCompositionChanged,
  puckDataToDefinition,
} from "./page-composition-puck";

describe("Puck page-composition adapter", () => {
  it("binds Puck data to stable registered component identifiers", () => {
    const data = definitionToPuckData(referenceSiteDefinition);

    expect(data.content.map(({ type, props }) => [type, props.id])).toEqual([
      ["hero", "section_hero"],
      ["services", "section_services"],
      ["proof", "section_proof"],
      ["callToAction", "section_contact"],
    ]);
  });

  it("preserves component identifiers allowed by the published schema", () => {
    const hero = referenceSiteDefinition.home.sections[0]!;
    const definition: SiteDefinition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [
          { ...hero, id: "hero" },
          ...referenceSiteDefinition.home.sections.slice(1),
        ],
      },
    };

    const result = puckDataToDefinition(
      definition,
      definitionToPuckData(definition),
    );

    expect(result).toEqual({ ok: true, definition });
  });

  it("maps a Puck insert, reorder, duplicate, remove, and field change to a valid definition", () => {
    const data = structuredClone(
      definitionToPuckData(referenceSiteDefinition),
    ) as {
      root: { props: Record<string, never> };
      content: Array<{ type: PageSection["type"]; props: PageSection }>;
    };
    const [hero, services, proof, contact] = data.content;
    expect(hero).toBeDefined();
    expect(services).toBeDefined();
    expect(proof).toBeDefined();
    expect(contact).toBeDefined();
    data.content = [
      proof!,
      {
        ...hero!,
        props: {
          ...hero!.props,
          id: "Puck-generated-duplicate",
          title: "Duplicate headline",
        } as PageSection,
      },
      services!,
      contact!,
      {
        type: "callToAction",
        props: {
          id: "Puck-generated-insert",
          type: "callToAction",
          variant: "moss",
          eyebrow: "New",
          title: "A new invitation",
          body: "Take the next step.",
          action: {
            id: "temporary",
            label: "Ignored protected value",
            href: "mailto:attacker@example.com",
          },
        },
      },
    ];

    const result = puckDataToDefinition(referenceSiteDefinition, data);

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        home: expect.objectContaining({
          sections: [
            referenceSiteDefinition.home.sections[2],
            expect.objectContaining({
              id: "section_hero_puck_generated_duplicate",
              type: "hero",
              title: "Duplicate headline",
              primaryAction: expect.objectContaining({
                id: "section_hero_puck_generated_duplicate_item_1",
                href: "#section_contact",
              }),
            }),
            referenceSiteDefinition.home.sections[1],
            referenceSiteDefinition.home.sections[3],
            expect.objectContaining({
              id: "section_call_to_action_puck_generated_insert",
              type: "callToAction",
              title: "A new invitation",
              action: expect.objectContaining({
                href: "mailto:hello@example.com",
              }),
            }),
          ],
        }),
      }),
    });
  });

  it("projects related components added earlier in the same Puck change", () => {
    const proof = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "proof",
    )!;
    const replacedCallToAction =
      referenceSiteDefinition.home.sections.find(
        (section) => section.type === "callToAction",
      )!;
    const base = {
      ...referenceSiteDefinition,
      site: { ...referenceSiteDefinition.site, navigation: [] },
      home: {
        ...referenceSiteDefinition.home,
        sections: [proof, replacedCallToAction],
      },
    } as SiteDefinition;
    const result = puckDataToDefinition(base, {
      root: { props: {} },
      content: [
        { type: "proof", props: proof },
        {
          type: "callToAction",
          props: {
            id: "section_added_contact",
            type: "callToAction",
            eyebrow: "Next",
            title: "Continue",
            body: "Take the next step",
          },
        },
        {
          type: "hero",
          props: {
            id: "section_added_hero",
            type: "hero",
            eyebrow: "Welcome",
            title: "A new page",
            summary: "Start here",
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const hero = result.definition.home.sections.at(-1);
      expect(
        hero?.type === "hero" ? hero.primaryAction.href : undefined,
      ).toBe("#section_added_contact");
    }
  });

  it("fails closed for unregistered Puck content", () => {
    const result = puckDataToDefinition(referenceSiteDefinition, {
      root: { props: {} },
      content: [{ type: "script", props: { id: "section_script" } }],
    });

    expect(result).toEqual({
      ok: false,
      errors: {
        slot_home_sections:
          "Only registered page components can enter this slot.",
      },
    });
  });

  it("rejects duplicate Puck identities instead of deriving position-based IDs", () => {
    const data = structuredClone(
      definitionToPuckData(referenceSiteDefinition),
    );
    data.content.push(structuredClone(data.content[0]!));

    expect(puckDataToDefinition(referenceSiteDefinition, data)).toEqual({
      ok: false,
      errors: {
        slot_home_sections:
          "Every Puck component needs one unique stable identifier.",
      },
    });
  });

  it("only emits a structural command when component identity or order changes", () => {
    const copyEdited = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [
          {
            ...referenceSiteDefinition.home.sections[0],
            title: "Changed copy",
          },
          ...referenceSiteDefinition.home.sections.slice(1),
        ] as PageSection[],
      },
    };
    expect(
      pageCompositionChanged(referenceSiteDefinition, copyEdited),
    ).toBe(false);

    const reordered = {
      ...copyEdited,
      home: {
        ...copyEdited.home,
        sections: [...copyEdited.home.sections].reverse(),
      },
    };
    expect(
      pageCompositionChanged(referenceSiteDefinition, reordered),
    ).toBe(true);
  });
});

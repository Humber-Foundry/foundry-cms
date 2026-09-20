import { describe, expect, it } from "vitest";

import {
  createPageComponentRegistry,
  createRegisteredPageComponent,
  foundationPageComponentRegistry,
  homePage,
  referenceSiteDefinition,
  type PageSection,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import {
  definitionToPuckData,
  pageCompositionChanged,
  puckDataToDefinition,
} from "./page-composition-puck";

function richBody(text: string) {
  return {
    version: "1.0.0" as const,
    type: "document" as const,
    children: [
      {
        type: "paragraph" as const,
        children: [{ type: "text" as const, text, marks: [] }],
      },
    ],
  };
}

describe("Puck page-composition adapter", () => {
  it("preserves protected registered props when Puck duplicates a component", () => {
    const themedStory = createRegisteredPageComponent({
      type: "themedStory",
      label: "Themed story",
      fields: {
        title: { control: "text", label: "Title", defaultValue: "A story" },
        theme: {
          control: "select",
          label: "Theme",
          defaultValue: "warm",
          options: [
            { label: "Warm", value: "warm" },
            { label: "Cool", value: "cool" },
          ],
          editable: false,
        },
      },
    });
    const registry = createPageComponentRegistry(
      foundationPageComponentRegistry,
      [themedStory],
    );
    const existing = {
      ...themedStory.createDefault("section_themed_story"),
      props: { title: "An installed story", theme: "cool" },
    } as const;
    const definition = {
      ...referenceSiteDefinition,
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [...homePage(referenceSiteDefinition).sections, existing],
        },
      ],
    } as SiteDefinition;
    const data = definitionToPuckData(homePage(definition), registry);
    const source = data.content.at(-1)!;
    data.content.push({
      ...structuredClone(source),
      props: { ...structuredClone(source.props), id: "themedStory-generated-copy" },
    });

    const result = puckDataToDefinition(
      definition,
      homePage(definition),
      data,
      registry,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(homePage(result.definition).sections.at(-1)).toMatchObject({
      type: "registered",
      component: "themedStory",
      props: { title: "An installed story", theme: "cool" },
    });
  });

  it("matches a duplicate to nested protected props when registered siblings differ", () => {
    const profileCard = createRegisteredPageComponent({
      type: "profileCard",
      label: "Profile card",
      fields: {
        profile: {
          control: "object",
          label: "Profile",
          fields: {
            name: { control: "text", label: "Name", defaultValue: "A person" },
            internalId: {
              control: "text",
              label: "Internal identifier",
              defaultValue: "profile_default",
              editable: false,
            },
          },
          defaultValue: {
            name: "A person",
            internalId: "profile_default",
          },
        },
      },
    });
    const registry = createPageComponentRegistry(
      foundationPageComponentRegistry,
      [profileCard],
    );
    const first = {
      ...profileCard.createDefault("section_profile_one"),
      props: { profile: { name: "First", internalId: "id_one" } },
    } as const;
    const second = {
      ...profileCard.createDefault("section_profile_two"),
      props: { profile: { name: "Second", internalId: "id_two" } },
    } as const;
    const definition = {
      ...referenceSiteDefinition,
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [
            ...homePage(referenceSiteDefinition).sections,
            first,
            second,
          ],
        },
      ],
    } as SiteDefinition;
    const data = definitionToPuckData(homePage(definition), registry);
    const source = data.content.at(-1)!;
    data.content.push({
      ...structuredClone(source),
      props: { ...structuredClone(source.props), id: "profileCard-generated-copy" },
    });

    const result = puckDataToDefinition(
      definition,
      homePage(definition),
      data,
      registry,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(homePage(result.definition).sections.at(-1)).toMatchObject({
      type: "registered",
      component: "profileCard",
      props: { profile: { name: "Second", internalId: "id_two" } },
    });
  });


  it("binds Puck data to stable registered component identifiers", () => {
    const data = definitionToPuckData(homePage(referenceSiteDefinition));

    expect(data.content.map(({ type, props }) => [type, props.id])).toEqual([
      ["hero", "section_hero"],
      ["services", "section_services"],
      ["proof", "section_proof"],
      ["callToAction", "section_contact"],
    ]);
  });

  it("preserves component identifiers allowed by the published schema", () => {
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

    const result = puckDataToDefinition(
      definition,
      homePage(definition),
      definitionToPuckData(homePage(definition)),
    );

    expect(result).toEqual({ ok: true, definition });
  });

  it("does not let stale Puck props overwrite the outer variant owner", () => {
    const staleData = definitionToPuckData(homePage(referenceSiteDefinition));
    const sourceHero = homePage(referenceSiteDefinition).sections[0]!;
    const liveDefinition = {
      ...referenceSiteDefinition,
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [
            { ...sourceHero, variant: "focused" },
            ...homePage(referenceSiteDefinition).sections.slice(1),
          ],
        },
      ],
    } as SiteDefinition;
    const hero = homePage(liveDefinition).sections[0]!;
    if (hero.type !== "hero") {
      throw new Error("expected_hero");
    }
    const staleHero = staleData.content[0]!;
    if (staleHero.props.type !== "hero") {
      throw new Error("expected_stale_hero");
    }
    staleData.content[0] = {
      ...staleHero,
      props: {
        ...staleHero.props,
        title: "An unrelated Puck edit",
      },
    };

    const result = puckDataToDefinition(
      liveDefinition,
      homePage(liveDefinition),
      staleData,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const recoveredHero = homePage(result.definition).sections[0]!;
      expect(
        recoveredHero.type === "hero"
          ? [recoveredHero.variant, recoveredHero.title]
          : null,
      ).toEqual(["focused", "An unrelated Puck edit"]);
    }
  });

  it("maps a Puck insert, reorder, duplicate, remove, and field change to a valid definition", () => {
    const data = structuredClone(
      definitionToPuckData(homePage(referenceSiteDefinition)),
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
          body: richBody("Take the next step."),
          action: {
            id: "temporary",
            label: "Ignored protected value",
            href: "mailto:attacker@example.com",
          },
        },
      },
    ];

    const result = puckDataToDefinition(
      referenceSiteDefinition,
      homePage(referenceSiteDefinition),
      data,
    );

    expect(result).toEqual({
      ok: true,
      definition: expect.objectContaining({
        pages: [expect.objectContaining({
          sections: [
            homePage(referenceSiteDefinition).sections[2],
            expect.objectContaining({
              id: "section_hero_puck_generated_duplicate",
              type: "hero",
              title: "Duplicate headline",
              primaryAction: expect.objectContaining({
                id: "section_hero_puck_generated_duplicate_item_1",
                href: "#section_contact",
              }),
            }),
            homePage(referenceSiteDefinition).sections[1],
            homePage(referenceSiteDefinition).sections[3],
            expect.objectContaining({
              id: "section_call_to_action_puck_generated_insert",
              type: "callToAction",
              title: "A new invitation",
              action: expect.objectContaining({
                href: "mailto:hello@example.com",
              }),
            }),
          ],
        })],
      }),
    });
  });

  it("projects related components added earlier in the same Puck change", () => {
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
    const result = puckDataToDefinition(base, homePage(base), {
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
            body: richBody("Take the next step"),
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
      const hero = homePage(result.definition).sections.at(-1);
      expect(
        hero?.type === "hero" ? hero.primaryAction.href : undefined,
      ).toBe("#section_added_contact");
    }
  });

  it("fails closed for unregistered Puck content", () => {
    const result = puckDataToDefinition(
      referenceSiteDefinition,
      homePage(referenceSiteDefinition),
      {
        root: { props: {} },
        content: [{ type: "script", props: { id: "section_script" } }],
      },
    );

    expect(result).toEqual({
      ok: false,
      errors: {
        slot_home_sections:
          "Only registered page components can enter this slot.",
      },
    });
  });

  it("carries a versioned rich-text body through the Puck adapter", () => {
    const data = structuredClone(
      definitionToPuckData(homePage(referenceSiteDefinition)),
    );
    const callToAction = data.content.find(
      (component) => component.type === "callToAction",
    )!;
    const body = richBody("Edited without raw markup");
    callToAction.props = {
      ...callToAction.props,
      body,
    };

    const result = puckDataToDefinition(
      referenceSiteDefinition,
      homePage(referenceSiteDefinition),
      data,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        homePage(result.definition).sections.find(
          (section) => section.type === "callToAction",
        ),
      ).toEqual(expect.objectContaining({ body }));
    }
  });

  it("rejects a raw string in the rich-text Puck field", () => {
    const data = structuredClone(
      definitionToPuckData(homePage(referenceSiteDefinition)),
    ) as unknown as {
      content: Array<{
        type: PageSection["type"];
        props: Record<string, unknown>;
      }>;
    };
    const callToAction = data.content.find(
      (component) => component.type === "callToAction",
    )!;
    callToAction.props.body = "<script>alert(1)</script>";

    expect(
      puckDataToDefinition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        data,
      ),
    ).toEqual({
      ok: false,
      errors: {
        "section_contact.body":
          "The visual editor must preserve the versioned rich-text document.",
      },
    });
  });

  it("rejects duplicate Puck identities instead of deriving position-based IDs", () => {
    const data = structuredClone(
      definitionToPuckData(homePage(referenceSiteDefinition)),
    );
    data.content.push(structuredClone(data.content[0]!));

    expect(
      puckDataToDefinition(
        referenceSiteDefinition,
        homePage(referenceSiteDefinition),
        data,
      ),
    ).toEqual({
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
      pages: [
        {
          ...homePage(referenceSiteDefinition),
          sections: [
            {
              ...homePage(referenceSiteDefinition).sections[0],
              title: "Changed copy",
            },
            ...homePage(referenceSiteDefinition).sections.slice(1),
          ] as PageSection[],
        },
      ],
    };
    expect(
      pageCompositionChanged(
        homePage(referenceSiteDefinition),
        homePage(copyEdited),
      ),
    ).toBe(false);

    const reordered = {
      ...copyEdited,
      pages: [
        {
          ...homePage(copyEdited),
          sections: [...homePage(copyEdited).sections].reverse(),
        },
      ],
    };
    expect(
      pageCompositionChanged(
        homePage(referenceSiteDefinition),
        homePage(reordered),
      ),
    ).toBe(true);
  });
});

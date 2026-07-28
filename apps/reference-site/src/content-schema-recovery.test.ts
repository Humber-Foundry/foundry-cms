import { describe, expect, it } from "vitest";

import { canonicalJson } from "@foundry/application";
import {
  createRichTextDocumentFromPlainText,
  referenceSiteDefinition,
  serializeRichTextDocument,
} from "@foundry/site-definition";

import {
  durableSchemaRecoveryEdits,
  mediaManifestRecoveryPath,
  mergeDurableAndOutboxRecoveryEdits,
  upgradeSiteDefinitionForCurrentSchema,
} from "./content-schema-recovery";
import { applyStructuralRecovery } from "./content-editor-recovery";

function legacyDefinition(
  name: string = referenceSiteDefinition.site.name,
) {
  const definition = structuredClone(referenceSiteDefinition) as any;
  definition.definitionVersion = "1.0.0";
  definition.schemaVersion = "1.0.0";
  delete definition.design;
  definition.home.sections.forEach((section: any) => {
    delete section.variant;
  });
  definition.site.name = name;
  return definition;
}

function storedDesignDefinition(body: string) {
  const definition = structuredClone(referenceSiteDefinition) as any;
  definition.definitionVersion = "1.1.0";
  definition.schemaVersion = "1.1.0";
  const callToAction = definition.home.sections.find(
    (section: any) => section.type === "callToAction",
  );
  callToAction.body = body;
  return definition;
}

describe("content schema recovery", () => {
  it("upgrades a verified legacy publication into a valid current draft base", () => {
    const legacy = legacyDefinition("Restored legacy release");

    const restored = upgradeSiteDefinitionForCurrentSchema(legacy);

    expect(restored).toEqual(
      expect.objectContaining({
        definitionVersion: "1.3.0",
        schemaVersion: "1.3.0",
        design: referenceSiteDefinition.design,
        home: expect.objectContaining({ media: [] }),
        site: expect.objectContaining({
          name: "Restored legacy release",
        }),
      }),
    );
    expect(
      restored.home.sections.every(
        ({ variant }) => typeof variant === "string",
      ),
    ).toBe(true);
  });

  it("carries a durable legacy edit relative to immutable revision zero", () => {
    expect(
      durableSchemaRecoveryEdits(
        legacyDefinition(),
        legacyDefinition("Saved legacy draft"),
      ),
    ).toEqual([
      {
        path: "site_foundry_reference.name",
        baseValue: "Foundry Reference",
        value: "Saved legacy draft",
      },
    ]);
  });

  it("adds current design defaults without treating them as legacy edits", () => {
    expect(
      durableSchemaRecoveryEdits(
        legacyDefinition(),
        legacyDefinition(),
      ),
    ).toEqual([]);
  });

  it("carries a durable rich-text edit from the stored design schema", () => {
    const [structural, richText] = durableSchemaRecoveryEdits(
      storedDesignDefinition("Saved design-schema body."),
      storedDesignDefinition("Updated design-schema body."),
    );
    const recoveredComposition = JSON.parse(structural!.value);
    const recoveredCallToAction = recoveredComposition.components.find(
      (component: any) => component.type === "callToAction",
    );

    expect(structural?.path).toBe("slot_home_sections");
    expect(recoveredCallToAction.body).toEqual(
      createRichTextDocumentFromPlainText(
        "Updated design-schema body.",
      ),
    );
    expect(richText).toEqual({
      path: "section_contact.body",
      format: "richText",
      baseValue: serializeRichTextDocument(
        createRichTextDocumentFromPlainText(
          "Saved design-schema body.",
        ),
      ),
      value: serializeRichTextDocument(
        createRichTextDocumentFromPlainText(
          "Updated design-schema body.",
        ),
      ),
    });
  });

  it("preserves a durable media replacement and crop for fresh-workspace migration", () => {
    const base = legacyDefinition();
    base.home.media = [
      {
        occurrenceId: "occurrence_home_hero",
        revision: 1,
        asset: {
          assetId: "asset_original",
          width: 1600,
          height: 900,
          contentType: "image/png",
        },
        crop: null,
      },
    ];
    const current = structuredClone(base);
    current.home.media = [
      {
        occurrenceId: "occurrence_home_hero",
        revision: 3,
        asset: {
          assetId: "asset_replacement",
          width: 1200,
          height: 800,
          contentType: "image/jpeg",
        },
        crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      },
    ];

    expect(durableSchemaRecoveryEdits(base, current)).toEqual([
      {
        path: mediaManifestRecoveryPath,
        baseValue: canonicalJson(base.home.media),
        value: canonicalJson(current.home.media),
      },
    ]);
  });

  it("recovers a legacy component removal independent of upgraded key order", () => {
    const base = legacyDefinition();
    base.home.sections.push({
      id: "section_legacy_extra",
      type: "proof",
      quote: "Remove this legacy section",
      attribution: "Legacy draft",
      metrics: [],
    });
    const current = structuredClone(base);
    current.home.sections = current.home.sections.filter(
      (section: any) => section.id !== "section_legacy_extra",
    );
    const [structural] = durableSchemaRecoveryEdits(base, current);
    const destination = structuredClone(referenceSiteDefinition) as any;
    destination.home.sections.push({
      id: "section_legacy_extra",
      type: "proof",
      variant: "panel",
      quote: "Remove this legacy section",
      attribution: "Legacy draft",
      metrics: [],
    });

    const recovered = applyStructuralRecovery(
      destination,
      structural!,
    );

    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(
        recovered.definition.home.sections.some(
          ({ id }) => id === "section_legacy_extra",
        ),
      ).toBe(false);
    }
  });

  it("layers an unsaved value over the durable three-way base", () => {
    expect(
      mergeDurableAndOutboxRecoveryEdits(
        [
          {
            path: "site_foundry_reference.name",
            baseValue: "Foundry Reference",
            value: "Saved legacy draft",
          },
        ],
        [
          {
            path: "site_foundry_reference.name",
            baseValue: "Saved legacy draft",
            value: "Pending browser draft",
          },
        ],
      ),
    ).toEqual([
      {
        path: "site_foundry_reference.name",
        baseValue: "Foundry Reference",
        value: "Pending browser draft",
      },
    ]);
  });

  it("adds registered variants to a legacy structural outbox edit", () => {
    const base = legacyDefinition();
    const added = {
      id: "section_unsaved_proof",
      type: "proof",
      quote: "Unsaved legacy proof",
      attribution: "Legacy editor",
      metrics: [],
    };
    const composition = (definition: any) =>
      JSON.stringify({
        slotId: "slot_home_sections",
        components: definition.home.sections,
      });
    const [recovered] = mergeDurableAndOutboxRecoveryEdits([], [
      {
        path: "slot_home_sections",
        baseValue: composition(base),
        value: JSON.stringify({
          slotId: "slot_home_sections",
          components: [...base.home.sections, added],
        }),
      },
    ]);

    expect(JSON.parse(recovered!.value).components.at(-1)).toEqual({
      ...added,
      variant: "panel",
    });
    expect(
      JSON.parse(recovered!.baseValue).components.every(
        (component: any) => typeof component.variant === "string",
      ),
    ).toBe(true);
  });

  it("rejects an unregistered structural outbox variant", () => {
    const base = legacyDefinition();
    expect(() =>
      mergeDurableAndOutboxRecoveryEdits([], [
        {
          path: "slot_home_sections",
          baseValue: JSON.stringify({
            slotId: "slot_home_sections",
            components: base.home.sections,
          }),
          value: JSON.stringify({
            slotId: "slot_home_sections",
            components: [
              {
                ...base.home.sections[0],
                variant: "arbitrary",
              },
            ],
          }),
        },
      ]),
    ).toThrow("unsupported_legacy_component_variant");
  });

  it("preserves a registered non-default structural outbox variant", () => {
    const base = legacyDefinition();
    const focusedHero = {
      ...base.home.sections[0],
      variant: "focused",
    };
    const [recovered] = mergeDurableAndOutboxRecoveryEdits([], [
      {
        path: "slot_home_sections",
        baseValue: JSON.stringify({
          slotId: "slot_home_sections",
          components: base.home.sections,
        }),
        value: JSON.stringify({
          slotId: "slot_home_sections",
          components: [focusedHero],
        }),
      },
    ]);

    expect(JSON.parse(recovered!.value).components[0].variant).toBe(
      "focused",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  designEditsForDesign,
  designPresets,
  referenceSiteDefinition,
  serializeRichTextDocument,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import {
  contentEditorReducer,
  contentEditorStatusLocked,
  createContentEditorState,
} from "./content-editor-history";

describe("content editor history", () => {
  it("applies a rich-text edit only when its format discriminator is preserved", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const body = {
      ...callToAction.body,
      children: [
        {
          type: "heading" as const,
          level: 3 as const,
          children: [
            {
              type: "text" as const,
              text: "Recovered rich heading",
              marks: ["bold" as const],
            },
          ],
        },
      ],
    };

    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: `${callToAction.id}.body`,
      format: "richText",
      value: serializeRichTextDocument(body),
    });
    const missingDiscriminator = contentEditorReducer(initial, {
      type: "edit",
      path: `${callToAction.id}.body`,
      value: serializeRichTextDocument(body),
    });

    expect(
      edited.workingDefinition.home.sections.find(
        (section) => section.id === callToAction.id,
      ),
    ).toEqual(expect.objectContaining({ body }));
    expect(missingDiscriminator).toBe(initial);
  });

  it("applies a preset's whole design as one undoable step", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const preset = designPresets.find(({ id }) => id === "gallery")!;

    const applied = contentEditorReducer(initial, {
      type: "editMany",
      edits: designEditsForDesign(
        referenceSiteDefinition.design,
        preset.design,
      ),
    });
    const undone = contentEditorReducer(applied, { type: "undo" });

    expect(applied.workingDefinition.design).toEqual(preset.design);
    expect(applied.status).toBe("dirty");
    expect(applied.past).toHaveLength(1);
    expect(undone.workingDefinition.design).toEqual(
      referenceSiteDefinition.design,
    );
    expect(undone.status).toBe("saved");
  });

  it("keeps the draft untouched when any edit in a batch is unregistered", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });

    const rejected = contentEditorReducer(initial, {
      type: "editMany",
      edits: [
        { path: "design.colour.accent", value: "clay" },
        { path: "design.colour.accent", value: "not-a-registered-colour" },
      ],
    });

    expect(rejected).toBe(initial);
  });

  it("ignores a batch that changes nothing", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });

    expect(contentEditorReducer(initial, { type: "editMany", edits: [] })).toBe(
      initial,
    );
  });

  it("locks mutation controls until a structural conflict is recovered", () => {
    expect(contentEditorStatusLocked("conflict")).toBe(true);
    expect(contentEditorStatusLocked("stale")).toBe(true);
    expect(contentEditorStatusLocked("saving")).toBe(true);
    expect(contentEditorStatusLocked("dirty")).toBe(false);
    expect(contentEditorStatusLocked("saved")).toBe(false);
  });

  it("undoes and redoes working copy without mutating the persisted revision", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: "section_hero.title",
      value: "Working headline",
    });
    const undone = contentEditorReducer(edited, { type: "undo" });
    const redone = contentEditorReducer(undone, { type: "redo" });

    expect(edited.persistedRevision).toBe(4);
    expect(undone.persistedRevision).toBe(4);
    expect(undone.workingDefinition).toEqual(referenceSiteDefinition);
    expect(redone.persistedRevision).toBe(4);
    expect(redone.workingDefinition.home.sections[0]).toEqual(
      expect.objectContaining({ title: "Working headline" }),
    );
  });

  it("undoes visual composition as one editor action", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const definition = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [...referenceSiteDefinition.home.sections].reverse(),
      },
    } as SiteDefinition;
    const composed = contentEditorReducer(initial, {
      type: "compose",
      definition,
    });
    const undone = contentEditorReducer(composed, { type: "undo" });

    expect(composed.workingDefinition.home.sections[0]?.id).toBe(
      "section_contact",
    );
    expect(composed.projectionVersion).toBe(initial.projectionVersion);
    expect(undone.projectionVersion).toBe(initial.projectionVersion + 1);
    expect(undone.workingDefinition).toEqual(referenceSiteDefinition);
    expect(undone.persistedRevision).toBe(4);
  });

  it("marks a semantically restored composition as saved", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const changed = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [...referenceSiteDefinition.home.sections].reverse(),
      },
    } as SiteDefinition;
    const dirty = contentEditorReducer(initial, {
      type: "compose",
      definition: changed,
    });
    const restored = contentEditorReducer(dirty, {
      type: "compose",
      definition: structuredClone(referenceSiteDefinition),
    });

    expect(restored.status).toBe("saved");
  });

  it("marks semantically persisted clones as saved after undo and redo", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const cloned = contentEditorReducer(initial, {
      type: "compose",
      definition: structuredClone(referenceSiteDefinition),
    });
    const edited = contentEditorReducer(cloned, {
      type: "edit",
      path: "section_hero.title",
      value: "Working headline",
    });
    const undoneToClone = contentEditorReducer(edited, { type: "undo" });
    const undoneToOriginal = contentEditorReducer(undoneToClone, {
      type: "undo",
    });
    const redoneToClone = contentEditorReducer(undoneToOriginal, {
      type: "redo",
    });

    expect(undoneToClone.status).toBe("saved");
    expect(redoneToClone.status).toBe("saved");
  });

  it("refreshes the Puck projection for externally recovered composition", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const recovered = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [...referenceSiteDefinition.home.sections].reverse(),
      },
    } as SiteDefinition;

    const next = contentEditorReducer(initial, {
      type: "compose",
      definition: recovered,
      refreshProjection: true,
    });

    expect(next.projectionVersion).toBe(initial.projectionVersion + 1);
  });

  it("can undo after save while preserving the newly persisted revision", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: "section_hero.title",
      value: "Saved headline",
    });
    const saved = contentEditorReducer(edited, {
      type: "saved",
      definition: edited.workingDefinition,
      revision: 5,
    });
    const undone = contentEditorReducer(saved, { type: "undo" });

    expect(undone.persistedRevision).toBe(5);
    expect(undone.persistedDefinition.home.sections[0]).toEqual(
      expect.objectContaining({ title: "Saved headline" }),
    );
    expect(undone.workingDefinition).toEqual(referenceSiteDefinition);
    expect(undone.status).toBe("dirty");
  });

  it("surfaces a stale production base as a distinct non-retry state", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const stale = contentEditorReducer(initial, {
      type: "failed",
      conflict: "stale",
      errors: {},
    });

    expect(stale.status).toBe("stale");
    expect(stale.persistedRevision).toBe(4);
  });

  it("shows the immutable revision acknowledged by a stale replay", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: "section_hero.title",
      value: "Saved before deployment changed",
    });
    const stale = contentEditorReducer(edited, {
      type: "failed",
      conflict: "stale",
      acknowledgedRevision: 5,
      errors: {},
    });

    expect(stale.status).toBe("stale");
    expect(stale.persistedRevision).toBe(5);
    expect(stale.workingDefinition).toBe(edited.workingDefinition);
    expect(stale.persistedDefinition).toBe(initial.persistedDefinition);
  });

  it("keeps a stale editor locked across edit, undo, and redo actions", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
    });
    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: "section_hero.title",
      value: "Unsaved headline",
    });
    const stale = contentEditorReducer(edited, {
      type: "failed",
      conflict: "stale",
      errors: {},
    });

    expect(
      contentEditorReducer(stale, {
        type: "edit",
        path: "section_hero.title",
        value: "Another headline",
      }),
    ).toBe(stale);
    expect(contentEditorReducer(stale, { type: "undo" })).toBe(stale);
    expect(contentEditorReducer(stale, { type: "redo" })).toBe(stale);
  });

  it("can initialize a reopened stale workspace as locked", () => {
    const stale = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 4,
      stale: true,
    });

    expect(stale.status).toBe("stale");
    expect(stale.persistedRevision).toBe(4);
  });

  it("advances a shared media revision head without discarding unsaved copy", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 1,
    });
    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: "section_hero.title",
      value: "Unsaved headline",
    });
    const definition = {
      ...structuredClone(referenceSiteDefinition),
      site: {
        ...structuredClone(referenceSiteDefinition.site),
        footer: "Concurrent footer",
      },
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        media: [
          {
            occurrenceId: "occurrence_home_hero" as const,
            revision: 1,
            asset: {
              assetId: "asset_hero",
              width: 1600,
              height: 900,
              contentType: "image/png" as const,
            },
            crop: null,
          },
        ],
      },
    };

    const synchronized = contentEditorReducer(edited, {
      type: "externalRevision",
      definition,
      revision: 2,
    });

    expect(synchronized.persistedRevision).toBe(2);
    expect(synchronized.workingDefinition.home.media).toEqual(
      definition.home.media,
    );
    expect(synchronized.workingDefinition.home.sections[0]).toMatchObject({
      title: "Unsaved headline",
    });
    expect(synchronized.workingDefinition.site.footer).toBe(
      "Concurrent footer",
    );
    expect(synchronized.status).toBe("dirty");
  });

  it("conflicts when an external media revision overlaps a local copy edit", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 1,
    });
    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: "section_hero.title",
      value: "Local headline",
    });
    const incoming = {
      ...structuredClone(referenceSiteDefinition),
      site: {
        ...structuredClone(referenceSiteDefinition.site),
        footer: "Concurrent footer",
      },
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        sections: referenceSiteDefinition.home.sections.map((section) =>
          section.id === "section_hero"
            ? { ...section, title: "Concurrent headline" }
            : section,
        ),
      },
    };

    const synchronized = contentEditorReducer(edited, {
      type: "externalRevision",
      definition: incoming,
      revision: 2,
    });

    expect(synchronized.persistedDefinition).toEqual(incoming);
    expect(synchronized.persistedRevision).toBe(2);
    expect(synchronized.workingDefinition.home.sections[0]).toEqual(
      expect.objectContaining({ title: "Local headline" }),
    );
    expect(synchronized.status).toBe("conflict");
    expect(synchronized.errors).toEqual({
      "section_hero.title":
        "This field changed elsewhere. Reload latest to reconcile your unsaved value.",
    });
  });

  it("preserves a local field edit when the incoming revision removes its section", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 1,
    });
    const edited = contentEditorReducer(initial, {
      type: "edit",
      path: "section_hero.title",
      value: "Local headline",
    });
    const incoming = {
      ...structuredClone(referenceSiteDefinition),
      site: {
        ...structuredClone(referenceSiteDefinition.site),
        footer: "Concurrent footer",
      },
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        sections: referenceSiteDefinition.home.sections.filter(
          (section) => section.id !== "section_hero",
        ),
      },
    };

    const synchronized = contentEditorReducer(edited, {
      type: "externalRevision",
      definition: incoming,
      revision: 2,
    });

    expect(synchronized.status).toBe("conflict");
    expect(
      synchronized.persistedDefinition.home.sections.some(
        (section) => section.id === "section_hero",
      ),
    ).toBe(false);
    expect(synchronized.workingDefinition.home.sections[0]).toEqual(
      expect.objectContaining({
        id: "section_hero",
        title: "Local headline",
      }),
    );
    expect(synchronized.workingDefinition.site.footer).toBe(
      "Concurrent footer",
    );
  });

  it("conflicts when a locally removed section is edited externally", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 1,
    });
    const locallyRemoved = {
      ...structuredClone(referenceSiteDefinition),
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        sections: referenceSiteDefinition.home.sections.filter(
          (section) => section.id !== "section_hero",
        ),
      },
    };
    const edited = contentEditorReducer(initial, {
      type: "compose",
      definition: locallyRemoved,
    });
    const incoming = {
      ...structuredClone(referenceSiteDefinition),
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        sections: referenceSiteDefinition.home.sections.map((section) =>
          section.id === "section_hero"
            ? { ...section, title: "Concurrent headline" }
            : section,
        ),
      },
    };

    const synchronized = contentEditorReducer(edited, {
      type: "externalRevision",
      definition: incoming,
      revision: 2,
    });

    expect(synchronized.status).toBe("conflict");
    expect(
      synchronized.workingDefinition.home.sections.some(
        (section) => section.id === "section_hero",
      ),
    ).toBe(false);
    expect(synchronized.persistedDefinition.home.sections[0]).toEqual(
      expect.objectContaining({
        id: "section_hero",
        title: "Concurrent headline",
      }),
    );
  });

  it("advances a shared media revision without discarding unsaved composition", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 1,
    });
    const reordered = {
      ...structuredClone(referenceSiteDefinition),
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        sections: [...referenceSiteDefinition.home.sections].reverse(),
      },
    };
    const edited = contentEditorReducer(initial, {
      type: "compose",
      definition: reordered,
    });
    const incoming = {
      ...structuredClone(referenceSiteDefinition),
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        sections: referenceSiteDefinition.home.sections.map((section) =>
          section.id === "section_services"
            ? { ...section, title: "Concurrent services title" }
            : section,
        ),
        media: [
          {
            occurrenceId: "occurrence_home_hero" as const,
            revision: 1,
            asset: {
              assetId: "asset_hero",
              width: 1600,
              height: 900,
              contentType: "image/png" as const,
            },
            crop: null,
          },
        ],
      },
    };

    const synchronized = contentEditorReducer(edited, {
      type: "externalRevision",
      definition: incoming,
      revision: 2,
    });

    expect(
      synchronized.workingDefinition.home.sections.map(({ id }) => id),
    ).toEqual(reordered.home.sections.map(({ id }) => id));
    expect(synchronized.workingDefinition.home.media).toEqual(
      incoming.home.media,
    );
    expect(
      synchronized.workingDefinition.home.sections.find(
        ({ id }) => id === "section_services",
      ),
    ).toMatchObject({ title: "Concurrent services title" });
    expect(synchronized.persistedDefinition).toEqual(incoming);
    expect(synchronized.status).toBe("dirty");
  });

  it.each(["addition", "removal"] as const)(
    "surfaces a conflict for concurrent structural %s",
    (incomingChange) => {
      const initial = createContentEditorState({
        definition: referenceSiteDefinition,
        revision: 1,
      });
      const locallyReordered = {
        ...structuredClone(referenceSiteDefinition),
        home: {
          ...structuredClone(referenceSiteDefinition.home),
          sections: [...referenceSiteDefinition.home.sections].reverse(),
        },
      };
      const edited = contentEditorReducer(initial, {
        type: "compose",
        definition: locallyReordered,
      });
      const incomingSections =
        incomingChange === "addition"
          ? [
              ...referenceSiteDefinition.home.sections,
              {
                ...structuredClone(referenceSiteDefinition.home.sections[0]!),
                id: "section_concurrent_hero",
              },
            ]
          : referenceSiteDefinition.home.sections.slice(1);
      const incoming = {
        ...structuredClone(referenceSiteDefinition),
        home: {
          ...structuredClone(referenceSiteDefinition.home),
          sections: incomingSections,
        },
      } as SiteDefinition;

      const synchronized = contentEditorReducer(edited, {
        type: "externalRevision",
        definition: incoming,
        revision: 2,
      });

      expect(synchronized.persistedDefinition).toEqual(incoming);
      expect(synchronized.status).toBe("conflict");
      expect(synchronized.errors).toHaveProperty("slot_home_sections");
      expect(
        contentEditorReducer(synchronized, {
          type: "compose",
          definition: referenceSiteDefinition,
        }),
      ).toBe(synchronized);
    },
  );

  it("adopts all concurrent fields when a clean editor receives a media revision", () => {
    const initial = createContentEditorState({
      definition: referenceSiteDefinition,
      revision: 1,
    });
    const incoming = {
      ...structuredClone(referenceSiteDefinition),
      site: {
        ...structuredClone(referenceSiteDefinition.site),
        footer: "Concurrent footer",
      },
      home: {
        ...structuredClone(referenceSiteDefinition.home),
        media: [],
      },
    };

    const synchronized = contentEditorReducer(initial, {
      type: "externalRevision",
      definition: incoming,
      revision: 2,
    });

    expect(synchronized.persistedDefinition).toEqual(incoming);
    expect(synchronized.workingDefinition).toEqual(incoming);
    expect(synchronized.status).toBe("saved");
  });
});

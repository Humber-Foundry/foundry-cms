import { describe, expect, it } from "vitest";

import {
  referenceSiteDefinition,
  type SiteDefinition,
} from "@foundry/site-definition";

import {
  contentEditorReducer,
  createContentEditorState,
} from "./content-editor-history";

describe("content editor history", () => {
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
    expect(undone.workingDefinition).toEqual(referenceSiteDefinition);
    expect(undone.persistedRevision).toBe(4);
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
});

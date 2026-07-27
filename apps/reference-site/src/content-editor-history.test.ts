import { describe, expect, it } from "vitest";

import { referenceSiteDefinition } from "@foundry/site-definition";

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
});

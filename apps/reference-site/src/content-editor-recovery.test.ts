import { describe, expect, it } from "vitest";

import {
  consumeStaleEdits,
  preserveStaleEdits,
} from "./content-editor-recovery";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("stale edit recovery", () => {
  it("transfers unsaved edits once to a fresh workspace", () => {
    const storage = createStorage();
    const edits = [
      { path: "section_hero.title", value: "Still here after deployment" },
    ];

    preserveStaleEdits(storage, edits);

    expect(consumeStaleEdits(storage)).toEqual(edits);
    expect(consumeStaleEdits(storage)).toEqual([]);
  });

  it("discards malformed recovery data", () => {
    const storage = createStorage();
    storage.setItem("foundry-cms:stale-edit-recovery", '{"path": true}');

    expect(consumeStaleEdits(storage)).toEqual([]);
    expect(consumeStaleEdits(storage)).toEqual([]);
  });
});

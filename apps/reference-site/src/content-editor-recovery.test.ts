import { describe, expect, it } from "vitest";

import {
  clearStaleEdits,
  preserveStaleEdits,
  recoverStaleEdits,
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
  it("retains matching unsaved edits until the fresh revision is saved", () => {
    const storage = createStorage();
    const edits = [
      { path: "section_hero.title", value: "Still here after deployment" },
    ];
    preserveStaleEdits(storage, "recovery-1", "workspace-first", edits);

    expect(
      recoverStaleEdits(
        storage,
        "recovery-1",
        "workspace-first",
        new Set(["section_hero.title"]),
      ),
    ).toEqual({ available: true, recovered: edits, unmatched: [] });
    expect(
      recoverStaleEdits(
        storage,
        "recovery-1",
        "workspace-first",
        new Set(["section_hero.title"]),
      ),
    ).toEqual({ available: true, recovered: edits, unmatched: [] });
    expect(
      clearStaleEdits(storage, "recovery-1", "workspace-first"),
    ).toBe(true);
    expect(
      recoverStaleEdits(
        storage,
        "recovery-1",
        "workspace-first",
        new Set(["section_hero.title"]),
      ),
    ).toEqual({ available: true, recovered: [], unmatched: [] });
  });

  it("keeps renamed fields available as explicit conflicts", () => {
    const storage = createStorage();
    const removed = [{ path: "section_old.title", value: "Preserve me" }];
    preserveStaleEdits(
      storage,
      "recovery-removed",
      "workspace-old",
      removed,
    );

    expect(
      recoverStaleEdits(
        storage,
        "recovery-removed",
        "workspace-old",
        new Set(["section_new.title"]),
      ),
    ).toEqual({ available: true, recovered: [], unmatched: removed });
    expect(
      recoverStaleEdits(
        storage,
        "recovery-removed",
        "workspace-old",
        new Set(["section_new.title"]),
      ),
    ).toEqual({ available: true, recovered: [], unmatched: removed });
  });

  it("fails safely when browser storage is unavailable", () => {
    const blockedStorage = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    expect(
      preserveStaleEdits(
        blockedStorage,
        "recovery-blocked",
        "workspace-blocked",
        [{ path: "section_hero.title", value: "Safe" }],
      ),
    ).toBe(false);
    expect(
      recoverStaleEdits(
        blockedStorage,
        "recovery-blocked",
        "workspace-blocked",
        new Set(["section_hero.title"]),
      ),
    ).toEqual({ available: false, recovered: [], unmatched: [] });
    expect(
      clearStaleEdits(
        blockedStorage,
        "recovery-blocked",
        "workspace-blocked",
      ),
    ).toBe(false);
  });

  it("isolates simultaneous recoveries by workspace and one-time id", () => {
    const storage = createStorage();
    const first = [{ path: "section_hero.title", value: "First tab" }];
    const second = [{ path: "section_hero.title", value: "Second tab" }];
    preserveStaleEdits(storage, "recovery-a", "workspace-a", first);
    preserveStaleEdits(storage, "recovery-b", "workspace-b", second);

    expect(
      recoverStaleEdits(
        storage,
        "recovery-b",
        "workspace-b",
        new Set(["section_hero.title"]),
      ).recovered,
    ).toEqual(second);
    expect(
      recoverStaleEdits(
        storage,
        "recovery-a",
        "workspace-a",
        new Set(["section_hero.title"]),
      ).recovered,
    ).toEqual(first);
  });
});

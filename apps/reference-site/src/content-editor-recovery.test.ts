import { describe, expect, it } from "vitest";

import {
  clearStaleEdits,
  mergeStaleRecoveryEdits,
  preserveStaleEdits,
  recoveryToForward,
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

const edit = {
  path: "section_hero.title",
  baseValue: "Original title",
  value: "My unsaved title",
};

describe("stale edit recovery", () => {
  it("forwards an active recovery when its destination later becomes stale", () => {
    const active = {
      id: "recovery-chain",
      sourceWorkspaceId: "workspace-original",
    };

    expect(recoveryToForward(false, active)).toBeUndefined();
    expect(recoveryToForward(true, active)).toBe(active);
  });

  it("merges intermediate edits into a forwarded recovery chain", () => {
    const storage = createStorage();
    const recovered = {
      ...edit,
      value: "Recovered title",
    };
    const changedAgain = {
      ...recovered,
      value: "Edited again before stale",
      baseValue: "Destination title",
    };
    const added = {
      path: "page_home.seo.title",
      value: "New SEO title",
      baseValue: "Old SEO title",
    };

    const merged = mergeStaleRecoveryEdits(
      [recovered],
      [changedAgain, added],
    );
    expect(merged).toEqual([
      {
        ...changedAgain,
        baseValue: edit.baseValue,
      },
      added,
    ]);
    expect(
      preserveStaleEdits(
        storage,
        "recovery-chain",
        "workspace-original",
        merged,
      ),
    ).toBe(true);
    expect(
      recoverStaleEdits(
        storage,
        "recovery-chain",
        "workspace-original",
        new Map([
          [changedAgain.path, edit.baseValue],
          [added.path, added.baseValue],
        ]),
      ).recovered,
    ).toEqual(merged);
  });

  it("retains and auto-applies a non-overlapping edit until save", () => {
    const storage = createStorage();
    preserveStaleEdits(storage, "recovery-1", "workspace-first", [edit]);
    const destination = new Map([[edit.path, edit.baseValue]]);

    expect(
      recoverStaleEdits(
        storage,
        "recovery-1",
        "workspace-first",
        destination,
      ),
    ).toEqual({ available: true, recovered: [edit], conflicts: [] });
    expect(
      recoverStaleEdits(
        storage,
        "recovery-1",
        "workspace-first",
        destination,
      ),
    ).toEqual({ available: true, recovered: [edit], conflicts: [] });
    expect(
      clearStaleEdits(storage, "recovery-1", "workspace-first"),
    ).toBe(true);
    expect(
      recoverStaleEdits(
        storage,
        "recovery-1",
        "workspace-first",
        destination,
      ),
    ).toEqual({ available: true, recovered: [], conflicts: [] });
  });

  it("surfaces a same-path concurrent change as a three-way conflict", () => {
    const storage = createStorage();
    preserveStaleEdits(storage, "recovery-overlap", "workspace-shared", [edit]);

    expect(
      recoverStaleEdits(
        storage,
        "recovery-overlap",
        "workspace-shared",
        new Map([[edit.path, "Collaborator's newer title"]]),
      ),
    ).toEqual({
      available: true,
      recovered: [],
      conflicts: [
        {
          ...edit,
          currentValue: "Collaborator's newer title",
          reason: "changed",
        },
      ],
    });
  });

  it("keeps renamed fields available as explicit conflicts", () => {
    const storage = createStorage();
    const removed = {
      path: "section_old.title",
      baseValue: "Old title",
      value: "Preserve me",
    };
    preserveStaleEdits(
      storage,
      "recovery-removed",
      "workspace-old",
      [removed],
    );

    expect(
      recoverStaleEdits(
        storage,
        "recovery-removed",
        "workspace-old",
        new Map([["section_new.title", "New title"]]),
      ),
    ).toEqual({
      available: true,
      recovered: [],
      conflicts: [
        { ...removed, currentValue: null, reason: "missing" },
      ],
    });
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
        [edit],
      ),
    ).toBe(false);
    expect(
      recoverStaleEdits(
        blockedStorage,
        "recovery-blocked",
        "workspace-blocked",
        new Map([[edit.path, edit.baseValue]]),
      ),
    ).toEqual({ available: false, recovered: [], conflicts: [] });
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
    const first = { ...edit, value: "First tab" };
    const second = { ...edit, value: "Second tab" };
    preserveStaleEdits(storage, "recovery-a", "workspace-a", [first]);
    preserveStaleEdits(storage, "recovery-b", "workspace-b", [second]);
    const destination = new Map([[edit.path, edit.baseValue]]);

    expect(
      recoverStaleEdits(
        storage,
        "recovery-b",
        "workspace-b",
        destination,
      ).recovered,
    ).toEqual([second]);
    expect(
      recoverStaleEdits(
        storage,
        "recovery-a",
        "workspace-a",
        destination,
      ).recovered,
    ).toEqual([first]);
  });
});

import { describe, expect, it } from "vitest";

import {
  createDefaultPageSection,
  referenceSiteDefinition,
  serializeRichTextDocument,
  toPageComposition,
  toPageCompositionIdentity,
} from "@foundry/site-definition";

import {
  applyStructuralRecovery,
  comparableRecoveryValue,
  clearStaleEdits,
  excludeCompositionOwnedEdits,
  mergeRecoverySources,
  mergeStaleRecoveryEdits,
  preserveStaleEdits,
  recoveryToForward,
  recoverStaleEdits,
  resolveStructuralRecovery,
  synchronizeStaleEdits,
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
  it("preserves the rich-text discriminator through durable recovery", () => {
    const storage = createStorage();
    const callToAction = referenceSiteDefinition.home.sections.find(
      (section) => section.type === "callToAction",
    )!;
    if (callToAction.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const baseValue = serializeRichTextDocument(callToAction.body);
    const value = serializeRichTextDocument({
      ...callToAction.body,
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              text: "Recovered safely",
              marks: ["italic"],
            },
          ],
        },
      ],
    });
    const richEdit = {
      path: `${callToAction.id}.body`,
      format: "richText" as const,
      baseValue,
      value,
    };

    expect(
      preserveStaleEdits(storage, "rich-recovery", "workspace-old", [
        richEdit,
      ]),
    ).toBe(true);
    expect(
      recoverStaleEdits(
        storage,
        "rich-recovery",
        "workspace-old",
        new Map([[richEdit.path, baseValue]]),
      ).recovered,
    ).toEqual([richEdit]);
  });

  it("upgrades a legacy plain CTA recovery record before comparison", () => {
    const storage = createStorage();
    const legacyEdit = {
      path: "section_contact.body",
      baseValue:
        "Bring the rough notes, the constraints, and the thing that still feels unresolved. That is enough to start.",
      value: "Recovered from a pre-rich-text browser outbox.",
    };
    preserveStaleEdits(
      storage,
      "legacy-rich-recovery",
      "workspace-old",
      [legacyEdit],
    );
    const currentBody = serializeRichTextDocument(
      referenceSiteDefinition.home.sections[3]!.body,
    );

    const result = recoverStaleEdits(
      storage,
      "legacy-rich-recovery",
      "workspace-old",
      new Map([[legacyEdit.path, currentBody]]),
      new Set([legacyEdit.path]),
    );

    expect(result.conflicts).toEqual([]);
    expect(result.recovered).toEqual([
      {
        path: legacyEdit.path,
        format: "richText",
        baseValue: currentBody,
        value: expect.stringContaining(
          "Recovered from a pre-rich-text browser outbox.",
        ),
      },
    ]);
  });

  it("compares a structural command by stable composition identity", () => {
    expect(
      comparableRecoveryValue({
        path: "slot_home_sections",
        baseValue: "",
        value: JSON.stringify({
          slotId: "slot_home_sections",
          components: [
            {
              ...referenceSiteDefinition.home.sections[0],
              title: "Copy already saved by another attempt",
            },
          ],
        }),
      }),
    ).toBe(
      JSON.stringify({
        slotId: "slot_home_sections",
        components: [
          {
            id: referenceSiteDefinition.home.sections[0]!.id,
            type: referenceSiteDefinition.home.sections[0]!.type,
          },
        ],
      }),
    );
  });

  it("acknowledges stale-workspace edits already present at the destination", () => {
    const storage = createStorage();
    expect(
      preserveStaleEdits(storage, "already-applied", "workspace-old", [
        edit,
      ]),
    ).toBe(true);

    expect(
      recoverStaleEdits(
        storage,
        "already-applied",
        "workspace-old",
        new Map([[edit.path, edit.value]]),
      ),
    ).toEqual({
      available: true,
      recovered: [],
      conflicts: [],
    });
  });

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
      new Set(),
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

  it("merges disjoint durable recovery sources before forwarding", () => {
    const fromOutbox = {
      ...edit,
      value: "Recovered from IndexedDB",
    };
    const fromStaleWorkspace = {
      path: "page_home.seo.title",
      value: "Recovered from local storage",
      baseValue: "Old SEO title",
    };

    expect(
      mergeRecoverySources([fromOutbox], [fromStaleWorkspace]),
    ).toEqual([fromOutbox, fromStaleWorkspace]);
    expect(
      mergeRecoverySources(
        [edit],
        [{ ...edit, value: "Edited again in the next workspace" }],
      ),
    ).toEqual([
      {
        ...edit,
        value: "Edited again in the next workspace",
      },
    ]);
  });

  it("does not resurrect a recovered edit reverted before another stale hop", () => {
    expect(mergeStaleRecoveryEdits([edit], [], new Set())).toEqual([]);
  });

  it("retains unresolved conflicts that are absent from the current delta", () => {
    expect(
      mergeStaleRecoveryEdits([edit], [], new Set([edit.path])),
    ).toEqual([edit]);
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

  it("preserves one canonical structural slot command for stale recovery", () => {
    const storage = createStorage();
    const composition = {
      path: "slot_home_sections",
      baseValue: JSON.stringify({
        slotId: "slot_home_sections",
        components: [{ id: "section_hero", type: "hero" }],
      }),
      value: JSON.stringify({
        slotId: "slot_home_sections",
        components: [
          { id: "section_hero", type: "hero" },
          { id: "section_proof", type: "proof" },
        ],
      }),
    };
    preserveStaleEdits(
      storage,
      "recovery-structure",
      "workspace-first",
      [composition],
    );

    expect(
      recoverStaleEdits(
        storage,
        "recovery-structure",
        "workspace-first",
        new Map([[composition.path, composition.baseValue]]),
      ).recovered,
    ).toEqual([composition]);
  });

  it("does not duplicate fields already owned by a structural recovery command", () => {
    const section = createDefaultPageSection(
      "callToAction",
      "section_new_contact",
    );
    if (section.type !== "callToAction") {
      throw new Error("expected_call_to_action_fixture");
    }
    const edits = [
      {
        path: "section_new_contact.title",
        baseValue: "",
        value: section.title,
      },
      {
        path: "section_new_contact_action.label",
        baseValue: "",
        value: section.action.label,
      },
      {
        path: "page_home.seo.title",
        baseValue: "Old",
        value: "New",
      },
    ];

    expect(excludeCompositionOwnedEdits(edits, [section])).toEqual([
      edits[2],
    ]);
  });

  it("uses one fail-closed structural recovery path", () => {
    const edit = {
      path: "slot_home_sections",
      baseValue: "",
      value: JSON.stringify(toPageComposition(referenceSiteDefinition)),
    };

    expect(
      applyStructuralRecovery(referenceSiteDefinition, edit),
    ).toEqual({
      ok: true,
      definition: referenceSiteDefinition,
    });
    expect(
      applyStructuralRecovery(referenceSiteDefinition, {
        ...edit,
        value: "{malformed",
      }),
    ).toEqual({ ok: false });
  });

  it("retains a recovered structural edit as a conflict when revalidation fails", () => {
    const currentValue = JSON.stringify(
      toPageComposition(referenceSiteDefinition),
    );
    const composition = toPageComposition(referenceSiteDefinition);
    const edit = {
      path: "slot_home_sections",
      baseValue: currentValue,
      value: JSON.stringify({
        ...composition,
        components: composition.components.filter(
          ({ id }) => id !== "section_contact",
        ),
      }),
    };

    expect(
      resolveStructuralRecovery(
        referenceSiteDefinition,
        edit,
        currentValue,
      ),
    ).toEqual({
      ok: false,
      conflict: {
        ...edit,
        currentValue,
        reason: "changed",
      },
    });
  });

  it("recovers structure without overwriting disjoint concurrent copy", () => {
    const sourceComposition = toPageComposition(referenceSiteDefinition);
    const reordered = {
      ...sourceComposition,
      components: [...sourceComposition.components].reverse(),
    };
    const edit = {
      path: "slot_home_sections",
      baseValue: JSON.stringify(
        toPageCompositionIdentity(referenceSiteDefinition),
      ),
      value: JSON.stringify(reordered),
    };
    const concurrent = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [
          {
            ...referenceSiteDefinition.home.sections[0]!,
            title: "Concurrent headline",
          },
          ...referenceSiteDefinition.home.sections.slice(1),
        ],
      },
    };
    const storage = createStorage();
    preserveStaleEdits(
      storage,
      "recovery-disjoint-copy",
      "workspace-disjoint-copy",
      [edit],
    );
    const recovered = recoverStaleEdits(
      storage,
      "recovery-disjoint-copy",
      "workspace-disjoint-copy",
      new Map([
        [
          edit.path,
          JSON.stringify(toPageCompositionIdentity(concurrent)),
        ],
      ]),
    );
    const result = applyStructuralRecovery(concurrent, edit);

    expect(recovered.conflicts).toEqual([]);
    expect(recovered.recovered).toEqual([edit]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.home.sections[0]?.id).toBe(
        "section_contact",
      );
      const hero = result.definition.home.sections.find(
        ({ id }) => id === "section_hero",
      );
      expect(hero?.type === "hero" ? hero.title : undefined).toBe(
        "Concurrent headline",
      );
    }
  });

  it("rejects removal of a component with concurrent copy changes", () => {
    const sourceComposition = toPageComposition(referenceSiteDefinition);
    const edit = {
      path: "slot_home_sections",
      baseValue: JSON.stringify(sourceComposition),
      value: JSON.stringify({
        ...sourceComposition,
        components: sourceComposition.components.filter(
          ({ id }) => id !== "section_hero",
        ),
      }),
    };
    const concurrent = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [
          {
            ...referenceSiteDefinition.home.sections[0]!,
            title: "Concurrent headline that must survive",
          },
          ...referenceSiteDefinition.home.sections.slice(1),
        ],
      },
    };

    expect(applyStructuralRecovery(concurrent, edit)).toEqual({
      ok: false,
    });
  });

  it("preserves a component added after the structural recovery baseline", () => {
    const sourceComposition = toPageComposition(referenceSiteDefinition);
    const edit = {
      path: "slot_home_sections",
      baseValue: JSON.stringify(sourceComposition),
      value: JSON.stringify({
        ...sourceComposition,
        components: [...sourceComposition.components].reverse(),
      }),
    };
    const concurrentAddition = createDefaultPageSection(
      "proof",
      "section_concurrent_proof",
      referenceSiteDefinition,
    );
    const concurrent = {
      ...referenceSiteDefinition,
      home: {
        ...referenceSiteDefinition.home,
        sections: [
          ...referenceSiteDefinition.home.sections,
          concurrentAddition,
        ],
      },
    };

    const result = applyStructuralRecovery(concurrent, edit);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.home.sections.map(({ id }) => id)).toEqual([
        "section_contact",
        "section_proof",
        "section_services",
        "section_hero",
        "section_concurrent_proof",
      ]);
    }
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
    expect(
      synchronizeStaleEdits(
        blockedStorage,
        "recovery-blocked",
        "workspace-blocked",
        [edit],
      ),
    ).toBe(false);
    expect(
      synchronizeStaleEdits(
        blockedStorage,
        "recovery-blocked",
        "workspace-blocked",
        [],
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

import { describe, expect, it } from "vitest";

import {
  applyPageComposition,
  findPageById,
  homePage,
  pageCompositionSlotId,
  toPageComposition,
  toPageCompositionIdentity,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import { installedPageComponentRegistry } from "../foundry/page-components";
import {
  definitionToPuckData,
  pageCompositionChanged,
  puckDataToDefinition,
} from "./page-composition-puck";
import {
  applyStructuralRecovery,
  planStructuralFirstRecovery,
  type StaleRecoveryEdit,
} from "./content-editor-recovery";
import { durableSchemaRecoveryEdits } from "./content-schema-recovery";
import { contentEditorReducer, createContentEditorState } from "./content-editor-history";
import {
  secondPageId,
  secondPageSectionId,
  withSecondPage,
} from "./test-support/two-page-site-definition";

/**
 * The hard boundary of ticket #158: an edit made on one page must never change
 * another page.
 *
 * Every area the editor is built from is checked here on a two-page draft —
 * the canvas projection, the undo history, the draft recovery and the schema
 * recovery. The used-photo scan already reads every page, and is checked in
 * `site-used-photos.test.ts`. The reference installation has one page
 * and creating a page is ticket #159, so the second page comes from the shared
 * test fixture. See ADR-0032.
 */

const twoPages = withSecondPage();
const home = homePage(twoPages);
const second = findPageById(twoPages, secondPageId)!;
const registry = installedPageComponentRegistry;

/** The sections of one page, as a value two drafts can be compared by. */
function sectionsOf(definition: SiteDefinition, pageId: string): string {
  return JSON.stringify(findPageById(definition, pageId)?.sections);
}

describe("the canvas projection reads and writes one page", () => {
  it("draws the sections of the page it was given, and no other page's", () => {
    const drawn = definitionToPuckData(second, registry);
    expect(drawn.content.map((item) => item.props.id)).toEqual([
      secondPageSectionId,
    ]);

    const drawnHome = definitionToPuckData(home, registry);
    expect(drawnHome.content.map((item) => item.props.id)).not.toContain(
      secondPageSectionId,
    );
    expect(drawnHome.content.length).toBeGreaterThan(1);
  });

  it("removes a section from the page being edited and leaves the other page whole", () => {
    // The second page's only section is duplicated first, because a page must
    // keep at least one section.
    const drawn = definitionToPuckData(second, registry);
    const twice = {
      ...drawn,
      content: [
        drawn.content[0]!,
        {
          ...drawn.content[0]!,
          props: {
            ...drawn.content[0]!.props,
            id: `${secondPageSectionId}_copy`,
            metrics: [],
          },
        },
      ],
    };

    const added = puckDataToDefinition(twoPages, second, twice, registry);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    expect(
      findPageById(added.definition, secondPageId)!.sections.map(({ id }) => id),
    ).toEqual([secondPageSectionId, `${secondPageSectionId}_copy`]);
    // The home page is byte-for-byte what it was.
    expect(sectionsOf(added.definition, home.id)).toBe(
      sectionsOf(twoPages, home.id),
    );
  });

  it("reorders the page being edited without touching the other page", () => {
    const drawnHome = definitionToPuckData(home, registry);
    const reversed = { ...drawnHome, content: [...drawnHome.content].reverse() };

    const moved = puckDataToDefinition(twoPages, home, reversed, registry);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    expect(
      findPageById(moved.definition, home.id)!.sections.map(({ id }) => id),
    ).toEqual([...home.sections].reverse().map(({ id }) => id));
    expect(sectionsOf(moved.definition, secondPageId)).toBe(
      sectionsOf(twoPages, secondPageId),
    );
  });

  it("refuses a composition whose slot names a different page", () => {
    // The guard that keeps two pages apart: a composition carries the slot id
    // of the page it was built for, and the domain refuses to write it onto
    // any other page. This is what protects a stored recovery record and an
    // API request, which both arrive with a slot id of their own.
    const refused = applyPageComposition(
      twoPages,
      second,
      toPageComposition(home),
      registry,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(Object.keys(refused.errors)).toEqual([
      pageCompositionSlotId(home),
    ]);

    const accepted = applyPageComposition(
      twoPages,
      home,
      toPageComposition(home),
      registry,
    );
    expect(accepted.ok).toBe(true);
  });

  it("leaves the other page whole even when the canvas submits foreign sections", () => {
    // Sections that came from the home page are submitted as the second
    // page's. Whatever the domain decides about the second page, the home page
    // must read exactly as it did.
    const drawnHome = definitionToPuckData(home, registry);
    const result = puckDataToDefinition(twoPages, second, drawnHome, registry);
    if (result.ok) {
      expect(sectionsOf(result.definition, home.id)).toBe(
        sectionsOf(twoPages, home.id),
      );
    }
  });

  it("reports a structural change on the page it changed, and not on the other", () => {
    const drawn = definitionToPuckData(home, registry);
    const reversed = { ...drawn, content: [...drawn.content].reverse() };
    const moved = puckDataToDefinition(twoPages, home, reversed, registry);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    expect(
      pageCompositionChanged(home, findPageById(moved.definition, home.id)),
    ).toBe(true);
    expect(
      pageCompositionChanged(second, findPageById(moved.definition, secondPageId)),
    ).toBe(false);
  });
});

describe("a stored recovery record restores to the page it was made on", () => {
  /** The stored record for reversing one page's sections. */
  function reverseRecord(pageId: string): StaleRecoveryEdit {
    const page = findPageById(twoPages, pageId)!;
    const composition = toPageComposition(page);
    return {
      path: pageCompositionSlotId(page),
      baseValue: JSON.stringify(composition),
      value: JSON.stringify({
        ...composition,
        components: [...composition.components].reverse(),
      }),
    };
  }

  it("restores a second page's record to the second page alone", () => {
    const twiceSecond = withSecondPage({
      sections: [
        second.sections[0]!,
        { ...second.sections[0]!, id: `${secondPageSectionId}_two` },
      ],
    });
    const page = findPageById(twiceSecond, secondPageId)!;
    const composition = toPageComposition(page);
    const record: StaleRecoveryEdit = {
      path: pageCompositionSlotId(page),
      baseValue: JSON.stringify(composition),
      value: JSON.stringify({
        ...composition,
        components: [...composition.components].reverse(),
      }),
    };

    const restored = applyStructuralRecovery(twiceSecond, record);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(
      findPageById(restored.definition, secondPageId)!.sections.map(
        ({ id }) => id,
      ),
    ).toEqual([`${secondPageSectionId}_two`, secondPageSectionId]);
    expect(sectionsOf(restored.definition, home.id)).toBe(
      sectionsOf(twiceSecond, home.id),
    );
  });

  // A record written before a site could hold more than one page carries
  // `slot_home_sections`. It must still restore, and still to the home page.
  it("restores a record stored under the old home-only slot id", () => {
    const record = reverseRecord(home.id);
    expect(record.path).toBe("slot_home_sections");

    const restored = applyStructuralRecovery(twoPages, record);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(
      findPageById(restored.definition, home.id)!.sections.map(({ id }) => id),
    ).toEqual([...home.sections].reverse().map(({ id }) => id));
    expect(sectionsOf(restored.definition, secondPageId)).toBe(
      sectionsOf(twoPages, secondPageId),
    );
  });

  it("refuses a record whose page the draft no longer holds", () => {
    const record = reverseRecord(secondPageId);
    // The draft is back to one page: the record names a page that is gone.
    const restored = applyStructuralRecovery(
      { ...twoPages, pages: [home] },
      record,
    );
    expect(restored.ok).toBe(false);
  });

  it("offers every page's own structure to compare a record against", () => {
    const { destinationValues } = planStructuralFirstRecovery(twoPages, []);
    for (const page of twoPages.pages) {
      expect(destinationValues.get(pageCompositionSlotId(page))).toBe(
        JSON.stringify(toPageCompositionIdentity(page, registry)),
      );
    }
    // The two pages are told apart, so one page's record can never match the
    // other page's structure by accident.
    expect(destinationValues.get(pageCompositionSlotId(home))).not.toBe(
      destinationValues.get(pageCompositionSlotId(second)),
    );
  });
});

describe("schema recovery keeps each page's structural change apart", () => {
  it("writes a second page's structural change under the second page's slot", () => {
    const changed = withSecondPage({
      sections: [
        second.sections[0]!,
        { ...second.sections[0]!, id: `${secondPageSectionId}_extra` },
      ],
    });

    const edits = durableSchemaRecoveryEdits(twoPages, changed);
    const structural = edits.filter(({ path }) => path.startsWith("slot_"));
    expect(structural.map(({ path }) => path)).toEqual([
      pageCompositionSlotId(second),
    ]);
    expect(structural[0]!.path).not.toBe("slot_home_sections");
  });
});

describe("the undo history covers every page", () => {
  it("keeps an unsaved section change on a page the owner is not looking at", () => {
    const locallyChanged = withSecondPage({
      sections: [
        second.sections[0]!,
        { ...second.sections[0]!, id: `${secondPageSectionId}_local` },
      ],
    });
    const state = {
      ...createContentEditorState({ definition: twoPages, revision: 2 }),
      workingDefinition: locallyChanged,
      status: "dirty" as const,
    };

    // A revision saved elsewhere arrives while the owner is on the home page.
    const elsewhere: SiteDefinition = {
      ...twoPages,
      site: { ...twoPages.site, name: "Renamed elsewhere" },
    };
    const merged = contentEditorReducer(state, {
      type: "externalRevision",
      definition: elsewhere,
      revision: 3,
    });

    expect(
      findPageById(merged.workingDefinition, secondPageId)!.sections.map(
        ({ id }) => id,
      ),
    ).toEqual([secondPageSectionId, `${secondPageSectionId}_local`]);
    expect(merged.workingDefinition.site.name).toBe("Renamed elsewhere");
  });

  it("puts an undone change back on the page it was made on", () => {
    const drawn = definitionToPuckData(second, registry);
    const twice = {
      ...drawn,
      content: [
        drawn.content[0]!,
        {
          ...drawn.content[0]!,
          props: {
            ...drawn.content[0]!.props,
            id: `${secondPageSectionId}_undo`,
            metrics: [],
          },
        },
      ],
    };
    const added = puckDataToDefinition(twoPages, second, twice, registry);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const state = createContentEditorState({
      definition: twoPages,
      revision: 2,
    });
    const composed = contentEditorReducer(state, {
      type: "compose",
      definition: added.definition,
    });
    const undone = contentEditorReducer(composed, { type: "undo" });

    expect(sectionsOf(undone.workingDefinition, secondPageId)).toBe(
      sectionsOf(twoPages, secondPageId),
    );
    expect(sectionsOf(undone.workingDefinition, home.id)).toBe(
      sectionsOf(twoPages, home.id),
    );
    expect(undone.status).toBe("saved");

    const redone = contentEditorReducer(undone, { type: "redo" });
    expect(sectionsOf(redone.workingDefinition, secondPageId)).toBe(
      sectionsOf(added.definition, secondPageId),
    );
  });
});

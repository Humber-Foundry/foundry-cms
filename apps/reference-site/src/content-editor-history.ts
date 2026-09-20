import {
  listEditableSiteFields,
  pageCompositionContract,
  toPageCompositionIdentity,
  updateEditableSiteField,
  type SiteDefinition,
  type SiteDefinitionEdit,
  type SitePage,
  replacePage,
} from "@humber-foundry/site-definition";

/**
 * The structure of every page of a draft, as one comparable value.
 *
 * Every page counts, not only the page the owner has open. A revision saved
 * elsewhere can change any page, and an unsaved structural change of the
 * owner's can be on any page, so a comparison of the home page alone would
 * miss both. See ADR-0032.
 */
function compositionIdentity(definition: SiteDefinition): string {
  return JSON.stringify(
    definition.pages.map((page) => toPageCompositionIdentity(page)),
  );
}

/** The same definition with every page emptied of its sections. */
function withoutAnySections(definition: SiteDefinition): SiteDefinition {
  return {
    ...definition,
    pages: definition.pages.map((page) => ({ ...page, sections: [] })),
  };
}

/** The same definition holding one section, on one page, and nothing else. */
function withOnlySection(
  definition: SiteDefinition,
  page: SitePage,
  sectionIndex: number,
): SiteDefinition {
  return replacePage(withoutAnySections(definition), {
    ...page,
    sections: [page.sections[sectionIndex]!],
  });
}

function hasConcurrentCompositionConflict(
  state: ContentEditorState,
  incoming: SiteDefinition,
): boolean {
  const persisted = compositionIdentity(state.persistedDefinition);
  const working = compositionIdentity(state.workingDefinition);
  const external = compositionIdentity(incoming);
  return working !== persisted && external !== persisted && working !== external;
}

function concurrentFieldConflicts(
  state: ContentEditorState,
  incoming: SiteDefinition,
): ReadonlyArray<string> {
  const persisted = new Map(
    listEditableSiteFields(state.persistedDefinition).map((field) => [
      field.path,
      field.value,
    ]),
  );
  const external = new Map(
    listEditableSiteFields(incoming).map((field) => [
      field.path,
      field.value,
    ]),
  );
  const working = new Map(
    listEditableSiteFields(state.workingDefinition).map((field) => [
      field.path,
      field.value,
    ]),
  );
  return [...new Set([
    ...persisted.keys(),
    ...working.keys(),
    ...external.keys(),
  ])]
    .filter((path) => {
      const baseline = persisted.get(path);
      const workingValue = working.get(path);
      const incomingValue = external.get(path);
      return (
        workingValue !== baseline &&
        incomingValue !== baseline &&
        workingValue !== incomingValue
      );
    })
    .sort();
}

/**
 * Put one locally edited section back into the incoming revision, on the page
 * it was edited on.
 *
 * Every page is searched, because the owner may have edited a section of a
 * page they are no longer looking at. The section is matched to its own page
 * by id, so restoring an edit to page B never touches page A.
 */
function restoreLocalEditableOwner(
  definition: SiteDefinition,
  working: SiteDefinition,
  path: string,
): SiteDefinition | null {
  const baseFieldPaths = new Set(
    listEditableSiteFields(withoutAnySections(working)).map(
      (field) => field.path,
    ),
  );
  for (const workingPage of working.pages) {
    const localSectionIndex = workingPage.sections.findIndex((_section, at) =>
      listEditableSiteFields(
        withOnlySection(working, workingPage, at),
      ).some(
        (field) => field.path === path && !baseFieldPaths.has(field.path),
      ),
    );
    if (localSectionIndex < 0) continue;
    const localSection = workingPage.sections[localSectionIndex]!;
    const incomingPage = definition.pages.find(
      ({ id }) => id === workingPage.id,
    );
    // The incoming revision no longer holds this page, so there is nowhere to
    // put the section back. The caller keeps the edit as a conflict instead.
    if (incomingPage === undefined) return null;
    const sections = [...incomingPage.sections];
    const incomingIndex = sections.findIndex(
      (section) => section.id === localSection.id,
    );
    if (incomingIndex >= 0) {
      sections[incomingIndex] = localSection;
    } else {
      sections.splice(
        Math.min(localSectionIndex, sections.length),
        0,
        localSection,
      );
    }
    return replacePage(definition, { ...incomingPage, sections });
  }

  const localNavigationIndex = working.site.navigation.findIndex(
    (item) => `${item.id}.label` === path,
  );
  if (localNavigationIndex >= 0) {
    const localItem = working.site.navigation[localNavigationIndex]!;
    const navigation = [...definition.site.navigation];
    const incomingIndex = navigation.findIndex(
      (item) => item.id === localItem.id,
    );
    if (incomingIndex >= 0) {
      navigation[incomingIndex] = localItem;
    } else {
      navigation.splice(
        Math.min(localNavigationIndex, navigation.length),
        0,
        localItem,
      );
    }
    return {
      ...definition,
      site: { ...definition.site, navigation },
    };
  }
  return null;
}

function mergeExternalRevision(
  state: ContentEditorState,
  incoming: SiteDefinition,
) {
  const persisted = new Map(
    listEditableSiteFields(state.persistedDefinition).map((field) => [
      field.path,
      field.value,
    ]),
  );
  const workingFields = listEditableSiteFields(state.workingDefinition);
  const locallyDirtyPaths = new Set(
    workingFields
      .filter((field) => persisted.get(field.path) !== field.value)
      .map((field) => field.path),
  );
  const compositionChanged =
    compositionIdentity(state.persistedDefinition) !==
    compositionIdentity(state.workingDefinition);
  const incomingFields = hasConcurrentCompositionConflict(state, incoming)
    ? []
    : listEditableSiteFields(incoming);
  // An unsaved structural change is kept on whichever page it was made on.
  // Each page's sections are matched within that page alone, so the order the
  // owner set on one page is never written onto another.
  let merged = compositionChanged
    ? state.workingDefinition.pages.reduce((definition, workingPage) => {
        const incomingPage = definition.pages.find(
          ({ id }) => id === workingPage.id,
        );
        if (incomingPage === undefined) return definition;
        const incomingSections = new Map(
          incomingPage.sections.map((section) => [
            `${section.type}:${section.id}`,
            section,
          ]),
        );
        return replacePage(definition, {
          ...incomingPage,
          sections: workingPage.sections.map(
            (section) =>
              incomingSections.get(`${section.type}:${section.id}`) ?? section,
          ),
        });
      }, incoming)
    : incoming;
  for (const field of workingFields) {
    if (!locallyDirtyPaths.has(field.path)) continue;
    const updated = updateEditableSiteField(merged, field);
    if (updated === null) {
      const restored = restoreLocalEditableOwner(
        merged,
        state.workingDefinition,
        field.path,
      );
      if (restored === null) {
        continue;
      }
      merged = incomingFields.reduce(
        (definition, incomingField) =>
          locallyDirtyPaths.has(incomingField.path)
            ? definition
            : (updateEditableSiteField(definition, incomingField) ??
              definition),
        restored,
      );
      merged = updateEditableSiteField(merged, field) ?? merged;
      continue;
    }
    merged = updated;
  }
  return merged;
}

export type ContentEditorState = Readonly<{
  persistedRevision: number;
  persistedDefinition: SiteDefinition;
  workingDefinition: SiteDefinition;
  past: ReadonlyArray<SiteDefinition>;
  future: ReadonlyArray<SiteDefinition>;
  projectionVersion: number;
  status: "saved" | "dirty" | "saving" | "conflict" | "stale";
  errors: Readonly<Record<string, string>>;
}>;

export function contentEditorStatusLocked(
  status: ContentEditorState["status"],
): boolean {
  return status === "saving" || status === "conflict" || status === "stale";
}

export type ContentEditorAction =
  | (SiteDefinitionEdit & Readonly<{ type: "edit" }>)
  /**
   * Several field edits as one undoable step. Choosing a preset look changes
   * every design token at once, and the owner expects one Undo to put the
   * previous look back rather than six.
   */
  | Readonly<{
      type: "editMany";
      edits: ReadonlyArray<SiteDefinitionEdit>;
    }>
  | Readonly<{
      type: "compose";
      definition: SiteDefinition;
      refreshProjection?: boolean;
    }>
  | Readonly<{ type: "undo" }>
  | Readonly<{ type: "redo" }>
  | Readonly<{ type: "saving" }>
  | Readonly<{
      type: "saved";
      definition: SiteDefinition;
      revision: number;
    }>
  | Readonly<{
      type: "externalRevision";
      definition: SiteDefinition;
      revision: number;
    }>
  | Readonly<{
      type: "failed";
      errors: Readonly<Record<string, string>>;
      conflict?: "conflict" | "stale";
      acknowledgedRevision?: number;
    }>;

export function createContentEditorState({
  definition,
  revision,
  stale = false,
}: {
  definition: SiteDefinition;
  revision: number;
  stale?: boolean;
}): ContentEditorState {
  return {
    persistedRevision: revision,
    persistedDefinition: definition,
    workingDefinition: definition,
    past: [],
    future: [],
    projectionVersion: 0,
    status: stale ? "stale" : "saved",
    errors: {},
  };
}

function definitionsAreEqual(
  first: SiteDefinition,
  second: SiteDefinition,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function contentEditorReducer(
  state: ContentEditorState,
  action: ContentEditorAction,
): ContentEditorState {
  if (state.status === "stale") {
    return state;
  }
  if (
    contentEditorStatusLocked(state.status) &&
    (action.type === "edit" ||
      action.type === "editMany" ||
      action.type === "compose" ||
      action.type === "undo" ||
      action.type === "redo")
  ) {
    return state;
  }
  switch (action.type) {
    case "edit": {
      const workingDefinition = updateEditableSiteField(
        state.workingDefinition,
        action,
      );
      if (workingDefinition === null) {
        return state;
      }
      return {
        ...state,
        workingDefinition,
        past: [...state.past, state.workingDefinition],
        future: [],
        projectionVersion: state.projectionVersion + 1,
        status: "dirty",
        errors: { ...state.errors, [action.path]: "" },
      };
    }
    case "editMany": {
      if (action.edits.length === 0) {
        return state;
      }
      let workingDefinition: SiteDefinition = state.workingDefinition;
      for (const edit of action.edits) {
        const updated = updateEditableSiteField(workingDefinition, edit);
        // All of the batch or none of it. A half-applied preset look would
        // leave the site in a design the owner never chose.
        if (updated === null) {
          return state;
        }
        workingDefinition = updated;
      }
      // A batch can land exactly back on the persisted design — choosing the
      // preset the draft already came from — so the status is computed the way
      // undo, redo and compose compute it, rather than always saying dirty.
      return {
        ...state,
        workingDefinition,
        past: [...state.past, state.workingDefinition],
        future: [],
        projectionVersion: state.projectionVersion + 1,
        status: definitionsAreEqual(
          workingDefinition,
          state.persistedDefinition,
        )
          ? "saved"
          : "dirty",
        errors: {
          ...state.errors,
          ...Object.fromEntries(
            action.edits.map(({ path }) => [path, ""]),
          ),
        },
      };
    }
    case "compose":
      return {
        ...state,
        workingDefinition: action.definition,
        past: [...state.past, state.workingDefinition],
        future: [],
        projectionVersion:
          state.projectionVersion +
          (action.refreshProjection ? 1 : 0),
        status:
          definitionsAreEqual(
            action.definition,
            state.persistedDefinition,
          )
            ? "saved"
            : "dirty",
        errors: {},
      };
    case "undo": {
      const workingDefinition = state.past.at(-1);
      if (workingDefinition === undefined) {
        return state;
      }
      return {
        ...state,
        workingDefinition,
        past: state.past.slice(0, -1),
        future: [state.workingDefinition, ...state.future],
        projectionVersion: state.projectionVersion + 1,
        status:
          definitionsAreEqual(
            workingDefinition,
            state.persistedDefinition,
          )
            ? "saved"
            : "dirty",
        errors: {},
      };
    }
    case "redo": {
      const [workingDefinition, ...future] = state.future;
      if (workingDefinition === undefined) {
        return state;
      }
      return {
        ...state,
        workingDefinition,
        past: [...state.past, state.workingDefinition],
        future,
        projectionVersion: state.projectionVersion + 1,
        status:
          definitionsAreEqual(
            workingDefinition,
            state.persistedDefinition,
          )
            ? "saved"
            : "dirty",
        errors: {},
      };
    }
    case "saving":
      return { ...state, status: "saving", errors: {} };
    case "saved":
      return {
        ...state,
        persistedDefinition: action.definition,
        persistedRevision: action.revision,
        workingDefinition: action.definition,
        // A save acknowledges persistence; it does not change what the canvas
        // shows. Saves also run automatically after edits, so refreshing the
        // projection here would rebuild the canvas mid-edit and throw away the
        // owner's selection. If a recovered save ever lands content older than
        // the screen, the next canvas change composes the on-screen state
        // again, and every revision stays restorable regardless.
        projectionVersion: state.projectionVersion,
        status: "saved",
        errors: {},
      };
    case "externalRevision":
      const compositionConflict = hasConcurrentCompositionConflict(
        state,
        action.definition,
      );
      const fieldConflicts = compositionConflict
        ? []
        : concurrentFieldConflicts(state, action.definition);
      const hasConflict =
        compositionConflict || fieldConflicts.length > 0;
      return {
        ...state,
        persistedDefinition: action.definition,
        persistedRevision: action.revision,
        workingDefinition: mergeExternalRevision(state, action.definition),
        past: [],
        future: [],
        status:
          hasConflict
            ? "conflict"
            : state.status === "saved"
              ? "saved"
              : state.status,
        errors: {
          ...(compositionConflict
            ? {
                [pageCompositionContract.slot.id]:
                  "The page structure changed elsewhere. Reload latest to reconcile your unsaved structure.",
              }
            : {}),
          ...Object.fromEntries(
            fieldConflicts.map((path) => [
              path,
              "This field changed elsewhere. Reload latest to reconcile your unsaved value.",
            ]),
          ),
        },
      };
    case "failed":
      return {
        ...state,
        persistedRevision:
          action.acknowledgedRevision ?? state.persistedRevision,
        status: action.conflict ?? "dirty",
        errors: action.errors,
      };
  }
}

import {
  listEditableSiteFields,
  pageCompositionContract,
  toPageCompositionIdentity,
  updateEditableSiteField,
  type SiteDefinition,
  type SiteDefinitionEdit,
} from "@foundry/site-definition";

function compositionIdentity(definition: SiteDefinition): string {
  return JSON.stringify(toPageCompositionIdentity(definition));
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

function restoreLocalEditableOwner(
  definition: SiteDefinition,
  working: SiteDefinition,
  path: string,
): SiteDefinition | null {
  const baseFieldPaths = new Set(
    listEditableSiteFields({
      ...working,
      home: { ...working.home, sections: [] },
    }).map((field) => field.path),
  );
  const localSectionIndex = working.home.sections.findIndex((section) =>
    listEditableSiteFields({
      ...working,
      home: { ...working.home, sections: [section] },
    }).some(
      (field) => field.path === path && !baseFieldPaths.has(field.path),
    ),
  );
  if (localSectionIndex >= 0) {
    const localSection = working.home.sections[localSectionIndex]!;
    const sections = [...definition.home.sections];
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
    return {
      ...definition,
      home: { ...definition.home, sections },
    };
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
  const incomingSections = new Map(
    incoming.home.sections.map((section) => [
      `${section.type}:${section.id}`,
      section,
    ]),
  );
  let merged = compositionChanged
    ? {
        ...incoming,
        home: {
          ...incoming.home,
          sections: state.workingDefinition.home.sections.map(
            (section) =>
              incomingSections.get(`${section.type}:${section.id}`) ?? section,
          ),
        },
      }
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
        projectionVersion: state.projectionVersion + 1,
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

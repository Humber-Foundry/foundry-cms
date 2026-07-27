import {
  updateEditableSiteField,
  type SiteDefinition,
} from "@foundry/site-definition";

export type ContentEditorState = Readonly<{
  persistedRevision: number;
  persistedDefinition: SiteDefinition;
  workingDefinition: SiteDefinition;
  past: ReadonlyArray<SiteDefinition>;
  future: ReadonlyArray<SiteDefinition>;
  status: "saved" | "dirty" | "saving" | "conflict" | "stale";
  errors: Readonly<Record<string, string>>;
}>;

export type ContentEditorAction =
  | Readonly<{ type: "edit"; path: string; value: string }>
  | Readonly<{ type: "undo" }>
  | Readonly<{ type: "redo" }>
  | Readonly<{ type: "saving" }>
  | Readonly<{
      type: "saved";
      definition: SiteDefinition;
      revision: number;
    }>
  | Readonly<{
      type: "failed";
      errors: Readonly<Record<string, string>>;
      conflict?: "conflict" | "stale";
    }>;

export function createContentEditorState({
  definition,
  revision,
}: {
  definition: SiteDefinition;
  revision: number;
}): ContentEditorState {
  return {
    persistedRevision: revision,
    persistedDefinition: definition,
    workingDefinition: definition,
    past: [],
    future: [],
    status: "saved",
    errors: {},
  };
}

export function contentEditorReducer(
  state: ContentEditorState,
  action: ContentEditorAction,
): ContentEditorState {
  switch (action.type) {
    case "edit": {
      if (state.status === "stale") {
        return state;
      }
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
        status: "dirty",
        errors: { ...state.errors, [action.path]: "" },
      };
    }
    case "undo": {
      if (state.status === "stale") {
        return state;
      }
      const workingDefinition = state.past.at(-1);
      if (workingDefinition === undefined) {
        return state;
      }
      return {
        ...state,
        workingDefinition,
        past: state.past.slice(0, -1),
        future: [state.workingDefinition, ...state.future],
        status:
          workingDefinition === state.persistedDefinition ? "saved" : "dirty",
        errors: {},
      };
    }
    case "redo": {
      if (state.status === "stale") {
        return state;
      }
      const [workingDefinition, ...future] = state.future;
      if (workingDefinition === undefined) {
        return state;
      }
      return {
        ...state,
        workingDefinition,
        past: [...state.past, state.workingDefinition],
        future,
        status:
          workingDefinition === state.persistedDefinition ? "saved" : "dirty",
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
        status: "saved",
        errors: {},
      };
    case "failed":
      return {
        ...state,
        status: action.conflict ?? "dirty",
        errors: action.errors,
      };
  }
}

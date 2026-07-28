import {
  applyPageComposition,
  pageCompositionContract,
  type PageSection,
  type SiteDefinition,
  type SiteDefinitionEdit,
} from "@foundry/site-definition";

const staleEditRecoveryPrefix = "foundry-cms:stale-edit-recovery";
const maximumRecoveredEdits = 500;

type RecoveryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type StaleRecoveryEdit = SiteDefinitionEdit &
  Readonly<{ baseValue: string }>;

export type StaleRecoveryConflict = StaleRecoveryEdit &
  Readonly<{
    currentValue: string | null;
    reason: "changed" | "missing";
  }>;

export type StaleRecoveryPointer = Readonly<{
  id: string;
  sourceWorkspaceId: string;
}>;

export function applyStructuralRecovery(
  definition: SiteDefinition,
  edit: StaleRecoveryEdit,
):
  | Readonly<{ ok: true; definition: SiteDefinition }>
  | Readonly<{ ok: false }> {
  if (edit.path !== pageCompositionContract.slot.id) {
    return { ok: false };
  }
  try {
    const composition: unknown = JSON.parse(edit.value);
    if (
      typeof composition !== "object" ||
      composition === null ||
      !("components" in composition) ||
      !Array.isArray(composition.components)
    ) {
      return { ok: false };
    }
    const currentById = new Map(
      definition.home.sections.map((section) => [section.id, section]),
    );
    const mergedComposition = {
      ...composition,
      components: composition.components.map((candidate) => {
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          !("id" in candidate) ||
          typeof candidate.id !== "string" ||
          !("type" in candidate)
        ) {
          return candidate;
        }
        const current = currentById.get(candidate.id);
        return current?.type === candidate.type ? current : candidate;
      }),
    };
    const result = applyPageComposition(definition, mergedComposition);
    return result.ok
      ? { ok: true, definition: result.definition }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function resolveStructuralRecovery(
  definition: SiteDefinition,
  edit: StaleRecoveryEdit,
  currentValue: string | null,
):
  | Readonly<{ ok: true; definition: SiteDefinition }>
  | Readonly<{ ok: false; conflict: StaleRecoveryConflict }> {
  const result = applyStructuralRecovery(definition, edit);
  return result.ok
    ? result
    : {
        ok: false,
        conflict: {
          ...edit,
          currentValue,
          reason: "changed",
        },
      };
}

export function excludeCompositionOwnedEdits(
  edits: ReadonlyArray<StaleRecoveryEdit>,
  components: ReadonlyArray<PageSection>,
): StaleRecoveryEdit[] {
  const componentIds = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === "id" && typeof nested === "string") {
        componentIds.add(nested);
      } else {
        visit(nested);
      }
    }
  };
  visit(components);
  return edits.filter(({ path }) => {
    for (const id of componentIds) {
      if (path.startsWith(`${id}.`)) {
        return false;
      }
    }
    return true;
  });
}

export function recoveryToForward(
  destinationIsStale: boolean,
  activeRecovery: StaleRecoveryPointer | undefined,
): StaleRecoveryPointer | undefined {
  return destinationIsStale ? activeRecovery : undefined;
}

export function mergeStaleRecoveryEdits(
  pending: ReadonlyArray<StaleRecoveryEdit>,
  current: ReadonlyArray<StaleRecoveryEdit>,
  unresolvedPaths: ReadonlySet<string>,
): StaleRecoveryEdit[] {
  const currentPaths = new Set(current.map((edit) => edit.path));
  const merged = new Map(
    pending
      .filter(
        (edit) =>
          currentPaths.has(edit.path) || unresolvedPaths.has(edit.path),
      )
      .map((edit) => [edit.path, edit] as const),
  );
  for (const edit of current) {
    const earlier = merged.get(edit.path);
    merged.set(edit.path, {
      ...edit,
      baseValue: earlier?.baseValue ?? edit.baseValue,
    });
  }
  return [...merged.values()];
}

function recoveryKey(sourceWorkspaceId: string, recoveryId: string): string {
  return `${staleEditRecoveryPrefix}:${sourceWorkspaceId}:${recoveryId}`;
}

function isStaleRecoveryEdit(value: unknown): value is StaleRecoveryEdit {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "value" in value &&
    typeof value.value === "string" &&
    "baseValue" in value &&
    typeof value.baseValue === "string"
  );
}

function parseRecovery(encoded: string | null) {
  if (encoded === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("sourceWorkspaceId" in parsed) ||
      typeof parsed.sourceWorkspaceId !== "string" ||
      !("edits" in parsed) ||
      !Array.isArray(parsed.edits) ||
      parsed.edits.length > maximumRecoveredEdits ||
      !parsed.edits.every(isStaleRecoveryEdit) ||
      new Set(parsed.edits.map((edit) => edit.path)).size !==
        parsed.edits.length
    ) {
      return null;
    }
    return {
      sourceWorkspaceId: parsed.sourceWorkspaceId,
      edits: parsed.edits as StaleRecoveryEdit[],
    };
  } catch {
    return null;
  }
}

export function preserveStaleEdits(
  storage: RecoveryStorage,
  recoveryId: string,
  sourceWorkspaceId: string,
  edits: ReadonlyArray<StaleRecoveryEdit>,
): boolean {
  try {
    storage.setItem(
      recoveryKey(sourceWorkspaceId, recoveryId),
      JSON.stringify({ sourceWorkspaceId, edits }),
    );
    return true;
  } catch {
    return false;
  }
}

export function recoverStaleEdits(
  storage: RecoveryStorage,
  recoveryId: string,
  sourceWorkspaceId: string,
  destinationValues: ReadonlyMap<string, string>,
): Readonly<{
  available: boolean;
  recovered: StaleRecoveryEdit[];
  conflicts: StaleRecoveryConflict[];
}> {
  try {
    const key = recoveryKey(sourceWorkspaceId, recoveryId);
    const recovery = parseRecovery(storage.getItem(key));
    if (
      recovery === null ||
      recovery.sourceWorkspaceId !== sourceWorkspaceId
    ) {
      storage.removeItem(key);
      return { available: true, recovered: [], conflicts: [] };
    }
    const recovered: StaleRecoveryEdit[] = [];
    const conflicts: StaleRecoveryConflict[] = [];
    for (const edit of recovery.edits) {
      const currentValue = destinationValues.get(edit.path);
      if (currentValue === undefined) {
        conflicts.push({ ...edit, currentValue: null, reason: "missing" });
      } else if (currentValue === edit.baseValue) {
        recovered.push(edit);
      } else {
        conflicts.push({ ...edit, currentValue, reason: "changed" });
      }
    }
    return {
      available: true,
      recovered,
      conflicts,
    };
  } catch {
    return { available: false, recovered: [], conflicts: [] };
  }
}

export function clearStaleEdits(
  storage: RecoveryStorage,
  recoveryId: string,
  sourceWorkspaceId: string,
): boolean {
  try {
    storage.removeItem(recoveryKey(sourceWorkspaceId, recoveryId));
    return true;
  } catch {
    return false;
  }
}

export function synchronizeStaleEdits(
  storage: RecoveryStorage,
  recoveryId: string,
  sourceWorkspaceId: string,
  edits: ReadonlyArray<StaleRecoveryEdit>,
): boolean {
  return edits.length === 0
    ? clearStaleEdits(storage, recoveryId, sourceWorkspaceId)
    : preserveStaleEdits(storage, recoveryId, sourceWorkspaceId, edits);
}

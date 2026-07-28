import {
  applyPageComposition,
  createRichTextDocumentFromPlainText,
  listEditableSiteFields,
  pageCompositionContract,
  serializeRichTextDocument,
  toPageCompositionIdentity,
  type PageSection,
  type SiteDefinition,
  type SiteDefinitionEdit,
} from "@foundry/site-definition";
import { canonicalJson } from "@foundry/application";

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

function upgradeLegacyStructuralRecoveryEdit(
  edit: StaleRecoveryEdit,
): StaleRecoveryEdit {
  if (
    edit.path !== pageCompositionContract.slot.id ||
    edit.format === "richText"
  ) {
    return edit;
  }
  const upgradeComposition = (serialized: string): string => {
    try {
      const composition: unknown = JSON.parse(serialized);
      if (
        typeof composition !== "object" ||
        composition === null ||
        !("components" in composition) ||
        !Array.isArray(composition.components)
      ) {
        return serialized;
      }
      let changed = false;
      const components = composition.components.map((candidate) => {
        if (
          typeof candidate !== "object" ||
          candidate === null ||
          !("type" in candidate) ||
          candidate.type !== "callToAction" ||
          !("body" in candidate) ||
          typeof candidate.body !== "string"
        ) {
          return candidate;
        }
        changed = true;
        return {
          ...candidate,
          body: createRichTextDocumentFromPlainText(candidate.body),
        };
      });
      return changed
        ? JSON.stringify({ ...composition, components })
        : serialized;
    } catch {
      return serialized;
    }
  };
  const value = upgradeComposition(edit.value);
  const baseValue = upgradeComposition(edit.baseValue);
  return value === edit.value && baseValue === edit.baseValue
    ? edit
    : { ...edit, value, baseValue };
}

export function upgradeLegacyRichTextRecoveryEdit(
  edit: StaleRecoveryEdit,
  richTextPaths: ReadonlySet<string>,
): StaleRecoveryEdit {
  const structuralEdit = upgradeLegacyStructuralRecoveryEdit(edit);
  if (structuralEdit !== edit) {
    return structuralEdit;
  }
  if (!richTextPaths.has(edit.path) || edit.format !== undefined) {
    return edit;
  }
  return {
    path: edit.path,
    format: "richText",
    value: serializeRichTextDocument(
      createRichTextDocumentFromPlainText(edit.value),
    ),
    baseValue: serializeRichTextDocument(
      createRichTextDocumentFromPlainText(edit.baseValue),
    ),
  };
}

export function comparableRecoveryValue(edit: StaleRecoveryEdit): string {
  if (edit.path !== pageCompositionContract.slot.id) {
    return edit.value;
  }
  try {
    const composition: unknown = JSON.parse(edit.value);
    if (
      typeof composition !== "object" ||
      composition === null ||
      !("slotId" in composition) ||
      typeof composition.slotId !== "string" ||
      !("components" in composition) ||
      !Array.isArray(composition.components)
    ) {
      return edit.value;
    }
    const components = composition.components.map((component) => {
      if (
        typeof component !== "object" ||
        component === null ||
        !("id" in component) ||
        typeof component.id !== "string" ||
        !("type" in component) ||
        typeof component.type !== "string"
      ) {
        throw new Error("invalid_component");
      }
      return { id: component.id, type: component.type };
    });
    return JSON.stringify({
      slotId: composition.slotId,
      components,
    });
  } catch {
    return edit.value;
  }
}

export function comparableRecoveryBaseValue(
  edit: StaleRecoveryEdit,
): string {
  return edit.path === pageCompositionContract.slot.id
    ? comparableRecoveryValue({
        path: edit.path,
        format: "plainText",
        value: edit.baseValue,
        baseValue: edit.baseValue,
      })
    : edit.baseValue;
}

export function applyStructuralRecovery(
  definition: SiteDefinition,
  edit: StaleRecoveryEdit,
):
  | Readonly<{ ok: true; definition: SiteDefinition }>
  | Readonly<{ ok: false }> {
  if (edit.path !== pageCompositionContract.slot.id) {
    return { ok: false };
  }
  const recoveredEdit = upgradeLegacyStructuralRecoveryEdit(edit);
  try {
    const composition: unknown = JSON.parse(recoveredEdit.value);
    if (
      typeof composition !== "object" ||
      composition === null ||
      !("components" in composition) ||
      !Array.isArray(composition.components)
    ) {
      return { ok: false };
    }
    let baseComposition: unknown = null;
    let baseIds: ReadonlySet<string> | null = null;
    try {
      baseComposition = JSON.parse(recoveredEdit.baseValue);
    } catch {
      // Identity-only records from older editor sessions remain recoverable.
    }
    const targetIds = new Set(
      composition.components.flatMap((candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "id" in candidate &&
        typeof candidate.id === "string"
          ? [candidate.id]
          : [],
      ),
    );
    if (
      typeof baseComposition === "object" &&
      baseComposition !== null &&
      "components" in baseComposition &&
      Array.isArray(baseComposition.components)
    ) {
      const baseById = new Map(
        baseComposition.components.flatMap((candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "id" in candidate &&
          typeof candidate.id === "string"
            ? [[candidate.id, candidate] as const]
            : [],
        ),
      );
      baseIds = new Set(baseById.keys());
      for (const current of definition.home.sections) {
        const base = baseById.get(current.id);
        if (
          base !== undefined &&
          !targetIds.has(current.id) &&
          canonicalJson(current) !== canonicalJson(base)
        ) {
          return { ok: false };
        }
      }
    } else if (
      definition.home.sections.some(({ id }) => !targetIds.has(id))
    ) {
      return { ok: false };
    }
    const currentById = new Map(
      definition.home.sections.map((section) => [section.id, section]),
    );
    const mergedComposition = {
      ...composition,
      components: [
        ...composition.components.map((candidate) => {
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
        ...(baseIds === null
          ? []
          : definition.home.sections.filter(
              ({ id }) => !baseIds.has(id) && !targetIds.has(id),
            )),
      ],
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

export function planStructuralFirstRecovery(
  definition: SiteDefinition,
  edits: ReadonlyArray<StaleRecoveryEdit>,
): Readonly<{
  orderedEdits: StaleRecoveryEdit[];
  destinationValues: ReadonlyMap<string, string>;
  projected: boolean;
}> {
  const orderedEdits = [
    ...edits.filter(
      ({ path }) => path === pageCompositionContract.slot.id,
    ),
    ...edits.filter(
      ({ path }) => path !== pageCompositionContract.slot.id,
    ),
  ];
  let projectedDefinition = definition;
  for (const edit of orderedEdits) {
    if (edit.path !== pageCompositionContract.slot.id) {
      continue;
    }
    if (
      JSON.stringify(toPageCompositionIdentity(projectedDefinition)) !==
      comparableRecoveryBaseValue(edit)
    ) {
      continue;
    }
    const projected = applyStructuralRecovery(projectedDefinition, edit);
    if (projected.ok) {
      projectedDefinition = projected.definition;
    }
  }
  return {
    orderedEdits,
    destinationValues: new Map([
      ...listEditableSiteFields(projectedDefinition).map(
        (field) => [field.path, field.value] as const,
      ),
      [
        pageCompositionContract.slot.id,
        JSON.stringify(toPageCompositionIdentity(definition)),
      ] as const,
    ]),
    projected: projectedDefinition !== definition,
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

function chainRecoveryEdit(
  earlier: StaleRecoveryEdit | undefined,
  current: StaleRecoveryEdit,
): StaleRecoveryEdit {
  const format = current.format ?? earlier?.format;
  return {
    ...current,
    ...(format === undefined ? {} : { format }),
    baseValue: earlier?.baseValue ?? current.baseValue,
  } as StaleRecoveryEdit;
}

export function mergeRecoverySources(
  ...sources: ReadonlyArray<ReadonlyArray<StaleRecoveryEdit>>
): StaleRecoveryEdit[] {
  const merged = new Map<string, StaleRecoveryEdit>();
  for (const source of sources) {
    for (const edit of source) {
      const earlier = merged.get(edit.path);
      merged.set(edit.path, chainRecoveryEdit(earlier, edit));
    }
  }
  return [...merged.values()];
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
    merged.set(edit.path, chainRecoveryEdit(earlier, edit));
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
  richTextPaths: ReadonlySet<string> = new Set(),
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
    for (const persistedEdit of recovery.edits) {
      const edit = upgradeLegacyRichTextRecoveryEdit(
        persistedEdit,
        richTextPaths,
      );
      const currentValue = destinationValues.get(edit.path);
      if (currentValue === undefined) {
        conflicts.push({ ...edit, currentValue: null, reason: "missing" });
      } else if (currentValue === comparableRecoveryValue(edit)) {
        continue;
      } else if (currentValue === comparableRecoveryBaseValue(edit)) {
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

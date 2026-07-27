import type { SiteDefinitionEdit } from "@foundry/site-definition";

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

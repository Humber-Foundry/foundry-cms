import type { SiteDefinitionEdit } from "@foundry/site-definition";

const staleEditRecoveryPrefix = "foundry-cms:stale-edit-recovery";
const maximumRecoveredEdits = 500;

type RecoveryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function recoveryKey(sourceWorkspaceId: string, recoveryId: string): string {
  return `${staleEditRecoveryPrefix}:${sourceWorkspaceId}:${recoveryId}`;
}

function isSiteDefinitionEdit(value: unknown): value is SiteDefinitionEdit {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    "value" in value &&
    typeof value.value === "string"
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
      !parsed.edits.every(isSiteDefinitionEdit)
    ) {
      return null;
    }
    return {
      sourceWorkspaceId: parsed.sourceWorkspaceId,
      edits: parsed.edits as SiteDefinitionEdit[],
    };
  } catch {
    return null;
  }
}

export function preserveStaleEdits(
  storage: RecoveryStorage,
  recoveryId: string,
  sourceWorkspaceId: string,
  edits: ReadonlyArray<SiteDefinitionEdit>,
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
  validPaths: ReadonlySet<string>,
): Readonly<{
  available: boolean;
  recovered: SiteDefinitionEdit[];
  unmatched: SiteDefinitionEdit[];
}> {
  try {
    const key = recoveryKey(sourceWorkspaceId, recoveryId);
    const recovery = parseRecovery(storage.getItem(key));
    if (
      recovery === null ||
      recovery.sourceWorkspaceId !== sourceWorkspaceId
    ) {
      storage.removeItem(key);
      return { available: true, recovered: [], unmatched: [] };
    }
    return {
      available: true,
      recovered: recovery.edits.filter((edit) => validPaths.has(edit.path)),
      unmatched: recovery.edits.filter((edit) => !validPaths.has(edit.path)),
    };
  } catch {
    return { available: false, recovered: [], unmatched: [] };
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

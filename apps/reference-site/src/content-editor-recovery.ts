import type { SiteDefinitionEdit } from "@foundry/site-definition";

const staleEditRecoveryKey = "foundry-cms:stale-edit-recovery";
const maximumRecoveredEdits = 500;

type RecoveryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

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

export function preserveStaleEdits(
  storage: RecoveryStorage,
  edits: ReadonlyArray<SiteDefinitionEdit>,
): void {
  storage.setItem(staleEditRecoveryKey, JSON.stringify(edits));
}

export function consumeStaleEdits(
  storage: RecoveryStorage,
): SiteDefinitionEdit[] {
  const encoded = storage.getItem(staleEditRecoveryKey);
  storage.removeItem(staleEditRecoveryKey);
  if (encoded === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) &&
      parsed.length <= maximumRecoveredEdits &&
      parsed.every(isSiteDefinitionEdit)
      ? parsed
      : [];
  } catch {
    return [];
  }
}

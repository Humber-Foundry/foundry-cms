import type { StaleRecoveryEdit } from "./content-editor-recovery";

const databaseName = "foundry-cms-content-editor";
const storeName = "workspace-outbox";
const maximumOutboxEdits = 500;

export type ContentEditorOutboxRecord = Readonly<{
  workspaceId: string;
  baseRevision: number;
  edits: ReadonlyArray<StaleRecoveryEdit>;
  attempt?: Readonly<{
    body: string;
    idempotencyKey: string;
  }>;
}>;

function openOutbox(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, {
          keyPath: "workspaceId",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function isOutboxEdit(
  value: unknown,
): value is ContentEditorOutboxRecord["edits"][number] {
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

function isOutboxAttempt(
  value: unknown,
): value is NonNullable<ContentEditorOutboxRecord["attempt"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "body" in value &&
    typeof value.body === "string" &&
    "idempotencyKey" in value &&
    typeof value.idempotencyKey === "string" &&
    /^[A-Za-z0-9._:-]{16,128}$/u.test(value.idempotencyKey)
  );
}

export async function readContentEditorOutbox(
  workspaceId: string,
): Promise<ContentEditorOutboxRecord | null> {
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(workspaceId);
    const result = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await complete(transaction);
    if (
      typeof result !== "object" ||
      result === null ||
      !("workspaceId" in result) ||
      result.workspaceId !== workspaceId ||
      !("baseRevision" in result) ||
      !Number.isSafeInteger(result.baseRevision) ||
      !("edits" in result) ||
      !Array.isArray(result.edits) ||
      result.edits.length > maximumOutboxEdits ||
      !result.edits.every(isOutboxEdit) ||
      new Set(result.edits.map((edit) => edit.path)).size !==
        result.edits.length ||
      ("attempt" in result &&
        result.attempt !== undefined &&
        !isOutboxAttempt(result.attempt))
    ) {
      return null;
    }
    return result as ContentEditorOutboxRecord;
  } finally {
    database.close();
  }
}

export async function writeContentEditorOutbox(
  record: ContentEditorOutboxRecord,
): Promise<void> {
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(structuredClone(record));
    await complete(transaction);
  } finally {
    database.close();
  }
}

export async function clearContentEditorOutbox(
  workspaceId: string,
): Promise<void> {
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(workspaceId);
    await complete(transaction);
  } finally {
    database.close();
  }
}

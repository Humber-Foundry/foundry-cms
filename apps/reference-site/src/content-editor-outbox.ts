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

type ContentEditorOutboxDriver = Readonly<{
  read(workspaceId: string): Promise<ContentEditorOutboxRecord | null>;
  write(record: ContentEditorOutboxRecord): Promise<void>;
  clear(workspaceId: string): Promise<void>;
}>;

function openOutbox(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3);
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

async function readContentEditorOutboxEntry(
  workspaceId: string,
): Promise<ContentEditorOutboxRecord | null> {
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = workspaceId.includes("::")
      ? transaction.objectStore(storeName).get(workspaceId)
      : transaction.objectStore(storeName).getAll();
    const result = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await complete(transaction);
    const candidate = Array.isArray(result)
      ? result.find(
          (record) =>
            typeof record === "object" &&
            record !== null &&
            "workspaceId" in record &&
            (record.workspaceId === workspaceId ||
              (typeof record.workspaceId === "string" &&
                record.workspaceId.startsWith(`${workspaceId}::`))),
        ) ?? null
      : result;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("workspaceId" in candidate) ||
      (candidate.workspaceId !== workspaceId &&
        !(
          !workspaceId.includes("::") &&
          typeof candidate.workspaceId === "string" &&
          candidate.workspaceId.startsWith(`${workspaceId}::`)
        )) ||
      !("baseRevision" in candidate) ||
      !Number.isSafeInteger(candidate.baseRevision) ||
      !("edits" in candidate) ||
      !Array.isArray(candidate.edits) ||
      candidate.edits.length > maximumOutboxEdits ||
      !candidate.edits.every(isOutboxEdit) ||
      new Set(
        candidate.edits.map((edit: unknown) =>
          isOutboxEdit(edit) ? edit.path : "",
        ),
      ).size !==
        candidate.edits.length ||
      ("attempt" in candidate &&
        candidate.attempt !== undefined &&
        !isOutboxAttempt(candidate.attempt))
    ) {
      return null;
    }
    return candidate as ContentEditorOutboxRecord;
  } finally {
    database.close();
  }
}

export async function readContentEditorOutbox(
  workspaceId: string,
): Promise<ContentEditorOutboxRecord | null> {
  const record = await readContentEditorOutboxEntry(workspaceId);
  return record === null
    ? null
    : {
        ...record,
        workspaceId: workspaceId.split("::")[0]!,
      };
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
    const store = transaction.objectStore(storeName);
    if (workspaceId.includes("::")) {
      store.delete(workspaceId);
    } else {
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      keys
        .filter(
          (key) =>
            typeof key === "string" &&
            (key === workspaceId ||
              key.startsWith(`${workspaceId}::`)),
        )
        .forEach((key) => store.delete(key));
    }
    await complete(transaction);
  } finally {
    database.close();
  }
}

export function createContentEditorOutboxController(
  workspaceId: string,
  driver: ContentEditorOutboxDriver = {
    read: readContentEditorOutboxEntry,
    write: writeContentEditorOutbox,
    clear: clearContentEditorOutbox,
  },
  scopeId = workspaceId,
) {
  const storageId =
    scopeId === workspaceId
      ? workspaceId
      : `${workspaceId}::${scopeId}`;
  let queue = Promise.resolve();
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const result = queue.catch(() => undefined).then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
  const record = (
    baseRevision: number,
    edits: ReadonlyArray<StaleRecoveryEdit>,
    attempt?: ContentEditorOutboxRecord["attempt"],
  ): Promise<void> =>
    serialize(() =>
      driver.write({
        workspaceId: storageId,
        baseRevision,
        edits,
        ...(attempt === undefined ? {} : { attempt }),
      }),
    );

  return Object.freeze({
    read: async () => {
      const stored =
        (await driver.read(storageId)) ??
        (storageId === workspaceId
          ? null
          : await driver.read(workspaceId));
      if (stored === null) {
        return null;
      }
      if (stored.workspaceId !== storageId) {
        await serialize(async () => {
          await driver.write({ ...stored, workspaceId: storageId });
          await driver.clear(stored.workspaceId);
        });
      }
      return { ...stored, workspaceId };
    },
    snapshot: (
      baseRevision: number,
      edits: ReadonlyArray<StaleRecoveryEdit>,
    ) => record(baseRevision, edits),
    saveAttempt: (
      baseRevision: number,
      edits: ReadonlyArray<StaleRecoveryEdit>,
      attempt: NonNullable<ContentEditorOutboxRecord["attempt"]>,
    ) => record(baseRevision, edits, attempt),
    clear: () => serialize(() => driver.clear(storageId)),
  });
}

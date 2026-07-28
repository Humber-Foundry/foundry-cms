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

type StoredContentEditorOutboxRecord = ContentEditorOutboxRecord &
  Readonly<{ updatedAt?: number }>;

function outboxTimestamp(): number {
  return typeof performance === "undefined"
    ? Date.now()
    : performance.timeOrigin + performance.now();
}

type ContentEditorOutboxDriver = Readonly<{
  read(workspaceId: string): Promise<ContentEditorOutboxRecord | null>;
  list?(
    workspaceId: string,
  ): Promise<ReadonlyArray<ContentEditorOutboxRecord>>;
  write(record: ContentEditorOutboxRecord): Promise<void>;
  clear(workspaceId: string): Promise<void>;
  replace?(
    record: ContentEditorOutboxRecord,
    sourceWorkspaceIds: ReadonlyArray<string>,
  ): Promise<void>;
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

function parseOutboxCandidate(
  candidate: unknown,
  workspaceId: string,
): ContentEditorOutboxRecord | null {
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
    ).size !== candidate.edits.length ||
    ("attempt" in candidate &&
      candidate.attempt !== undefined &&
      !isOutboxAttempt(candidate.attempt))
  ) {
    return null;
  }
  return candidate as ContentEditorOutboxRecord;
}

async function listContentEditorOutboxEntries(
  workspaceId: string,
): Promise<ReadonlyArray<ContentEditorOutboxRecord>> {
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    const result = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await complete(transaction);
    return Array.isArray(result)
      ? result
          .map((candidate) =>
            parseOutboxCandidate(candidate, workspaceId),
          )
          .filter(
            (candidate): candidate is ContentEditorOutboxRecord =>
              candidate !== null,
          )
      : [];
  } finally {
    database.close();
  }
}

async function readContentEditorOutboxEntry(
  workspaceId: string,
): Promise<ContentEditorOutboxRecord | null> {
  const entries = await listContentEditorOutboxEntries(workspaceId);
  return workspaceId.includes("::")
    ? entries.find(({ workspaceId: id }) => id === workspaceId) ?? null
    : entries[0] ?? null;
}

export async function readContentEditorOutbox(
  workspaceId: string,
): Promise<ContentEditorOutboxRecord | null> {
  const record = await readContentEditorOutboxEntry(workspaceId);
  return record === null
    ? null
    : {
        workspaceId: workspaceId.split("::")[0]!,
        baseRevision: record.baseRevision,
        edits: record.edits,
        ...(record.attempt === undefined
          ? {}
          : { attempt: record.attempt }),
      };
}

export async function writeContentEditorOutbox(
  record: ContentEditorOutboxRecord,
): Promise<void> {
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(
      structuredClone({ ...record, updatedAt: outboxTimestamp() }),
    );
    await complete(transaction);
  } finally {
    database.close();
  }
}

async function replaceContentEditorOutboxEntries(
  record: ContentEditorOutboxRecord,
  sourceWorkspaceIds: ReadonlyArray<string>,
): Promise<void> {
  const database = await openOutbox();
  try {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    store.put(structuredClone({ ...record, updatedAt: outboxTimestamp() }));
    sourceWorkspaceIds
      .filter((sourceWorkspaceId) => sourceWorkspaceId !== record.workspaceId)
      .forEach((sourceWorkspaceId) => store.delete(sourceWorkspaceId));
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
    list: listContentEditorOutboxEntries,
    write: writeContentEditorOutbox,
    clear: clearContentEditorOutbox,
    replace: replaceContentEditorOutboxEntries,
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
    read: async (
      isScopeLive: (scopeId: string) => Promise<boolean> = async () =>
        true,
    ) => {
      const own = await driver.read(storageId);
      const candidates =
        driver.list === undefined
          ? own === null && storageId !== workspaceId
            ? [await driver.read(workspaceId)].filter(
                (
                  candidate,
                ): candidate is ContentEditorOutboxRecord =>
                  candidate !== null,
              )
            : own === null
              ? []
              : [own]
          : await driver.list(workspaceId);
      const recoverable: ContentEditorOutboxRecord[] = [];
      for (const candidate of candidates) {
        if (candidate.workspaceId === storageId) {
          recoverable.push(candidate);
          continue;
        }
        const separator = `${workspaceId}::`;
        if (
          !candidate.workspaceId.startsWith(separator) ||
          !(await isScopeLive(candidate.workspaceId.slice(separator.length)))
        ) {
          recoverable.push(candidate);
        }
      }
      if (recoverable.length === 0) {
        return null;
      }
      recoverable.sort(
        (first, second) =>
          ((first as StoredContentEditorOutboxRecord).updatedAt ?? 0) -
          ((second as StoredContentEditorOutboxRecord).updatedAt ?? 0),
      );
      const attempted = recoverable.filter(
        ({ attempt }) => attempt !== undefined,
      );
      const selected: ContentEditorOutboxRecord[] =
        attempted.length === 0 ? [] : [attempted.at(-1)!];
      if (attempted.length === 0) {
        const ownCandidate = recoverable.find(
          ({ workspaceId: id }) => id === storageId,
        );
        const candidates =
          ownCandidate === undefined
            ? recoverable
            : [
                ownCandidate,
                ...recoverable.filter(
                  ({ workspaceId: id }) => id !== storageId,
                ),
              ];
        const claimedEdits = new Map<string, StaleRecoveryEdit>();
        for (const candidate of candidates) {
          const conflicts = candidate.edits.some((edit) => {
            const claimed = claimedEdits.get(edit.path);
            return (
              claimed !== undefined &&
              (claimed.baseValue !== edit.baseValue ||
                claimed.value !== edit.value)
            );
          });
          if (conflicts) {
            continue;
          }
          selected.push(candidate);
          candidate.edits.forEach((edit) =>
            claimedEdits.set(edit.path, edit),
          );
        }
      }
      const editsByPath = new Map<string, StaleRecoveryEdit>();
      for (const candidate of selected) {
        for (const edit of candidate.edits) {
          editsByPath.set(edit.path, edit);
        }
      }
      const latest = selected.at(-1)!;
      const stored: ContentEditorOutboxRecord = {
        workspaceId: storageId,
        baseRevision: Math.max(
          ...selected.map(({ baseRevision }) => baseRevision),
        ),
        edits: [...editsByPath.values()],
        ...(selected.length === 1 && latest.attempt !== undefined
          ? { attempt: latest.attempt }
          : {}),
      };
      if (stored.edits.length > maximumOutboxEdits) {
        throw new Error("content_editor_outbox_too_large");
      }
      if (
        selected.some(({ workspaceId: id }) => id !== storageId)
      ) {
        await serialize(async () => {
          if (driver.replace === undefined) {
            await driver.write(stored);
            for (const candidate of selected) {
              if (candidate.workspaceId !== storageId) {
                await driver.clear(candidate.workspaceId);
              }
            }
          } else {
            await driver.replace(
              stored,
              selected.map(({ workspaceId: id }) => id),
            );
          }
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

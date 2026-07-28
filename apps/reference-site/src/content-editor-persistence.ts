"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { ContentEditorState } from "./content-editor-history";
import {
  createContentEditorOutboxController,
  type ContentEditorOutboxRecord,
} from "./content-editor-outbox";
import type { StaleRecoveryEdit } from "./content-editor-recovery";

type SaveAttempt = NonNullable<ContentEditorOutboxRecord["attempt"]>;

export type ContentEditorWorkspaceCoordinator = Readonly<{
  run<Value>(operation: () => Promise<Value>): Promise<Value>;
}>;

export async function withContentEditorWorkspaceCoordination<Value>(
  coordinator: Promise<ContentEditorWorkspaceCoordinator>,
  operation: () => Promise<Value>,
): Promise<Value> {
  return (await coordinator).run(operation);
}

export async function createContentEditorWorkspaceCoordinator(
  workspaceId: string,
  locks: Pick<LockManager, "request"> | undefined =
    typeof navigator === "undefined" ? undefined : navigator.locks,
): Promise<ContentEditorWorkspaceCoordinator> {
  const lockName = `foundry-cms:content-editor:${workspaceId}`;
  return {
    run<Value>(operation: () => Promise<Value>): Promise<Value> {
      return locks === undefined
        ? operation()
        : locks.request(lockName, operation);
    },
  };
}

export type ContentEditorPersistenceState = Readonly<{
  phase: "loading" | "ready" | "snapshot" | "attempt";
  attempt: SaveAttempt | null;
}>;

export type ContentEditorPersistenceEvent =
  | Readonly<{ type: "hydrated" }>
  | Readonly<{ type: "snapshot" }>
  | Readonly<{ type: "attempt"; attempt: SaveAttempt }>
  | Readonly<{ type: "acknowledged" }>;

export function contentEditorPersistenceTransition(
  state: ContentEditorPersistenceState,
  event: ContentEditorPersistenceEvent,
): ContentEditorPersistenceState {
  switch (event.type) {
    case "hydrated":
      return {
        ...state,
        phase: state.attempt === null ? "ready" : "attempt",
      };
    case "snapshot":
      return { phase: "snapshot", attempt: null };
    case "attempt":
      return { phase: "attempt", attempt: event.attempt };
    case "acknowledged":
      return { phase: "ready", attempt: null };
  }
}

export function outboxAttemptMatchesWorkspace(
  record: ContentEditorOutboxRecord,
  workspaceId: string,
): boolean {
  if (record.attempt === undefined) {
    return false;
  }
  try {
    const body: unknown = JSON.parse(record.attempt.body);
    return (
      typeof body === "object" &&
      body !== null &&
      "workspaceId" in body &&
      body.workspaceId === workspaceId &&
      "baseRevision" in body &&
      body.baseRevision === record.baseRevision
    );
  } catch {
    return false;
  }
}

export function useContentEditorPersistence({
  workspaceId,
  baseRevision,
  edits,
  editorStatus,
  recoveryBlocked,
  onStorageError,
}: {
  workspaceId: string;
  baseRevision: number;
  edits: ReadonlyArray<StaleRecoveryEdit>;
  editorStatus: ContentEditorState["status"];
  recoveryBlocked: boolean;
  onStorageError(message: string): void;
}) {
  const controller = useMemo(
    () => {
      let tabId = crypto.randomUUID();
      try {
        const key = "foundry-cms:content-editor-tab";
        tabId = window.sessionStorage.getItem(key) ?? tabId;
        window.sessionStorage.setItem(key, tabId);
      } catch {
        // The random in-memory tab scope still prevents this mounted editor
        // from clearing another tab's durable command.
      }
      return createContentEditorOutboxController(
        workspaceId,
        undefined,
        tabId,
      );
    },
    [workspaceId],
  );
  const coordinationWaiter = useRef<{
    promise: Promise<ContentEditorWorkspaceCoordinator>;
    resolve(coordinator: ContentEditorWorkspaceCoordinator): void;
  } | null>(null);
  if (coordinationWaiter.current === null) {
    let resolve!: (coordinator: ContentEditorWorkspaceCoordinator) => void;
    const promise = new Promise<ContentEditorWorkspaceCoordinator>((next) => {
      resolve = next;
    });
    coordinationWaiter.current = { promise, resolve };
  }
  const [coordinated, setCoordinated] = useState(false);
  const [lifecycle, transition] = useReducer(
    contentEditorPersistenceTransition,
    { phase: "loading", attempt: null },
  );
  const coordinate = <Value,>(
    operation: () => Promise<Value>,
  ): Promise<Value> =>
    withContentEditorWorkspaceCoordination(
      coordinationWaiter.current!.promise,
      operation,
    );

  useEffect(() => {
    let cancelled = false;
    void createContentEditorWorkspaceCoordinator(workspaceId).then(
      (coordinator) => {
        if (cancelled) {
          return;
        }
        coordinationWaiter.current!.resolve(coordinator);
        setCoordinated(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (
      !coordinated ||
      lifecycle.phase === "loading" ||
      lifecycle.attempt !== null ||
      editorStatus === "saving" ||
      editorStatus === "conflict" ||
      editorStatus === "stale" ||
      recoveryBlocked
    ) {
      return;
    }
    const persistence =
      edits.length === 0
        ? controller.clear()
        : controller.snapshot(baseRevision, edits);
    void persistence.catch(() => {
      onStorageError(
        "Browser recovery storage could not record the latest edit. Keep this tab open until it is saved.",
      );
    });
  }, [
    baseRevision,
    controller,
    editorStatus,
    edits,
    lifecycle.attempt,
    lifecycle.phase,
    onStorageError,
    coordinated,
    recoveryBlocked,
  ]);

  return {
    coordinated,
    ready: lifecycle.phase !== "loading",
    attempt: lifecycle.attempt,
    read: () => coordinate(() => controller.read()),
    finishHydration: () => transition({ type: "hydrated" }),
    restoreAttempt: (attempt: SaveAttempt) =>
      transition({ type: "attempt", attempt }),
    discardAttempt: () => transition({ type: "snapshot" }),
    async preserveWithoutAttempt() {
      transition({ type: "snapshot" });
      await coordinate(() => controller.snapshot(baseRevision, edits));
    },
    async beginAttempt(body: string) {
      const attempt =
        lifecycle.attempt ?? {
          body,
          idempotencyKey: crypto.randomUUID(),
      };
      transition({ type: "attempt", attempt });
      try {
        await coordinate(() =>
          controller.saveAttempt(baseRevision, edits, attempt),
        );
      } catch (error) {
        onStorageError(
          "Browser recovery storage is unavailable. This save will continue with its stable retry identity.",
        );
      }
      return attempt;
    },
    async acknowledge() {
      transition({ type: "acknowledged" });
      await coordinate(() => controller.clear());
    },
    clear: () => coordinate(() => controller.clear()),
    snapshot: (snapshotEdits: ReadonlyArray<StaleRecoveryEdit>) =>
      coordinate(() =>
        controller.snapshot(baseRevision, snapshotEdits),
      ),
  };
}

export function useContentEditorAutosave({
  enabled,
  fingerprint,
  onSave,
}: {
  enabled: boolean;
  fingerprint: string;
  onSave(): void;
}) {
  const lastSavedFingerprint = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const save = () => {
    if (lastSavedFingerprint.current === fingerprint) {
      return;
    }
    lastSavedFingerprint.current = fingerprint;
    onSaveRef.current();
  };

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = window.setTimeout(save, 250);
    window.addEventListener("blur", save);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("blur", save);
    };
  }, [enabled, fingerprint]);
}

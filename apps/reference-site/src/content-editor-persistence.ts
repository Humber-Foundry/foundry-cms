"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import type { ContentEditorState } from "./content-editor-history";
import {
  createContentEditorOutboxController,
  type ContentEditorOutboxRecord,
} from "./content-editor-outbox";
import type { StaleRecoveryEdit } from "./content-editor-recovery";

type SaveAttempt = NonNullable<ContentEditorOutboxRecord["attempt"]>;
const contentEditorTabStorageKey = "foundry-cms:content-editor-tab-id";

export function contentEditorTabId(
  storage?: Pick<Storage, "getItem" | "setItem">,
  createId: () => string = () => crypto.randomUUID(),
): string {
  let target = storage;
  if (target === undefined && typeof window !== "undefined") {
    try {
      target = window.sessionStorage;
    } catch {
      // A fresh fallback still isolates this tab for its current lifetime.
    }
  }
  try {
    const existing = target?.getItem(contentEditorTabStorageKey);
    if (
      existing !== null &&
      existing !== undefined &&
      /^[A-Za-z0-9._:-]{8,128}$/u.test(existing)
    ) {
      return existing;
    }
    const created = createId();
    target?.setItem(contentEditorTabStorageKey, created);
    return created;
  } catch {
    return createId();
  }
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
    () =>
      createContentEditorOutboxController(
        workspaceId,
        contentEditorTabId(),
      ),
    [workspaceId],
  );
  const [lifecycle, transition] = useReducer(
    contentEditorPersistenceTransition,
    { phase: "loading", attempt: null },
  );

  useEffect(() => {
    if (
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
    recoveryBlocked,
  ]);

  return {
    ready: lifecycle.phase !== "loading",
    attempt: lifecycle.attempt,
    read: () => controller.read(),
    finishHydration: () => transition({ type: "hydrated" }),
    restoreAttempt: (attempt: SaveAttempt) =>
      transition({ type: "attempt", attempt }),
    discardAttempt: () => transition({ type: "snapshot" }),
    async preserveWithoutAttempt() {
      transition({ type: "snapshot" });
      await controller.snapshot(baseRevision, edits);
    },
    async beginAttempt(body: string) {
      const attempt =
        lifecycle.attempt ?? {
          body,
          idempotencyKey: crypto.randomUUID(),
      };
      transition({ type: "attempt", attempt });
      try {
        await controller.saveAttempt(baseRevision, edits, attempt);
      } catch {
        onStorageError(
          "Browser recovery storage is unavailable. This save will continue with its stable retry identity.",
        );
      }
      return attempt;
    },
    async acknowledge() {
      transition({ type: "acknowledged" });
      await controller.clear();
    },
    clear: () => controller.clear(),
    snapshot: (snapshotEdits: ReadonlyArray<StaleRecoveryEdit>) =>
      controller.snapshot(baseRevision, snapshotEdits),
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

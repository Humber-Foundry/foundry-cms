"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { ContentEditorState } from "./content-editor-history";
import {
  createContentEditorOutboxController,
  type ContentEditorOutboxRecord,
} from "./content-editor-outbox";
import type { StaleRecoveryEdit } from "./content-editor-recovery";

type SaveAttempt = NonNullable<ContentEditorOutboxRecord["attempt"]>;

export type ContentEditorWorkspaceClaim = Readonly<{
  acquired: boolean;
  release(): void;
}>;

export async function claimContentEditorWorkspace(
  workspaceId: string,
  locks: Pick<LockManager, "request"> | undefined =
    typeof navigator === "undefined" ? undefined : navigator.locks,
  retryDelay: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 25)),
): Promise<ContentEditorWorkspaceClaim> {
  if (locks === undefined) {
    return { acquired: false, release() {} };
  }
  let releaseHold = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const lockName = `foundry-cms:content-editor:${workspaceId}`;
  const acquire = (): Promise<boolean> =>
    new Promise((resolve) => {
      void locks
        .request(lockName, { ifAvailable: true }, async (lock) => {
          resolve(lock !== null);
          if (lock !== null) {
            await hold;
          }
        })
        .catch(() => resolve(false));
    });
  let ownsWorkspace = await acquire();
  if (!ownsWorkspace) {
    await retryDelay();
    ownsWorkspace = await acquire();
  }
  return {
    acquired: ownsWorkspace,
    release() {
      releaseHold();
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
    () => createContentEditorOutboxController(workspaceId),
    [workspaceId],
  );
  const ownershipWaiter = useRef<{
    promise: Promise<ContentEditorWorkspaceClaim>;
    resolve(claim: ContentEditorWorkspaceClaim): void;
  } | null>(null);
  if (ownershipWaiter.current === null) {
    let resolve!: (claim: ContentEditorWorkspaceClaim) => void;
    const promise = new Promise<ContentEditorWorkspaceClaim>((next) => {
      resolve = next;
    });
    ownershipWaiter.current = { promise, resolve };
  }
  const [ownership, setOwnership] = useState<
    "claiming" | "owned" | "blocked"
  >("claiming");
  const [lifecycle, transition] = useReducer(
    contentEditorPersistenceTransition,
    { phase: "loading", attempt: null },
  );

  useEffect(() => {
    let cancelled = false;
    let activeClaim: ContentEditorWorkspaceClaim | undefined;
    void claimContentEditorWorkspace(workspaceId).then((claim) => {
      if (cancelled) {
        claim.release();
        return;
      }
      activeClaim = claim;
      ownershipWaiter.current!.resolve(claim);
      setOwnership(claim.acquired ? "owned" : "blocked");
      if (!claim.acquired) {
        onStorageError(
          "This workspace is already open in another tab, or this browser cannot coordinate editing. Close the other tab and reload before editing here.",
        );
      }
    });
    return () => {
      cancelled = true;
      activeClaim?.release();
    };
  }, [onStorageError, workspaceId]);

  useEffect(() => {
    if (
      ownership !== "owned" ||
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
    ownership,
    recoveryBlocked,
  ]);

  return {
    owned: ownership === "owned",
    blocked: ownership === "blocked",
    ready: lifecycle.phase !== "loading",
    attempt: lifecycle.attempt,
    async read() {
      const claim = await ownershipWaiter.current!.promise;
      return claim.acquired ? controller.read() : null;
    },
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

import { describe, expect, it } from "vitest";

import {
  contentEditorTabId,
  contentEditorPersistenceTransition,
  outboxAttemptMatchesWorkspace,
  type ContentEditorPersistenceState,
} from "./content-editor-persistence";

const loading: ContentEditorPersistenceState = {
  phase: "loading",
  attempt: null,
};
const attempt = {
  body: '{"workspaceId":"workspace_transition","baseRevision":6}',
  idempotencyKey: "persistence-transition-0001",
} as const;

describe("content editor persistence lifecycle", () => {
  it("moves from hydration through snapshot, stable attempt, and acknowledgement", () => {
    const ready = contentEditorPersistenceTransition(loading, {
      type: "hydrated",
    });
    const snapshotted = contentEditorPersistenceTransition(ready, {
      type: "snapshot",
    });
    const saving = contentEditorPersistenceTransition(snapshotted, {
      type: "attempt",
      attempt,
    });
    const acknowledged = contentEditorPersistenceTransition(saving, {
      type: "acknowledged",
    });

    expect([ready.phase, snapshotted.phase, saving, acknowledged]).toEqual([
      "ready",
      "snapshot",
      { phase: "attempt", attempt },
      { phase: "ready", attempt: null },
    ]);
  });

  it("keeps a recovered stable attempt when hydration finishes", () => {
    const recovered = contentEditorPersistenceTransition(loading, {
      type: "attempt",
      attempt,
    });

    expect(
      contentEditorPersistenceTransition(recovered, { type: "hydrated" }),
    ).toEqual({ phase: "attempt", attempt });
  });

  it("abandons a failed attempt before accepting a different edit", () => {
    const saving = contentEditorPersistenceTransition(loading, {
      type: "attempt",
      attempt,
    });

    expect(
      contentEditorPersistenceTransition(saving, { type: "snapshot" }),
    ).toEqual({ phase: "snapshot", attempt: null });
  });

  it("replays an attempt only for its matching workspace and base revision", () => {
    const record = {
      workspaceId: "workspace_transition",
      tabId: "tab_transition",
      baseRevision: 6,
      edits: [],
      attempt,
    };

    expect(
      outboxAttemptMatchesWorkspace(record, "workspace_transition"),
    ).toBe(true);
    expect(
      outboxAttemptMatchesWorkspace(record, "workspace_other"),
    ).toBe(false);
    expect(
      outboxAttemptMatchesWorkspace(
        { ...record, baseRevision: 7 },
        "workspace_transition",
      ),
    ).toBe(false);
  });

  it("keeps one durable owner ID per browser tab", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    };

    expect(contentEditorTabId(storage, () => "tab_owner_0001")).toBe(
      "tab_owner_0001",
    );
    expect(contentEditorTabId(storage, () => "tab_owner_0002")).toBe(
      "tab_owner_0001",
    );
  });
});

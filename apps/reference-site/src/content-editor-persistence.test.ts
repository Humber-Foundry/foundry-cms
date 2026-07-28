import { describe, expect, it } from "vitest";

import {
  createContentEditorWorkspaceCoordinator,
  contentEditorPersistenceTransition,
  outboxAttemptMatchesWorkspace,
  withContentEditorWorkspaceCoordination,
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

  it("coordinates persistence operations without making a browser tab the workspace owner", async () => {
    const queues = new Map<string, Promise<unknown>>();
    const locks = {
      async request(
        name: string,
        callback: () => Promise<unknown>,
      ) {
        const previous = queues.get(name) ?? Promise.resolve();
        const current = previous.then(callback);
        queues.set(name, current.catch(() => undefined));
        return current;
      },
    };

    const first = await createContentEditorWorkspaceCoordinator(
      "workspace_shared",
      locks as never,
    );
    const duplicate = await createContentEditorWorkspaceCoordinator(
      "workspace_shared",
      locks as never,
    );
    let active = 0;
    let maximumActive = 0;
    const operation = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    };
    await Promise.all([
      first.run(operation),
      duplicate.run(operation),
    ]);
    expect(maximumActive).toBe(1);
  });

  it("continues without Web Locks when coordination is unavailable", async () => {
    let driverCalls = 0;

    const coordinator = createContentEditorWorkspaceCoordinator(
      "workspace_without_locks",
      undefined,
    );
    await withContentEditorWorkspaceCoordination(
      coordinator,
      async () => {
        driverCalls += 1;
      },
    );
    expect(driverCalls).toBe(1);
  });
});

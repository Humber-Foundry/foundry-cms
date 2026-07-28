import { describe, expect, it } from "vitest";

import {
  createContentEditorOutboxController,
  type ContentEditorOutboxRecord,
} from "./content-editor-outbox";

function memoryDriver() {
  const records = new Map<string, ContentEditorOutboxRecord>();
  return {
    records,
    driver: {
      async read(workspaceId: string) {
        const record =
          records.get(workspaceId) ??
          (workspaceId.includes("::")
            ? undefined
            : [...records.values()].find(({ workspaceId: candidate }) =>
                candidate.startsWith(`${workspaceId}::`),
              ));
        return structuredClone(record ?? null);
      },
      async write(record: ContentEditorOutboxRecord) {
        records.set(record.workspaceId, structuredClone(record));
      },
      async list(workspaceId: string) {
        return structuredClone(
          [...records.values()].filter(
            ({ workspaceId: candidate }) =>
              candidate === workspaceId ||
              candidate.startsWith(`${workspaceId}::`),
          ),
        );
      },
      async clear(workspaceId: string) {
        records.delete(workspaceId);
      },
      async replace(
        record: ContentEditorOutboxRecord,
        sourceWorkspaceIds: ReadonlyArray<string>,
      ) {
        records.set(record.workspaceId, structuredClone(record));
        sourceWorkspaceIds
          .filter((sourceWorkspaceId) => sourceWorkspaceId !== record.workspaceId)
          .forEach((sourceWorkspaceId) => records.delete(sourceWorkspaceId));
      },
    },
  };
}

const edit = {
  path: "section_hero.title",
  baseValue: "Original title",
  value: "Recovered before autosave",
} as const;

describe("content editor outbox controller", () => {
  it("hydrates an edit recorded before the autosave debounce starts", async () => {
    const { driver } = memoryDriver();
    const activeTab = createContentEditorOutboxController(
      "workspace_crash_recovery",
      driver,
    );
    await activeTab.snapshot(7, [edit]);

    const reloadedTab = createContentEditorOutboxController(
      "workspace_crash_recovery",
      driver,
    );
    await expect(reloadedTab.read()).resolves.toEqual({
      workspaceId: "workspace_crash_recovery",
      baseRevision: 7,
      edits: [edit],
    });
  });

  it("serializes the attempt upgrade after the latest edit snapshot", async () => {
    const { driver } = memoryDriver();
    const controller = createContentEditorOutboxController(
      "workspace_attempt",
      driver,
    );

    const snapshot = controller.snapshot(3, [edit]);
    const attempt = controller.saveAttempt(3, [edit], {
      body: '{"workspaceId":"workspace_attempt","baseRevision":3}',
      idempotencyKey: "stable-attempt-0001",
    });
    await Promise.all([snapshot, attempt]);

    await expect(controller.read()).resolves.toEqual({
      workspaceId: "workspace_attempt",
      baseRevision: 3,
      edits: [edit],
      attempt: {
        body: '{"workspaceId":"workspace_attempt","baseRevision":3}',
        idempotencyKey: "stable-attempt-0001",
      },
    });
  });

  it("continues with the newest snapshot after one storage failure", async () => {
    const { driver, records } = memoryDriver();
    let fail = true;
    const controller = createContentEditorOutboxController(
      "workspace_retry",
      {
        ...driver,
        async write(record) {
          if (fail) {
            fail = false;
            throw new Error("storage_unavailable");
          }
          await driver.write(record);
        },
      },
    );

    await expect(controller.snapshot(1, [edit])).rejects.toThrow(
      "storage_unavailable",
    );
    await controller.snapshot(1, [{ ...edit, value: "Newest value" }]);

    expect(records.get("workspace_retry")?.edits).toEqual([
      { ...edit, value: "Newest value" },
    ]);
  });

  it("keeps a closed tab's snapshot discoverable by the next workspace owner", async () => {
    const { driver, records } = memoryDriver();
    const closedTab = createContentEditorOutboxController(
      "workspace_shared",
      driver,
      "tab_closed",
    );
    await closedTab.snapshot(2, [edit]);

    const reopenedTab = createContentEditorOutboxController(
      "workspace_shared",
      driver,
      "tab_reopened",
    );
    await expect(reopenedTab.read(async () => false)).resolves.toEqual({
      workspaceId: "workspace_shared",
      baseRevision: 2,
      edits: [edit],
    });
    expect(records.has("workspace_shared::tab_closed")).toBe(false);
    expect(records.get("workspace_shared::tab_reopened")?.edits).toEqual([
      edit,
    ]);
    await reopenedTab.clear();
    expect(records.has("workspace_shared::tab_reopened")).toBe(false);
  });

  it("keeps concurrent tab attempts in separate recovery records", async () => {
    const { driver, records } = memoryDriver();
    const first = createContentEditorOutboxController(
      "workspace_shared",
      driver,
      "tab_first",
    );
    const second = createContentEditorOutboxController(
      "workspace_shared",
      driver,
      "tab_second",
    );
    await first.saveAttempt(2, [edit], {
      body: '{"workspaceId":"workspace_shared","baseRevision":2}',
      idempotencyKey: "stable-attempt-first-0001",
    });
    await second.saveAttempt(2, [{ ...edit, path: "section_proof.quote" }], {
      body: '{"workspaceId":"workspace_shared","baseRevision":2}',
      idempotencyKey: "stable-attempt-second-0001",
    });

    await first.clear();

    expect(
      records.get("workspace_shared::tab_first"),
    ).toBeUndefined();
    expect(
      records.get("workspace_shared::tab_second")?.attempt?.idempotencyKey,
    ).toBe("stable-attempt-second-0001");
  });

  it("does not claim a live tab's durable record", async () => {
    const { driver, records } = memoryDriver();
    const first = createContentEditorOutboxController(
      "workspace_live",
      driver,
      "tab_first",
    );
    const duplicate = createContentEditorOutboxController(
      "workspace_live",
      driver,
      "tab_duplicate",
    );
    await first.snapshot(2, [edit]);

    await expect(
      duplicate.read(async (scopeId) => scopeId === "tab_first"),
    ).resolves.toBeNull();
    expect(records.get("workspace_live::tab_first")?.edits).toEqual([
      edit,
    ]);
  });

  it("atomically reconciles every orphaned tab record", async () => {
    const { driver, records } = memoryDriver();
    const first = createContentEditorOutboxController(
      "workspace_orphans",
      driver,
      "tab_first",
    );
    const second = createContentEditorOutboxController(
      "workspace_orphans",
      driver,
      "tab_second",
    );
    const reopened = createContentEditorOutboxController(
      "workspace_orphans",
      driver,
      "tab_reopened",
    );
    await first.snapshot(2, [edit]);
    await second.snapshot(3, [
      { ...edit, path: "section_proof.quote", value: "Second tab" },
    ]);

    await expect(reopened.read(async () => false)).resolves.toEqual({
      workspaceId: "workspace_orphans",
      baseRevision: 3,
      edits: [
        edit,
        { ...edit, path: "section_proof.quote", value: "Second tab" },
      ],
    });
    expect([...records.keys()]).toEqual([
      "workspace_orphans::tab_reopened",
    ]);
  });
});

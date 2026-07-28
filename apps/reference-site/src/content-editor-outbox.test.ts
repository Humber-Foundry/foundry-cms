import { describe, expect, it } from "vitest";

import {
  createContentEditorOutboxController,
  type ContentEditorOutboxRecord,
} from "./content-editor-outbox";

function memoryDriver() {
  const records = new Map<string, ContentEditorOutboxRecord>();
  const key = (workspaceId: string, tabId: string) =>
    `${workspaceId}:${tabId}`;
  return {
    records,
    driver: {
      async read(workspaceId: string, tabId: string) {
        return structuredClone(records.get(key(workspaceId, tabId)) ?? null);
      },
      async write(record: ContentEditorOutboxRecord) {
        records.set(
          key(record.workspaceId, record.tabId),
          structuredClone(record),
        );
      },
      async clear(workspaceId: string, tabId: string) {
        records.delete(key(workspaceId, tabId));
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
      "tab_crash_recovery",
      driver,
    );
    await activeTab.snapshot(7, [edit]);

    const reloadedTab = createContentEditorOutboxController(
      "workspace_crash_recovery",
      "tab_crash_recovery",
      driver,
    );
    await expect(reloadedTab.read()).resolves.toEqual({
      workspaceId: "workspace_crash_recovery",
      tabId: "tab_crash_recovery",
      baseRevision: 7,
      edits: [edit],
    });
  });

  it("serializes the attempt upgrade after the latest edit snapshot", async () => {
    const { driver } = memoryDriver();
    const controller = createContentEditorOutboxController(
      "workspace_attempt",
      "tab_attempt",
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
      tabId: "tab_attempt",
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
      "tab_retry",
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

    expect(records.get("workspace_retry:tab_retry")?.edits).toEqual([
      { ...edit, value: "Newest value" },
    ]);
  });

  it("isolates snapshots and acknowledgement between tabs in one workspace", async () => {
    const { driver } = memoryDriver();
    const first = createContentEditorOutboxController(
      "workspace_shared",
      "tab_first",
      driver,
    );
    const second = createContentEditorOutboxController(
      "workspace_shared",
      "tab_second",
      driver,
    );
    await first.snapshot(2, [edit]);
    await second.snapshot(2, [{ ...edit, value: "Second tab value" }]);
    await first.clear();

    await expect(first.read()).resolves.toBeNull();
    await expect(second.read()).resolves.toEqual({
      workspaceId: "workspace_shared",
      tabId: "tab_second",
      baseRevision: 2,
      edits: [{ ...edit, value: "Second tab value" }],
    });
  });
});

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { ContentEditor } from "../../components/content-editor";
import { listContentEditorOutboxRecords } from "../content-editor-outbox";
import { settleBrowserDraftStorage } from "./browser-draft-storage";
import { browserRevision } from "./browser-revision";

const workspaceId = "workspace_browser_settle";

/** Polls until `read` returns a value, for up to two seconds. */
async function waitUntil<Value>(
  read: () => Promise<Value | undefined> | Value | undefined,
): Promise<Value> {
  for (let index = 0; index < 100; index += 1) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  throw new Error("condition_not_reached");
}

describe("browser draft storage between tests", () => {
  const mounted: Array<ReturnType<typeof createRoot>> = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of mounted.splice(0)) {
      flushSync(() => root.unmount());
    }
    document.body.replaceChildren();
  });

  it("lets a save that outlived its editor finish, then empties draft storage", async () => {
    const sentWorkspaces: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === "string") {
          sentWorkspaces.push(
            (JSON.parse(init.body) as { workspaceId?: unknown }).workspaceId,
          );
        }
        return new Promise<Response>(() => undefined);
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(ContentEditor, {
          csrfToken: "csrf-settle",
          initialRevision: browserRevision(workspaceId),
          initialPreviewUrl: "/preview/settle",
          activeWorkspaceUrl: "/dash?workspace=settle",
        }),
      );
    });
    const editButton = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".mode-toggle button"),
    ).find((button) => button.textContent === "Edit");
    await userEvent.click(editButton!);
    const siteName = await waitUntil(() => {
      const input = host.querySelector<HTMLInputElement>(
        `[data-field-path="${referenceSiteDefinition.site.id}.name"] input`,
      );
      return input !== null && !input.disabled ? input : undefined;
    });

    // Hold the workspace lock, as a slow machine would, so the autosave is
    // still waiting for browser storage when its editor goes away.
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockName = `foundry-cms:content-editor:${workspaceId}`;
    await new Promise<void>((acquired) => {
      void navigator.locks.request(lockName, () => {
        acquired();
        return lockHeld;
      });
    });
    await userEvent.fill(siteName, "Saved after the editor closed");
    await waitUntil(async () => {
      const { pending = [] } = await navigator.locks.query();
      return pending.some(({ name }) => name === lockName) ? true : undefined;
    });
    flushSync(() => mounted.splice(0).forEach((editor) => editor.unmount()));
    window.setTimeout(releaseLock, 100);

    await settleBrowserDraftStorage();

    expect(sentWorkspaces).toContain(workspaceId);
    expect(await listContentEditorOutboxRecords(workspaceId)).toEqual([]);
  });

  it("removes stale-workspace recovery copies from local storage", async () => {
    window.localStorage.setItem(
      "foundry-cms:stale-edit-recovery:workspace_browser_settle:recovery",
      "[]",
    );

    await settleBrowserDraftStorage();

    expect(window.localStorage.length).toBe(0);
  });
});

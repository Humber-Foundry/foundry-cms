import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

// The dashboard's own stylesheet, so the measurements below read the real
// rules rather than the browser's unstyled defaults.
import "../app/dash/dashboard.css";

import {
  DashboardActionMenu,
  type DashboardAction,
} from "./dashboard-action-menu";
import { DashboardList, DashboardListRow } from "./dashboard-list";

async function waitFor<Value>(read: () => Value | undefined): Promise<Value> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("DashboardActionMenu, mouse and keyboard", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLElement | undefined;
  let chosen: string[] = [];

  afterEach(() => {
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
    root = undefined;
    host = undefined;
    chosen = [];
  });

  function renderMenu() {
    const actions: DashboardAction[] = [
      { id: "rename", label: "Rename", onSelect: () => chosen.push("rename") },
      {
        id: "duplicate",
        label: "Duplicate",
        onSelect: () => chosen.push("duplicate"),
      },
      {
        id: "delete",
        label: "Delete",
        tone: "destructive",
        onSelect: () => chosen.push("delete"),
      },
    ];
    host = document.createElement("div");
    // Every dashboard screen renders inside `.dashboard`, which is where the
    // spacing, type and colour tokens are declared. Without it the rules
    // below would measure lengths the real dashboard never uses.
    host.className = "dashboard";
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(DashboardActionMenu, {
          label: "Actions for About us",
          actions,
        }),
      );
    });
    return host;
  }

  const menu = () =>
    (host!.querySelector('[role="menu"]') as HTMLElement | null) ?? undefined;
  const closed = () => (menu() === undefined ? true : undefined);

  it("opens on a press and puts focus on the first action", async () => {
    renderMenu();
    const trigger = page.getByRole("button", { name: "Actions for About us" });

    await userEvent.click(trigger);

    const list = await waitFor(menu);
    expect(list.textContent).toContain("Rename");
    expect(trigger.element().getAttribute("aria-expanded")).toBe("true");
    await waitFor(() =>
      (document.activeElement as HTMLElement | null)?.textContent === "Rename"
        ? true
        : undefined,
    );
  });

  it("moves between actions with the arrow keys and wraps round at the ends", async () => {
    renderMenu();
    await userEvent.click(
      page.getByRole("button", { name: "Actions for About us" }),
    );
    await waitFor(menu);

    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() =>
      document.activeElement?.textContent === "Duplicate" ? true : undefined,
    );

    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() =>
      document.activeElement?.textContent === "Rename" ? true : undefined,
    );

    // Up from the first action reaches the last one.
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() =>
      document.activeElement?.textContent === "Delete" ? true : undefined,
    );

    await userEvent.keyboard("{Home}");
    await waitFor(() =>
      document.activeElement?.textContent === "Rename" ? true : undefined,
    );

    await userEvent.keyboard("{End}");
    await waitFor(() =>
      document.activeElement?.textContent === "Delete" ? true : undefined,
    );
  });

  it("opens from the keyboard alone and runs the action the owner chose", async () => {
    renderMenu();
    await userEvent.tab();
    const trigger = page.getByRole("button", { name: "Actions for About us" });
    expect(trigger.element()).toBe(document.activeElement);

    await userEvent.keyboard("{ArrowDown}");
    await waitFor(menu);
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() =>
      document.activeElement?.textContent === "Duplicate" ? true : undefined,
    );
    await userEvent.keyboard("{Enter}");

    await waitFor(closed);
    expect(chosen).toEqual(["duplicate"]);
    // Running an action returns focus to the button, so a keyboard user is
    // never dropped somewhere unexpected.
    expect(trigger.element()).toBe(document.activeElement);
  });

  it("closes on Escape and puts focus back on the button", async () => {
    renderMenu();
    const trigger = page.getByRole("button", { name: "Actions for About us" });

    await userEvent.click(trigger);
    await waitFor(menu);
    await userEvent.keyboard("{Escape}");

    await waitFor(closed);
    expect(chosen).toEqual([]);
    expect(trigger.element()).toBe(document.activeElement);
    expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Tab and carries on from the button, not from the top of the page", async () => {
    renderMenu();
    const after = document.createElement("button");
    after.type = "button";
    after.textContent = "After";
    document.body.append(after);

    await userEvent.click(
      page.getByRole("button", { name: "Actions for About us" }),
    );
    await waitFor(menu);
    await userEvent.tab();

    await waitFor(closed);
    // The menu closes and focus lands on the next control after the button.
    // Without the handler's own focus call it would fall to the body, and
    // the next Tab would start again at the top of the page.
    expect(document.activeElement).toBe(after);
  });

  it("closes when the button is pressed again, and when a press lands outside it", async () => {
    renderMenu();
    const trigger = page.getByRole("button", { name: "Actions for About us" });

    await userEvent.click(trigger);
    await waitFor(menu);
    await userEvent.click(trigger);
    await waitFor(closed);

    await userEvent.click(trigger);
    await waitFor(menu);
    await userEvent.click(document.body);
    await waitFor(closed);
  });

  it("draws a 44px button on a phone, like every other dashboard control", async () => {
    await page.viewport(390, 800);
    renderMenu();
    const trigger = host!.querySelector(
      ".dash-action-menu-button",
    ) as HTMLElement;
    const box = trigger.getBoundingClientRect();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    await page.viewport(1024, 768);
  });
});

describe("DashboardListRow, the whole row is one link", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLElement | undefined;
  let followed: string[] = [];

  afterEach(() => {
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
    root = undefined;
    host = undefined;
    followed = [];
  });

  function renderRow() {
    host = document.createElement("div");
    // Every dashboard screen renders inside `.dashboard`, which is where the
    // spacing, type and colour tokens are declared. Without it the rules
    // below would measure lengths the real dashboard never uses.
    host.className = "dashboard";
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        <DashboardList label="Your pages">
          <DashboardListRow
            href="#about"
            title="About us"
            note="/about"
            actions={
              <DashboardActionMenu
                label="Actions for About us"
                actions={[
                  { id: "rename", label: "Rename", onSelect: () => {} },
                ]}
              />
            }
          />
        </DashboardList>,
      );
    });
    // The test records where a press would go instead of letting the browser
    // navigate away from the test page.
    host.addEventListener("click", (event) => {
      const link = (event.target as HTMLElement).closest("a");
      if (link !== null) {
        event.preventDefault();
        followed.push(link.getAttribute("href") ?? "");
      }
    });
    return host;
  }

  it("follows the link from a press anywhere on the row", async () => {
    await page.viewport(1024, 768);
    renderRow();
    const row = host!.querySelector(".dash-row") as HTMLElement;
    const box = row.getBoundingClientRect();

    // A point well away from the title, near the left edge of the row and
    // below the words: the link's cover reaches it, so the row opens.
    const target = document.elementFromPoint(box.left + 4, box.bottom - 4);
    expect(target).not.toBeNull();
    (target as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(followed).toEqual(["#about"]);
  });

  it("does not follow the link when the action menu is pressed", async () => {
    await page.viewport(1024, 768);
    renderRow();

    await userEvent.click(
      page.getByRole("button", { name: "Actions for About us" }),
    );
    await waitFor(() =>
      host!.querySelector('[role="menu"]') === null ? undefined : true,
    );

    expect(followed).toEqual([]);
  });
});

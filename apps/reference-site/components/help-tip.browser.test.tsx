import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

// The dashboard's own stylesheet, so the tap-target assertion below measures
// the real rule, not the browser's unstyled default.
import "../app/dash/dashboard.css";

import { HelpTip } from "./help-tip";

async function waitFor<Value>(read: () => Value | undefined): Promise<Value> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition_not_reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("HelpTip, keyboard, touch and screen-reader reachability", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLElement | undefined;

  afterEach(() => {
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
    root = undefined;
    host = undefined;
  });

  function renderHelpTip() {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(HelpTip, {
          label: "What's a revision?",
          children: "A revision is a saved version of your content.",
        }),
      );
    });
    return host;
  }

  it("opens on a click or tap and reports its state through aria-expanded", async () => {
    renderHelpTip();
    const trigger = page.getByRole("button", { name: "What's a revision?" });

    await userEvent.click(trigger);

    const panel = await waitFor(() =>
      host!.querySelector(".help-tip-panel") ?? undefined,
    );
    expect(panel.textContent).toContain("A revision is a saved version");
    expect(trigger.element().getAttribute("aria-expanded")).toBe("true");
    expect(trigger.element().getAttribute("aria-describedby")).toBe(
      panel.id,
    );
  });

  it("opens and closes from the keyboard alone — Tab, Enter, Escape", async () => {
    renderHelpTip();
    await userEvent.tab();
    const trigger = page.getByRole("button", { name: "What's a revision?" });
    expect(trigger.element()).toBe(document.activeElement);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => host!.querySelector(".help-tip-panel") ?? undefined);

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      host!.querySelector(".help-tip-panel") === null ? true : undefined,
    );
    // Escape closes the panel without moving focus off the button, so a
    // keyboard user is never dropped somewhere unexpected.
    expect(trigger.element()).toBe(document.activeElement);
  });

  it("closes when the button is activated again, and when focus tabs away", async () => {
    renderHelpTip();
    const trigger = page.getByRole("button", { name: "What's a revision?" });

    await userEvent.click(trigger);
    await waitFor(() => host!.querySelector(".help-tip-panel") ?? undefined);
    await userEvent.click(trigger);
    await waitFor(() =>
      host!.querySelector(".help-tip-panel") === null ? true : undefined,
    );

    await userEvent.click(trigger);
    await waitFor(() => host!.querySelector(".help-tip-panel") ?? undefined);
    await userEvent.tab();
    await waitFor(() =>
      host!.querySelector(".help-tip-panel") === null ? true : undefined,
    );
  });

  it("draws a small glyph on a wide screen but extends its real hit area to 44px", async () => {
    await page.viewport(1024, 768);
    renderHelpTip();
    const trigger = host!.querySelector(".help-tip-trigger") as HTMLElement;
    const visible = trigger.getBoundingClientRect();
    // The drawn button stays small so it never crowds the term beside it —
    // dashboard.css extends the tappable area with an invisible ::before
    // rather than growing the glyph itself.
    expect(visible.height).toBeLessThan(30);

    const before = getComputedStyle(trigger, "::before");
    const inset = Number.parseFloat(before.inset || before.top);
    const tappableHeight = visible.height + Math.abs(inset) * 2;
    expect(tappableHeight).toBeGreaterThanOrEqual(44);
  });

  it("draws a real 44px button on a phone, matching every other dashboard control", async () => {
    await page.viewport(390, 800);
    renderHelpTip();
    const trigger = host!.querySelector(".help-tip-trigger") as HTMLElement;
    const visible = trigger.getBoundingClientRect();
    expect(visible.height).toBeGreaterThanOrEqual(44);
    expect(visible.width).toBeGreaterThanOrEqual(44);
    await page.viewport(1024, 768);
  });
});

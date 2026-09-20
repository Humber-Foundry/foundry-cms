import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

// The dashboard's own stylesheet, so the assertions below measure the real
// rules — the card border, radius, background and 44px row height — not the
// browser's unstyled default. See help-tip.browser.test.tsx for the same
// pattern.
import "../app/dash/dashboard.css";

import { AttentionList } from "./attention-list";

describe("Overview's Needs attention list (issue #222)", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let host: HTMLElement | undefined;

  afterEach(() => {
    if (root !== undefined) flushSync(() => root!.unmount());
    document.body.replaceChildren();
    root = undefined;
    host = undefined;
  });

  function render() {
    host = document.createElement("div");
    // Every dashboard token (--dash-line, --dash-radius, --dash-surface,
    // --dash-control-height) is scoped to `.dashboard` — the same wrapper
    // `app/dash/layout.tsx` renders in the real app — so the assertions
    // below see the real computed values instead of the unstyled default.
    host.className = "dashboard";
    document.body.append(host);
    root = createRoot(host);
    flushSync(() => {
      root!.render(
        createElement(AttentionList, {
          items: [
            {
              key: "one",
              href: "/dash/review/preview-1",
              label: "A draft waiting for your review",
            },
            {
              key: "two",
              href: "/dash/blog?workspace=w#blog-post-1",
              label: 'Draft Assistant asked to publish "Tide notes" at 9am',
            },
          ],
        }),
      );
    });
    return host;
  }

  it("draws the same card the empty state uses: a border, radius and background", () => {
    render();
    const list = host!.querySelector(".attention-list") as HTMLElement;
    const style = getComputedStyle(list);
    expect(Number.parseFloat(style.borderTopWidth)).toBeGreaterThan(0);
    expect(style.borderTopStyle).toBe("solid");
    expect(Number.parseFloat(style.borderRadius)).toBeGreaterThan(0);
    expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("gives every row's link a real 44px tall tap target", () => {
    render();
    const links = Array.from(
      host!.querySelectorAll<HTMLAnchorElement>(".attention-list a"),
    );
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });

  it("draws a divider between rows, but not above the first row", () => {
    render();
    const rows = Array.from(host!.querySelectorAll<HTMLLIElement>(".attention-list li"));
    expect(rows).toHaveLength(2);
    expect(Number.parseFloat(getComputedStyle(rows[0]!).borderTopWidth)).toBe(
      0,
    );
    expect(
      Number.parseFloat(getComputedStyle(rows[1]!).borderTopWidth),
    ).toBeGreaterThan(0);
  });

  it("makes the whole sentence the link, with no bare text beside it", () => {
    render();
    const rows = Array.from(host!.querySelectorAll<HTMLLIElement>(".attention-list li"));
    for (const row of rows) {
      expect(row.children).toHaveLength(1);
      expect(row.children[0]!.tagName).toBe("A");
      const outsideText = Array.from(row.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      expect(outsideText).toBe("");
    }
  });
});

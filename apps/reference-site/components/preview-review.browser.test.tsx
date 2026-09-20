import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import type { ContentChangeSummary } from "@humber-foundry/application";

// The real stylesheets, in the order the dashboard loads them, so the size and
// spacing assertions below exercise the real rules instead of the browser's
// unstyled defaults. `globals.css` carries the shared button look.
import "../app/globals.css";
import "../app/dash/dashboard.css";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import { PreviewReviewDecision } from "./preview-review-decision";
import { PreviewReviewSummary } from "./preview-review-summary";

const summary: ContentChangeSummary = {
  pages: [
    {
      pageId: "page_home",
      title: "Home",
      path: "/",
      state: "changed",
      changedFields: ["section_hero.title"],
    },
    {
      pageId: "page_about",
      title: "About us",
      path: "/about",
      state: "created",
      changedFields: [],
    },
  ],
  changedDocuments: [
    "Home — Hero: Hero title",
    "About us — new page at /about",
  ],
  designChanges: ["Site settings — Colours"],
  publicEffect:
    "Visitors get a new page at /about. The page at / changes. " +
    "This review does not approve or publish anything.",
};

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (root !== undefined) flushSync(() => root!.unmount());
  document.body.replaceChildren();
  await page.viewport(1024, 768);
});

function renderScreen() {
  const host = document.createElement("main");
  host.className = "dashboard-main";
  const shell = document.createElement("div");
  shell.className = "dashboard";
  shell.append(host);
  document.body.append(shell);
  root = createRoot(host);
  flushSync(() => {
    root!.render(
      createElement("div", null, [
        createElement(PreviewReviewSummary, {
          key: "summary",
          agentName: "helper.example",
          preparedAt: new Date(Date.now() - 3_600_000).toISOString(),
          summary,
        }),
        createElement(
          "section",
          { key: "answer", className: "panel" },
          createElement("h2", null, "Your answer"),
          createElement(PreviewReviewDecision, {
            previewId: "preview_11111111-2222-3333-4444-555555555555",
            previewHref:
              "/dash/review/preview_11111111-2222-3333-4444-555555555555/preview",
            mutationToken: "csrf-review-test",
          }),
        ),
      ]),
    );
  });
  return host;
}

function primaryControls(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>(".review-decision .button")]
    .filter((control) => control.classList.contains("button-primary"))
    .map((control) => control.textContent);
}

function pressAskForChanges(host: HTMLElement) {
  const ask = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Ask for changes",
  );
  if (ask === undefined) throw new Error("ask_button_missing");
  flushSync(() => ask.click());
}

function approveButton(host: HTMLElement) {
  const approve = [
    ...host.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Approve this draft");
  if (approve === undefined) throw new Error("approve_button_missing");
  return approve;
}

/**
 * Press "Open the preview" and let its server read settle. The link opens the
 * preview in a new tab; the read beside it is what turns Approve on.
 */
async function openThePreview(host: HTMLElement) {
  const link = host.querySelector<HTMLAnchorElement>(
    ".review-decision a.button",
  );
  if (link === null) throw new Error("preview_link_missing");
  link.removeAttribute("target");
  link.addEventListener("click", (event) => event.preventDefault());
  link.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("Draft review screen", () => {
  it("keeps every control at the 44px touch size on a phone", async () => {
    await page.viewport(390, 844);
    const host = renderScreen();
    pressAskForChanges(host);

    const controls = [
      ...host.querySelectorAll<HTMLElement>(".review-decision .button"),
      ...host.querySelectorAll<HTMLElement>(".review-decision textarea"),
    ];
    // Open the preview, Approve, Ask for changes, Send this answer, and the
    // box the reason is typed into.
    expect(controls).toHaveLength(5);
    for (const control of controls) {
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: "../../../.shots/review-screen-390.png" });
  });

  it("reads as one column of panels on a wide screen", async () => {
    await page.viewport(1440, 900);
    const host = renderScreen();

    const panels = [...host.querySelectorAll<HTMLElement>(".panel")];
    expect(panels.length).toBeGreaterThan(0);
    // Panels stack; none sits beside another, so no row can be left ragged.
    const lefts = new Set(
      panels.map((panel) => Math.round(panel.getBoundingClientRect().left)),
    );
    expect(lefts.size).toBe(1);
    await page.screenshot({ path: "../../../.shots/review-screen-1440.png" });
  });

  it("turns Approve on only after the server serves that exact preview", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response("<html></html>", { status: 200 });
    });
    const host = renderScreen();
    const approve = approveButton(host);

    expect(approve.disabled).toBe(true);
    // It must also look unavailable, not only report it to a screen reader.
    const offColour = getComputedStyle(approve).backgroundColor;
    await openThePreview(host);

    // It asks the small read whether the preview still stands, not the
    // preview page itself, so one click renders the preview once.
    expect(asked).toEqual([
      "/api/foundry-cms/preview-reviews/preview_11111111-2222-3333-4444-555555555555",
    ]);
    expect(approve.disabled).toBe(false);
    // `.button` fades its background over 180ms, so read the settled colour.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getComputedStyle(approve).backgroundColor).not.toBe(offColour);
  });

  it("leaves Approve off when the server no longer serves that preview", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("gone", { status: 404 }),
    );
    const host = renderScreen();
    const approve = approveButton(host);

    await openThePreview(host);

    expect(approve.disabled).toBe(true);
    expect(host.textContent).toContain("no longer available");
  });

  it("gives the answer one primary colour only, open or closed", async () => {
    const host = renderScreen();

    // Colour carries the hierarchy, so only the decision itself is primary.
    expect(primaryControls(host)).toEqual(["Approve this draft"]);

    pressAskForChanges(host);

    // The reason form adds a control, and it must not add a second primary.
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(primaryControls(host)).toEqual(["Approve this draft"]);
  });

  it("shows the reason field only after Ask for changes is pressed", async () => {
    const host = renderScreen();
    expect(host.querySelector("textarea")).toBeNull();

    pressAskForChanges(host);

    const reason = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(reason).not.toBeNull();
    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Send this answer",
    );
    // An empty reason is no reason at all.
    expect(send?.disabled).toBe(true);
  });
});

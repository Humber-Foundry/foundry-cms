import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { homePage, listEditableSiteFields } from "@humber-foundry/site-definition";

import { ContentEditor } from "./content-editor";
import { listEditorPages } from "../src/editor-page-selection";
import { withSecondPage } from "../src/test-support/two-page-site-definition";

/**
 * The editor on a draft with two pages.
 *
 * The installed reference site has one page, and creating a page is ticket
 * #159, so a second page comes from a test fixture. These checks cover one
 * page's fields at a time, a way to reach the other page, and the canvas
 * drawing whichever page the owner opened.
 */

const twoPages = withSecondPage();
const home = homePage(twoPages);
const second = twoPages.pages[1]!;
const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> =
  [];

function mount(selectedPageId: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(
      createElement(ContentEditor, {
        csrfToken: "csrf-pages-test",
        initialRevision: {
          workspaceId: "workspace_pages_test",
          revision: 2,
          definition: twoPages,
          inputs: {
            contentHash: "pages-content-hash",
            schemaVersion: "1.7.0",
            rendererVersion: "renderer-pages",
            productionBase: "published-pages",
          },
          createdAt: "2026-09-18T00:00:00.000Z",
          createdBy: "membership-pages",
        } as never,
        initialPreviewUrl: "/preview/pages",
        activeWorkspaceUrl: "/dash/pages?workspace=workspace_pages_test",
        heading: "Pages",
        fieldGroups: ["Page", "Navigation", "Footer", "SEO"],
        showComposition: true,
        showPublicationHistory: true,
        selectedPageId,
        pages: listEditorPages(twoPages),
      }),
    );
  });
  mounted.push({ host, root });
  return host;
}

/** The field paths the screen is actually showing. */
function shownPaths(host: HTMLElement): string[] {
  return [...host.querySelectorAll("[data-field-path]")].map(
    (element) => element.getAttribute("data-field-path") ?? "",
  );
}

/**
 * Press Edit, which is how the owner reaches the canvas and the page settings
 * beside it. The editor opens on Browse, so a check of the settings has to
 * start here — on every page alike, now that every page has a canvas.
 */
function startEditing(host: HTMLElement): HTMLElement {
  const edit = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Edit",
  );
  expect(edit).toBeDefined();
  flushSync(() => edit!.click());
  return host;
}

afterEach(() => {
  while (mounted.length > 0) {
    const { host, root } = mounted.pop()!;
    flushSync(() => root.unmount());
    host.remove();
  }
});

describe("the editor on a chosen page", () => {
  it("shows the chosen page's fields and leaves the other page's out", () => {
    const host = startEditing(mount(second.id));
    const paths = shownPaths(host);
    const fields = listEditableSiteFields(twoPages);
    // Design tokens belong to the Design destination, so Pages never shows
    // them whichever page is open.
    const otherPagePaths = fields
      .filter((field) => field.pageId === home.id && field.group !== "Design")
      .map(({ path }) => path);
    const thisPagePaths = fields
      .filter((field) => field.pageId === second.id && field.group !== "Design")
      .map(({ path }) => path);

    expect(thisPagePaths.length).toBeGreaterThan(0);
    for (const path of thisPagePaths) expect(paths).toContain(path);
    for (const path of otherPagePaths) expect(paths).not.toContain(path);
  });

  it("keeps the fields that belong to the whole site on every page", () => {
    const siteWidePaths = listEditableSiteFields(twoPages)
      .filter((field) => field.pageId === undefined && field.group !== "Design")
      .map(({ path }) => path);
    expect(siteWidePaths.length).toBeGreaterThan(0);

    const onSecond = shownPaths(startEditing(mount(second.id)));
    for (const path of siteWidePaths) expect(onSecond).toContain(path);
  });

  it("offers every page, with the open one chosen", () => {
    const host = mount(second.id);
    const chooser = host.querySelector<HTMLSelectElement>(
      ".editor-page-choose select",
    );
    expect(chooser).not.toBeNull();
    expect([...chooser!.options].map((option) => option.value)).toEqual(
      twoPages.pages.map((page) => page.id),
    );
    expect([...chooser!.options].map((option) => option.text)).toEqual(
      twoPages.pages.map((page) => page.title),
    );
    expect(chooser!.value).toBe(second.id);
  });

  it("offers a way back to the list of pages", () => {
    const host = mount(second.id);
    const all = host.querySelector<HTMLAnchorElement>(".editor-page-all");
    expect(all?.getAttribute("href")).toBe(
      "/dash/pages?workspace=workspace_pages_test",
    );
  });

  // #227: the editor's own top-bar way out uses the shared back-link
  // component, keeping its old wording and target (Overview, with the
  // workspace carried on the query string).
  it("shows the shared back link in the top bar, to Overview", () => {
    const host = mount(second.id);
    const back = host.querySelector<HTMLAnchorElement>(
      ".editor-topbar .dash-back-link",
    );
    expect(back).not.toBeNull();
    expect(back?.getAttribute("href")).toBe(
      "/dash?workspace=workspace_pages_test",
    );
    expect(back?.textContent?.trim()).toBe("←Dashboard");
  });

  it("draws the canvas on the home page", () => {
    const host = startEditing(mount(home.id));
    expect(host.querySelector(".editor-immersive")).not.toBeNull();
    expect(host.querySelector(".editor-stage")).not.toBeNull();
  });

  // The whole point of this ticket: a second page gets the same canvas as the
  // home page, with the same way to add, move and remove its sections.
  it("draws the canvas on a second page too", () => {
    const host = startEditing(mount(second.id));
    expect(host.querySelector(".editor-immersive")).not.toBeNull();
    expect(host.querySelector(".editor-stage")).not.toBeNull();
    expect(
      [...host.querySelectorAll("summary")].some(
        (summary) => summary.textContent?.includes("Add section"),
      ),
    ).toBe(true);
  });

  // The words that told the owner the canvas was unfinished on other pages
  // are gone, because the canvas now works on every page.
  it("no longer says sections are unavailable on any page", () => {
    for (const pageId of [home.id, second.id]) {
      expect(mount(pageId).textContent).not.toContain(
        "not ready yet",
      );
    }
  });

  it("shows the home page's fields when the address names no page", () => {
    const host = mount(home.id);
    // The home page's canvas hides the field list behind the side panel, so
    // the check is on what the editor resolved: the switcher's chosen page.
    const chooser = host.querySelector<HTMLSelectElement>(
      ".editor-page-choose select",
    );
    expect(chooser!.value).toBe(home.id);
  });
});

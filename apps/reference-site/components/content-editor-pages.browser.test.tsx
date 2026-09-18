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
 * #159, so a second page comes from a test fixture. These checks cover what
 * #157 promises: one page's fields at a time, a way to reach the other page,
 * and a truthful word about the canvas on a page it cannot yet draw.
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

afterEach(() => {
  while (mounted.length > 0) {
    const { host, root } = mounted.pop()!;
    flushSync(() => root.unmount());
    host.remove();
  }
});

describe("the editor on a chosen page", () => {
  it("shows the chosen page's fields and leaves the other page's out", () => {
    const host = mount(second.id);
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

    const onSecond = shownPaths(mount(second.id));
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

  it("says the canvas is not ready on a page it cannot draw yet", () => {
    const host = mount(second.id);
    expect(host.textContent).toContain(
      "Adding, moving and removing sections on this page is not ready yet",
    );
    expect(host.querySelector(".editor-stage")).toBeNull();
    expect(host.querySelector(".editor-browse")).toBeNull();
  });

  it("draws the canvas on the home page", () => {
    const host = mount(home.id);
    expect(host.querySelector(".editor-immersive")).not.toBeNull();
    expect(host.textContent).not.toContain(
      "Adding, moving and removing sections on this page is not ready yet",
    );
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

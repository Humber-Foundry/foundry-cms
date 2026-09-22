import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageLifecycleList } from "./page-lifecycle-controls";
import type { PageActionSummary } from "../src/page-lifecycle-view";

/**
 * The Pages list controls, driven the way an owner drives them.
 *
 * The browser journey in `scripts/verify-page-lifecycle-browser.mjs` walks the
 * whole thing against the real dashboard, but it cannot show the warning about
 * changing the web address of a page that is already on the live site: the
 * reference site is published with one page, and that page is the home page,
 * whose address never changes. So that warning is checked here, on a draft
 * fixture, along with the other refusals the screen shows on its own.
 */

const homeRow: PageActionSummary = {
  id: "page_home",
  title: "Foundry Reference",
  path: "/",
  isHome: true,
  publishedState: "on-your-site",
  slug: "",
  isPublished: true,
  canDelete: false,
  blockedBy: [],
  duplicateTitle: "Foundry Reference copy",
  duplicateSlug: "foundry-reference-copy",
};

const publishedRow: PageActionSummary = {
  id: "page_aaaaaaaaaaaaaaaaaaaa",
  title: "About us",
  path: "/about-us",
  isHome: false,
  publishedState: "on-your-site",
  slug: "about-us",
  isPublished: true,
  canDelete: true,
  blockedBy: [],
  duplicateTitle: "About us copy",
  duplicateSlug: "about-us-copy",
};

const linkedRow: PageActionSummary = {
  ...publishedRow,
  id: "page_bbbbbbbbbbbbbbbbbbbb",
  title: "Contact",
  path: "/contact",
  slug: "contact",
  publishedState: "not-published",
  isPublished: false,
  canDelete: false,
  blockedBy: [
    { name: "Navigation — Talk to us", href: "/dash/pages?page=page_home" },
    { name: "About us — Get in touch", href: "/dash/pages?page=page_aaaa" },
  ],
  duplicateTitle: "Contact copy",
  duplicateSlug: "contact-copy",
};

const mounted: Array<{ host: HTMLElement; root: ReturnType<typeof createRoot> }> =
  [];

function mount(pages: ReadonlyArray<PageActionSummary>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(
      createElement(PageLifecycleList, {
        pages,
        workspaceId: "workspace_lifecycle_test",
        schemaVersion: "1.7.0",
        baseRevision: 3,
        csrfToken: "csrf-lifecycle-test",
        workspaceUrl: "/dash/pages?workspace=workspace_lifecycle_test",
      }),
    );
  });
  mounted.push({ host, root });
  return host;
}

afterEach(() => {
  for (const { host, root } of mounted.splice(0)) {
    flushSync(() => root.unmount());
    host.remove();
  }
});

/** Press a button by the name a screen reader would read. */
function press(host: HTMLElement, name: string) {
  const button = [...host.querySelectorAll("button")].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "")
        .trim() === name,
  );
  if (button === undefined) {
    throw new Error(`no_button_named:${name}`);
  }
  flushSync(() => button.click());
  return button;
}

/** The action menu on one page's row, opened. */
function openMenu(host: HTMLElement, pageTitle: string) {
  press(host, `Actions for ${pageTitle}`);
  const menu = host.querySelector(".dash-action-menu-list");
  if (menu === null) throw new Error(`no_menu_for:${pageTitle}`);
  return menu;
}

/** The words on the items of one page's open action menu. */
function menuItems(host: HTMLElement, pageTitle: string) {
  return [...openMenu(host, pageTitle).querySelectorAll("button")].map(
    (item) => (item.textContent ?? "").trim(),
  );
}

/** Choose one item from a page's action menu, the way the owner does. */
function chooseAction(host: HTMLElement, pageTitle: string, label: string) {
  const item = [...openMenu(host, pageTitle).querySelectorAll("button")].find(
    (candidate) => (candidate.textContent ?? "").trim() === label,
  );
  if (item === undefined) {
    throw new Error(`no_action_named:${pageTitle}:${label}`);
  }
  flushSync(() => item.click());
}

/** Type into a box the way a person does, so React sees every keystroke. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function box(host: HTMLElement, id: string) {
  return host.querySelector<HTMLInputElement>(`#${id}`)!;
}

function dialogText(host: HTMLElement) {
  return host.querySelector(".page-lifecycle-dialog")!.textContent ?? "";
}

/**
 * Answer the next revision request with one refusal, then put the real
 * `fetch` back when the test ends.
 */
function refuseWith(status: number, body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  restoreFetch.push(() => {
    globalThis.fetch = original;
  });
}

const restoreFetch: Array<() => void> = [];

afterEach(() => {
  for (const restore of restoreFetch.splice(0)) restore();
});

/** The summary sentence over the dialog, or `null` when there is none. */
function summarySentence(host: HTMLElement) {
  return host.querySelector(".page-lifecycle-message")?.textContent ?? null;
}

describe("The list", () => {
  it("shows each page as one row that opens the editor", () => {
    const host = mount([homeRow, publishedRow]);
    const links = [...host.querySelectorAll<HTMLAnchorElement>(".dash-row-link")];
    expect(links.map((link) => link.getAttribute("href"))).toStrictEqual([
      "/dash/pages?workspace=workspace_lifecycle_test&page=page_home",
      "/dash/pages?workspace=workspace_lifecycle_test&page=page_aaaaaaaaaaaaaaaaaaaa",
    ]);
  });

  it("labels the path, and writes the home page's path as a slash", () => {
    const host = mount([homeRow, publishedRow]);
    const notes = [...host.querySelectorAll(".dash-row-note")].map(
      (note) => note.textContent,
    );
    expect(notes).toStrictEqual(["Address: /", "Address: /about-us"]);
  });

  it("says the state in one or two words", () => {
    const host = mount([
      homeRow,
      { ...publishedRow, publishedState: "changed-since-publish" },
      linkedRow,
    ]);
    const states = [...host.querySelectorAll(".dash-state")].map(
      (state) => state.textContent,
    );
    expect(states).toStrictEqual(["Published", "Draft changes", "Not published"]);
  });

  it("offers no way to add a page, because an agent adds pages", () => {
    const host = mount([homeRow]);
    const names = [...host.querySelectorAll("button")].map((button) =>
      (button.getAttribute("aria-label") ?? button.textContent ?? "").trim(),
    );
    expect(names).not.toContain("New page");
  });
});

describe("The row action menu", () => {
  it("holds Rename, Duplicate and Delete for an ordinary page", () => {
    const host = mount([homeRow, publishedRow]);
    expect(menuItems(host, "About us")).toStrictEqual([
      "Rename",
      "Duplicate",
      "Delete",
    ]);
  });

  it("leaves Delete out of the home page's menu", () => {
    const host = mount([homeRow, publishedRow]);
    expect(menuItems(host, "Foundry Reference")).toStrictEqual([
      "Rename",
      "Duplicate",
    ]);
  });

  it("shows no disabled control and no help tip beside the home page", () => {
    const host = mount([homeRow]);
    expect(host.querySelectorAll(".help-tip-trigger").length).toBe(0);
    openMenu(host, "Foundry Reference");
    const disabled = [...host.querySelectorAll("button")].filter(
      (button) => button.disabled,
    );
    expect(disabled).toStrictEqual([]);
  });
});

describe("Rename", () => {
  it("says nothing until the web address of a published page changes", () => {
    const host = mount([homeRow, publishedRow]);
    chooseAction(host, "About us", "Rename");
    expect(dialogText(host)).not.toContain("stops working");
    typeInto(box(host, "page-lifecycle-address"), "our-story");
    expect(dialogText(host)).toContain("This page is on your site at /about-us");
    expect(dialogText(host)).toContain("that old address stops working");
  });

  it("says nothing when only the page name changes", () => {
    const host = mount([homeRow, publishedRow]);
    chooseAction(host, "About us", "Rename");
    typeInto(box(host, "page-lifecycle-name"), "Our story");
    expect(dialogText(host)).not.toContain("stops working");
  });

  it("says nothing for a page that is not on the live site yet", () => {
    const host = mount([homeRow, { ...publishedRow, isPublished: false }]);
    chooseAction(host, "About us", "Rename");
    typeInto(box(host, "page-lifecycle-address"), "our-story");
    expect(dialogText(host)).not.toContain("stops working");
  });
});

describe("Duplicate", () => {
  it("opens with a name and an address for the copy", () => {
    const host = mount([homeRow, publishedRow]);
    chooseAction(host, "About us", "Duplicate");
    expect(box(host, "page-lifecycle-name").value).toBe("About us copy");
    expect(box(host, "page-lifecycle-address").value).toBe("about-us-copy");
  });
});

describe("Delete", () => {
  it("names every link that must change first, and offers to open each one", () => {
    const host = mount([homeRow, linkedRow]);
    chooseAction(host, "Contact", "Delete");
    const blockers = [
      ...host.querySelectorAll<HTMLAnchorElement>(".page-lifecycle-blockers a"),
    ];
    expect(blockers.map((link) => link.textContent)).toStrictEqual([
      "Navigation — Talk to us",
      "About us — Get in touch",
    ]);
    expect(blockers[0]!.getAttribute("href")).toBe(
      "/dash/pages?page=page_home",
    );
    expect(dialogText(host)).toContain("still linked from 2 places");
    const submit = [...host.querySelectorAll("button")].find(
      (candidate) => (candidate.textContent ?? "").trim() === "Delete page",
    )!;
    expect(submit.disabled).toBe(true);
  });

  it("says what a delete does to a page that is on the live site", () => {
    const host = mount([homeRow, publishedRow]);
    chooseAction(host, "About us", "Delete");
    expect(dialogText(host)).toContain("About us at /about-us");
    expect(dialogText(host)).toContain(
      "stays on your live site until you publish",
    );
    const submit = [...host.querySelectorAll("button")].find(
      (candidate) => (candidate.textContent ?? "").trim() === "Delete page",
    )!;
    expect(submit.disabled).toBe(false);
  });

  it("says that nothing changes for a page that was never published", () => {
    const host = mount([
      homeRow,
      { ...linkedRow, blockedBy: [], canDelete: true },
    ]);
    chooseAction(host, "Contact", "Delete");
    expect(dialogText(host)).toContain("nothing on your live site changes");
  });
});

describe("A refusal the server sends back", () => {
  it("shows an empty page name beside the Page name box and says nothing else", async () => {
    refuseWith(422, {
      error: "validation_failed",
      reason: "page_title_refused",
      fields: { title: "Give this page a name." },
      references: [],
    });
    const host = mount([homeRow, publishedRow]);
    chooseAction(host, "About us", "Rename");
    typeInto(box(host, "page-lifecycle-name"), "");
    press(host, "Save changes");

    await vi.waitFor(() => {
      expect(
        host.querySelector("#page-lifecycle-name-error")?.textContent,
      ).toBe("Give this page a name.");
    });
    // Every refusal named a box the dialog draws, so the dialog writes no
    // sentence of its own over the top of them.
    expect(summarySentence(host)).toBeNull();
    expect(box(host, "page-lifecycle-name").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("writes a sentence for a refusal that names no box on the dialog", async () => {
    refuseWith(422, {
      error: "validation_failed",
      reason: "page_not_found",
      fields: { pageId: "That page is not in this draft any more." },
      references: [],
    });
    const host = mount([homeRow, publishedRow]);
    chooseAction(host, "About us", "Delete");
    press(host, "Delete page");

    await vi.waitFor(() => {
      expect(summarySentence(host)).toBe(
        "That page is not in this draft any more.",
      );
    });
  });
});

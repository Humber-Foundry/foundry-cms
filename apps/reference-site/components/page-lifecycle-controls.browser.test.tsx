import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

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

describe("New page", () => {
  it("offers a web address that follows the page name", () => {
    const host = mount([homeRow]);
    press(host, "New page");
    typeInto(box(host, "page-lifecycle-name"), "What We Do!");
    expect(box(host, "page-lifecycle-address").value).toBe("what-we-do");
  });

  it("stops following the name once the owner writes their own address", () => {
    const host = mount([homeRow]);
    press(host, "New page");
    typeInto(box(host, "page-lifecycle-name"), "What we do");
    typeInto(box(host, "page-lifecycle-address"), "services");
    typeInto(box(host, "page-lifecycle-name"), "What we do for you");
    expect(box(host, "page-lifecycle-address").value).toBe("services");
  });

  it("offers a blank page and two layouts to start from", () => {
    const host = mount([homeRow]);
    press(host, "New page");
    const labels = [
      ...host.querySelectorAll(".page-lifecycle-layouts strong"),
    ].map((element) => element.textContent);
    expect(labels).toStrictEqual(["Blank", "Introduction", "What you offer"]);
  });
});

describe("Rename", () => {
  it("says nothing until the web address of a published page changes", () => {
    const host = mount([homeRow, publishedRow]);
    press(host, "Rename About us");
    expect(dialogText(host)).not.toContain("stops working");
    typeInto(box(host, "page-lifecycle-address"), "our-story");
    expect(dialogText(host)).toContain("This page is on your site at /about-us");
    expect(dialogText(host)).toContain("that old address stops working");
  });

  it("says nothing when only the page name changes", () => {
    const host = mount([homeRow, publishedRow]);
    press(host, "Rename About us");
    typeInto(box(host, "page-lifecycle-name"), "Our story");
    expect(dialogText(host)).not.toContain("stops working");
  });

  it("says nothing for a page that is not on the live site yet", () => {
    const host = mount([homeRow, { ...publishedRow, isPublished: false }]);
    press(host, "Rename About us");
    typeInto(box(host, "page-lifecycle-address"), "our-story");
    expect(dialogText(host)).not.toContain("stops working");
  });
});

describe("Duplicate", () => {
  it("opens with a name and an address for the copy", () => {
    const host = mount([homeRow, publishedRow]);
    press(host, "Duplicate About us");
    expect(box(host, "page-lifecycle-name").value).toBe("About us copy");
    expect(box(host, "page-lifecycle-address").value).toBe("about-us-copy");
  });
});

describe("Delete", () => {
  it("cannot be started for the home page", () => {
    const host = mount([homeRow]);
    const button = [...host.querySelectorAll("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === "Delete Foundry Reference",
    )!;
    expect(button.disabled).toBe(true);
  });

  it("names every link that must change first, and offers to open each one", () => {
    const host = mount([homeRow, linkedRow]);
    press(host, "Delete Contact");
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
    press(host, "Delete About us");
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
    press(host, "Delete Contact");
    expect(dialogText(host)).toContain("nothing on your live site changes");
  });
});

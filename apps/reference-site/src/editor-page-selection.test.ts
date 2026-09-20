import { describe, expect, it } from "vitest";

import {
  defaultPageHref,
  homePage,
  listEditableSiteFields,
  referenceSiteDefinition,
  resolveSiteHref,
  type SiteDefinition,
  type SiteHref,
  type SitePage,
} from "@humber-foundry/site-definition";

import {
  editorPageForLinkPath,
  editorPageHref,
  fieldsForEditorPage,
  listEditorPages,
  readEditorPageId,
  resolveEditorPage,
} from "./editor-page-selection";
import { withSecondPage } from "./test-support/two-page-site-definition";

const twoPages = withSecondPage();
const secondPage = twoPages.pages[1]!;

describe("readEditorPageId", () => {
  it("reads the page id the address names", () => {
    expect(readEditorPageId({ page: "page_about" })).toBe("page_about");
  });

  it("reads no page when the address names none", () => {
    expect(readEditorPageId({})).toBeUndefined();
    expect(readEditorPageId({ page: "" })).toBeUndefined();
    expect(readEditorPageId({ page: "   " })).toBeUndefined();
  });

  it("reads no page when the address names more than one", () => {
    expect(readEditorPageId({ page: ["a", "b"] })).toBeUndefined();
  });
});

describe("resolveEditorPage", () => {
  it("opens the home page when the address names no page", () => {
    expect(resolveEditorPage(twoPages, undefined)).toEqual({
      page: homePage(twoPages),
      wasNotFound: false,
    });
  });

  it("opens the page the address names", () => {
    expect(resolveEditorPage(twoPages, secondPage.id)).toEqual({
      page: secondPage,
      wasNotFound: false,
    });
  });

  it("falls back to the home page, and says so, when there is no such page", () => {
    expect(resolveEditorPage(twoPages, "page_gone")).toEqual({
      page: homePage(twoPages),
      wasNotFound: true,
    });
  });
});

describe("listEditorPages", () => {
  it("lists every page of the draft, in order, and marks the home page", () => {
    const listed = listEditorPages(twoPages);
    expect(listed.map((page) => page.id)).toEqual(
      twoPages.pages.map((page) => page.id),
    );
    expect(listed[0]!.isHome).toBe(true);
    expect(listed[1]!.isHome).toBe(false);
  });

  it("says where each page is served", () => {
    const listed = listEditorPages(twoPages);
    expect(listed[0]!.path).toBe("/");
    expect(listed[1]!.path).toBe(`/${secondPage.slug}`);
  });

  it("reads every page as not published when nothing is published", () => {
    for (const page of listEditorPages(twoPages)) {
      expect(page.publishedState).toBe("not-published");
    }
  });

  it("separates a published page from a changed one and a new one", () => {
    const published = referenceSiteDefinition;
    const draft: SiteDefinition = {
      ...twoPages,
      pages: [
        { ...homePage(twoPages), title: "A new home page title" },
        secondPage,
      ],
    };
    const listed = listEditorPages(draft, published);
    expect(listed[0]!.publishedState).toBe("changed-since-publish");
    expect(listed[1]!.publishedState).toBe("not-published");

    const unchanged = listEditorPages(referenceSiteDefinition, published);
    expect(unchanged[0]!.publishedState).toBe("on-your-site");
  });

  it("reads a page as unchanged when only its field order differs", () => {
    const home = homePage(referenceSiteDefinition);
    // A stored page is read from JSON, so its fields may arrive in another
    // order than the page built in memory. That is the same page.
    const reordered = Object.fromEntries(
      Object.entries(home).reverse(),
    ) as typeof home;
    const draft: SiteDefinition = {
      ...referenceSiteDefinition,
      pages: [reordered],
    };
    expect(
      listEditorPages(draft, referenceSiteDefinition)[0]!.publishedState,
    ).toBe("on-your-site");
  });
});

describe("editorPageHref", () => {
  it("keeps the workspace the address already carries", () => {
    expect(
      editorPageHref("/dash/pages?workspace=workspace_one", "page_about"),
    ).toBe("/dash/pages?workspace=workspace_one&page=page_about");
  });

  it("adds a page to an address that carries none", () => {
    expect(editorPageHref("/dash/pages", "page_about")).toBe(
      "/dash/pages?page=page_about",
    );
  });

  it("replaces the page the address already names, never stacking two", () => {
    expect(
      editorPageHref("/dash/pages?workspace=w&page=page_about", "page_home"),
    ).toBe("/dash/pages?workspace=w&page=page_home");
  });
});

describe("fieldsForEditorPage", () => {
  const fields = listEditableSiteFields(twoPages);

  it("keeps the fields of the page that is open", () => {
    const shown = fieldsForEditorPage(fields, secondPage.id);
    const pageIds = new Set(
      shown.map((field) => field.pageId).filter((id) => id !== undefined),
    );
    expect(pageIds).toEqual(new Set([secondPage.id]));
  });

  it("keeps the fields that belong to the whole site", () => {
    const shown = fieldsForEditorPage(fields, secondPage.id);
    const siteWide = fields.filter((field) => field.pageId === undefined);
    expect(siteWide.length).toBeGreaterThan(0);
    for (const field of siteWide) {
      expect(shown).toContain(field);
    }
  });

  it("leaves out another page's fields", () => {
    const home = homePage(twoPages);
    const shown = fieldsForEditorPage(fields, home.id);
    expect(
      shown.some((field) => field.pageId === secondPage.id),
    ).toBe(false);
    expect(shown.some((field) => field.pageId === home.id)).toBe(true);
  });

  it("shows one page at a time, so the two pages together are the whole list", () => {
    const home = homePage(twoPages);
    const shownPaths = new Set([
      ...fieldsForEditorPage(fields, home.id).map((field) => field.path),
      ...fieldsForEditorPage(fields, secondPage.id).map((field) => field.path),
    ]);
    expect(shownPaths).toEqual(new Set(fields.map((field) => field.path)));
  });
});

describe("editorPageForLinkPath", () => {
  it("finds the page a site path points at", () => {
    expect(editorPageForLinkPath(twoPages, "/")).toEqual(homePage(twoPages));
    expect(editorPageForLinkPath(twoPages, `/${secondPage.slug}`)).toEqual(
      secondPage,
    );
  });

  it("ignores an anchor or a query on the path", () => {
    expect(
      editorPageForLinkPath(twoPages, `/${secondPage.slug}#contact`),
    ).toEqual(secondPage);
    expect(
      editorPageForLinkPath(twoPages, `/${secondPage.slug}?from=nav`),
    ).toEqual(secondPage);
    expect(
      editorPageForLinkPath(twoPages, `/${secondPage.slug}/`),
    ).toEqual(secondPage);
  });

  it("finds no page for a link that leaves the site", () => {
    expect(editorPageForLinkPath(twoPages, "#contact")).toBeUndefined();
    expect(
      editorPageForLinkPath(twoPages, "mailto:someone@example.com"),
    ).toBeUndefined();
    expect(
      editorPageForLinkPath(twoPages, "https://example.com/about"),
    ).toBeUndefined();
  });

  it("finds no page for a site path no page is served at", () => {
    expect(editorPageForLinkPath(twoPages, "/nothing-here")).toBeUndefined();
  });

  /**
   * The canvas draws a navigation item through `resolveSiteHref`, so the
   * anchor the owner clicks holds the address that call produced, not the
   * stored `page:` href. These checks feed exactly that address back in, so
   * the two rules cannot drift apart.
   */
  it("opens the page a navigation item points at", () => {
    const context = {
      currentPage: homePage(twoPages),
      pageHref: defaultPageHref("/"),
      blogHref: "/blog",
    };
    for (const page of twoPages.pages) {
      const drawn = resolveSiteHref(
        twoPages,
        `page:${page.id}` as SiteHref,
        context,
      );
      expect(editorPageForLinkPath(twoPages, drawn)).toEqual(page);
    }
  });

  it("opens the page a navigation item points at, anchor and all", () => {
    const anchor = secondPage.sections[0]!.id;
    const drawn = resolveSiteHref(
      twoPages,
      `page:${secondPage.id}#${anchor}` as SiteHref,
      {
        currentPage: homePage(twoPages),
        pageHref: defaultPageHref("/"),
        blogHref: "/blog",
      },
    );
    expect(editorPageForLinkPath(twoPages, drawn)).toEqual(secondPage);
  });
});

describe("the second-page fixture", () => {
  it("puts the home page first and the second page after it", () => {
    expect(twoPages.pages).toHaveLength(2);
    expect(twoPages.pages[0]).toEqual(homePage(referenceSiteDefinition));
    expect(secondPage.slug).not.toBe(homePage(twoPages).slug);
  });

  it("accepts a page written by the caller", () => {
    const custom: SitePage = {
      ...secondPage,
      id: "page_contact",
      slug: "contact",
      title: "Contact",
    };
    const definition = withSecondPage(custom);
    expect(definition.pages[1]).toEqual(custom);
  });
});

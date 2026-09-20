import { describe, expect, it } from "vitest";

import {
  homePage,
  isBaseSiteDefinition,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "./index";
import {
  findPageHrefReferences,
  parseSiteHref,
  resolveSiteHref,
} from "./site-href";

/**
 * The reference definition, plus a second page. The published reference
 * content keeps its one page; this fixture adds a second page so a link
 * between two real pages can be proven, matching the fixture pattern
 * `apps/reference-site/src/public-page.test.ts` already uses.
 */
function withSecondPage(page: Partial<SitePage> = {}): SiteDefinition {
  const home = homePage(referenceSiteDefinition);
  return {
    ...referenceSiteDefinition,
    pages: [
      home,
      {
        id: "page_about",
        slug: "about",
        title: "About",
        seo: { title: "", description: "", keywords: [], shareImage: null },
        sections: [],
        ...page,
      },
    ],
  };
}

const pageHref = (page: SitePage) => (page.slug === "" ? "/" : `/${page.slug}`);

describe("parseSiteHref", () => {
  it("reads the pre-existing anchor and mailto forms unchanged", () => {
    expect(parseSiteHref("#contact")).toStrictEqual({
      kind: "anchor",
      anchor: "contact",
    });
    expect(parseSiteHref("mailto:owner@example.com")).toStrictEqual({
      kind: "mailto",
      address: "owner@example.com",
    });
  });

  it("reads a page reference, with and without an anchor", () => {
    expect(parseSiteHref("page:page_about")).toStrictEqual({
      kind: "page",
      pageId: "page_about",
      anchor: null,
    });
    expect(parseSiteHref("page:page_home#section_contact")).toStrictEqual({
      kind: "page",
      pageId: "page_home",
      anchor: "section_contact",
    });
  });

  it("reads the Blog target", () => {
    expect(parseSiteHref("blog")).toStrictEqual({ kind: "blog" });
  });
});

describe("resolveSiteHref", () => {
  it("keeps a plain #anchor on the home page as-is", () => {
    const definition = withSecondPage();
    const home = homePage(definition);
    expect(
      resolveSiteHref(definition, "#section_contact", {
        currentPage: home,
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("#section_contact");
  });

  it("sends a plain #anchor from another page to the home page's path", () => {
    const definition = withSecondPage();
    const about = definition.pages.find((page) => page.id === "page_about")!;
    expect(
      resolveSiteHref(definition, "#section_contact", {
        currentPage: about,
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("/#section_contact");
  });

  it("resolves a page: reference to the target page's path", () => {
    const definition = withSecondPage();
    const home = homePage(definition);
    expect(
      resolveSiteHref(definition, "page:page_about", {
        currentPage: home,
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("/about");
  });

  it("resolves a page: anchor on the current page to a bare anchor", () => {
    const definition = withSecondPage();
    const about = definition.pages.find((page) => page.id === "page_about")!;
    expect(
      resolveSiteHref(definition, "page:page_about#section_intro", {
        currentPage: about,
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("#section_intro");
  });

  it("resolves a page: anchor on another page to that page's path plus the anchor", () => {
    const definition = withSecondPage();
    expect(
      resolveSiteHref(definition, "page:page_about#section_intro", {
        currentPage: homePage(definition),
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("/about#section_intro");
  });

  it("resolves blog to the given Blog address", () => {
    const definition = withSecondPage();
    expect(
      resolveSiteHref(definition, "blog", {
        currentPage: homePage(definition),
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("/blog");
  });

  it("resolves mailto: unchanged", () => {
    const definition = withSecondPage();
    expect(
      resolveSiteHref(definition, "mailto:owner@example.com", {
        currentPage: null,
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("mailto:owner@example.com");
  });

  it("resolves a page reference when nothing is the current page, such as on the Blog", () => {
    const definition = withSecondPage();
    expect(
      resolveSiteHref(definition, "page:page_about", {
        currentPage: null,
        pageHref,
        blogHref: "/blog",
      }),
    ).toBe("/about");
  });
});

describe("page-reference validation", () => {
  it("accepts a navigation link that targets a real page", () => {
    const definition = withSecondPage();
    const withLink: SiteDefinition = {
      ...definition,
      site: {
        ...definition.site,
        navigation: [
          { id: "nav_about", label: "About", href: "page:page_about" },
        ],
      },
    };
    expect(isBaseSiteDefinition(withLink)).toBe(true);
  });

  it("refuses a navigation link that targets a page id that does not exist", () => {
    const definition = withSecondPage();
    const withDangling: SiteDefinition = {
      ...definition,
      site: {
        ...definition.site,
        navigation: [
          { id: "nav_missing", label: "Missing", href: "page:page_missing" },
        ],
      },
    };
    expect(isBaseSiteDefinition(withDangling)).toBe(false);
  });
});

describe("findPageHrefReferences", () => {
  it("names the navigation item that links to a page", () => {
    const definition = withSecondPage();
    const withLink: SiteDefinition = {
      ...definition,
      site: {
        ...definition.site,
        navigation: [
          { id: "nav_about", label: "About", href: "page:page_about" },
        ],
      },
    };
    expect(findPageHrefReferences(withLink, "page_about")).toStrictEqual([
      { location: "navigation", label: "About" },
    ]);
  });

  it("finds no references when nothing links to the page", () => {
    const definition = withSecondPage();
    expect(findPageHrefReferences(definition, "page_about")).toStrictEqual([]);
  });
});

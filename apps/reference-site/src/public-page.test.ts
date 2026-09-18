import { describe, expect, it } from "vitest";

import {
  homePage,
  homePageSlug,
  reservedPageSlugs,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

import { findPublicPage, pageRouteMetadata } from "./public-page";

/**
 * The reference definition, plus a second page. The published reference
 * content keeps its one page; this fixture only adds a second page for this
 * test so the route is proven against a real multi-page site.
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

describe("findPublicPage", () => {
  it("finds a page other than home by its slug", () => {
    const definition = withSecondPage();
    const page = findPublicPage(definition, "about");
    expect(page?.id).toBe("page_about");
  });

  it("refuses the home page's own slug, the empty string", () => {
    const definition = withSecondPage();
    expect(findPublicPage(definition, homePageSlug)).toBeNull();
  });

  it("refuses an unknown slug", () => {
    const definition = withSecondPage();
    expect(findPublicPage(definition, "missing")).toBeNull();
  });

  it("refuses every reserved slug, so this route never shadows a fixed route", () => {
    const definition = withSecondPage();
    for (const slug of reservedPageSlugs) {
      expect(findPublicPage(definition, slug)).toBeNull();
    }
  });

  it("refuses a reserved slug even if a page were somehow stored under it", () => {
    // The schema stops a page from taking a reserved slug. This proves the
    // route has its own guard too, in case a definition ever reaches this
    // function without having passed that schema check.
    const definition = withSecondPage({ id: "page_blog_shadow", slug: "blog" });
    expect(findPublicPage(definition, "blog")).toBeNull();
  });
});

describe("pageRouteMetadata", () => {
  it("uses the page's own title and falls back to the site name", () => {
    const definition = withSecondPage();
    const page = findPublicPage(definition, "about")!;
    const metadata = pageRouteMetadata(definition, page);
    expect(metadata.title).toBe(
      `About — ${definition.site.name}`,
    );
  });

  it("emits the page's own canonical URL", () => {
    const definition = withSecondPage();
    const page = findPublicPage(definition, "about")!;
    const metadata = pageRouteMetadata(definition, page);
    expect(metadata.alternates?.canonical).toBe(
      `${definition.site.canonicalOrigin}/about`,
    );
  });
});

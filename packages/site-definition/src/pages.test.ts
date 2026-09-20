import { describe, expect, it } from "vitest";

import { projectedHomePageSlug } from "./site-definition-projection.mjs";
import {
  findPageById,
  findPageBySlug,
  homePage,
  homePageIndex,
  homePageSlug,
  findPageByMediaOccurrenceId,
  pageMediaOccurrenceId,
  replacePage,
  reservedPageSlugs,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "./index";

function withExtraPage(
  definition: SiteDefinition,
  page: Partial<SitePage>,
): SiteDefinition {
  const home = homePage(definition);
  return {
    ...definition,
    pages: [
      ...definition.pages,
      {
        id: "page_about",
        slug: "about",
        title: "About",
        seo: home.seo,
        sections: [],
        ...page,
      },
    ],
  };
}

describe("site page accessors", () => {
  it("names the root slug and the slugs a page may not take", () => {
    expect(homePageSlug).toBe("");
    expect([...reservedPageSlugs]).toStrictEqual([
      "__foundry",
      "api",
      "blog",
      "dash",
      "newsletter",
    ]);
  });

  it("keeps the projection's copy of the root slug equal to this one", () => {
    // site-definition-projection.mjs is plain JavaScript and cannot import
    // this module, so it holds a second copy of the value.
    expect(projectedHomePageSlug).toBe(homePageSlug);
  });

  it("reads the home page as the page with the root slug", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    expect(homePage(definition).slug).toBe(homePageSlug);
    expect(homePage(definition).id).toBe("page_home");
    expect(homePageIndex(definition)).toBe(0);
  });

  it("reads the home page wherever it sits in the collection", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    const reordered: SiteDefinition = {
      ...definition,
      pages: [...definition.pages].reverse(),
    };
    expect(homePageIndex(reordered)).toBe(1);
    expect(homePage(reordered).id).toBe("page_home");
  });

  it("refuses a definition with no home page", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    const orphaned = {
      ...definition,
      pages: definition.pages.filter(({ slug }) => slug !== homePageSlug),
    } as SiteDefinition;
    expect(() => homePage(orphaned)).toThrow("site_definition_home_page_absent");
    expect(() => homePageIndex(orphaned)).toThrow(
      "site_definition_home_page_absent",
    );
  });

  it("finds a page by id and by slug", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    expect(findPageById(definition, "page_about")?.slug).toBe("about");
    expect(findPageBySlug(definition, "about")?.id).toBe("page_about");
    expect(findPageBySlug(definition, homePageSlug)?.id).toBe("page_home");
    expect(findPageById(definition, "page_missing")).toBeUndefined();
    expect(findPageBySlug(definition, "missing")).toBeUndefined();
  });

  it("replaces one page and leaves the others as they were", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    const next = replacePage(definition, {
      ...homePage(definition),
      title: "Front",
    });
    expect(homePage(next).title).toBe("Front");
    expect(next.pages).toHaveLength(2);
    expect(next.pages[1]).toStrictEqual(definition.pages[1]);
    expect(homePage(definition).title).not.toBe("Front");
  });

  it("refuses to replace a page that is not in the collection", () => {
    expect(() =>
      replacePage(referenceSiteDefinition, {
        ...homePage(referenceSiteDefinition),
        id: "page_absent",
      }),
    ).toThrow("site_definition_page_absent");
  });
});

describe("findPageByMediaOccurrenceId", () => {
  it("finds the page an occurrence id names", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    expect(
      findPageByMediaOccurrenceId(definition, "occurrence_home_hero")?.slug,
    ).toBe("");
    expect(
      findPageByMediaOccurrenceId(
        definition,
        "occurrence_page_about_detail",
      )?.id,
    ).toBe("page_about");
    expect(
      findPageByMediaOccurrenceId(definition, "occurrence_page_news_hero"),
    ).toBeUndefined();
  });

  it("keeps the home page's own pair when another page takes the id home", () => {
    // Nothing in the schema stops a page below the home page from taking the
    // page id `home`, and then both pages claim `occurrence_home_hero`. The
    // pair belongs to the home page, so the home page wins and can still hold
    // a photo. See ADR-0026.
    const definition = withExtraPage(referenceSiteDefinition, {
      id: "home",
      slug: "home-page",
    });
    expect(
      findPageByMediaOccurrenceId(definition, "occurrence_home_hero")?.slug,
    ).toBe("");
  });
});

describe("pageMediaOccurrenceId", () => {
  it("keeps the home page's two historical ids unchanged", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    const home = homePage(definition);
    expect(pageMediaOccurrenceId(home, "hero")).toBe("occurrence_home_hero");
    expect(pageMediaOccurrenceId(home, "detail")).toBe(
      "occurrence_home_detail",
    );
  });

  it("builds another page's id from its own page id", () => {
    const definition = withExtraPage(referenceSiteDefinition, {});
    const about = findPageById(definition, "page_about")!;
    expect(pageMediaOccurrenceId(about, "hero")).toBe(
      "occurrence_page_about_hero",
    );
    expect(pageMediaOccurrenceId(about, "detail")).toBe(
      "occurrence_page_about_detail",
    );
  });
});

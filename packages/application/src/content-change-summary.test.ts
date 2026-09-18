import { describe, expect, it } from "vitest";

import {
  homePage,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

import { createContentChangeSummary } from "./content-change-summary";

function aboutPage(definition: SiteDefinition): SitePage {
  const home = homePage(definition);
  const hero = home.sections[0]!;
  if (hero.type !== "hero") throw new TypeError("expected_hero_fixture");
  return {
    id: "page_about",
    slug: "about",
    title: "About us",
    seo: home.seo,
    sections: [
      {
        ...hero,
        id: "section_about_hero",
        title: "About the studio",
        primaryAction: {
          id: "action_about_start",
          label: "Start a conversation",
          href: "#section_about_hero" as const,
        },
        ...(hero.secondaryAction === undefined
          ? {}
          : {
              secondaryAction: {
                ...hero.secondaryAction,
                id: "action_about_explore",
                href: "#section_about_hero" as const,
              },
            }),
      },
    ],
  };
}

const base = referenceSiteDefinition;
const twoPages: SiteDefinition = {
  ...base,
  pages: [...base.pages, aboutPage(base)],
};

function editAboutHero(
  definition: SiteDefinition,
  change: Record<string, unknown>,
): SiteDefinition {
  return {
    ...definition,
    pages: definition.pages.map((page) =>
      page.id !== "page_about"
        ? page
        : {
            ...page,
            sections: page.sections.map((section) =>
              section.id !== "section_about_hero"
                ? section
                : ({ ...section, ...change } as typeof section),
            ),
          },
    ),
  };
}

describe("content change summary", () => {
  it("reports no change when nothing changed", () => {
    const summary = createContentChangeSummary({ base, draft: base });

    expect(summary).toEqual({
      pages: [],
      changedDocuments: [],
      designChanges: [],
      publicEffect:
        "Nothing on the public site changes. " +
        "This review does not approve or publish anything.",
    });
  });

  it("names a new page by its title and its web address", () => {
    const summary = createContentChangeSummary({ base, draft: twoPages });

    expect(summary.pages).toEqual([
      {
        pageId: "page_about",
        title: "About us",
        path: "/about",
        state: "created",
        changedFields: [],
      },
    ]);
    expect(summary.changedDocuments).toEqual([
      "About us — new page at /about",
    ]);
    expect(summary.publicEffect).toContain(
      "Visitors get a new page at /about.",
    );
  });

  it("names a removed page by its title, not its page id", () => {
    const summary = createContentChangeSummary({ base: twoPages, draft: base });

    expect(summary.pages).toEqual([
      {
        pageId: "page_about",
        title: "About us",
        path: "/about",
        state: "removed",
        changedFields: [],
      },
    ]);
    expect(summary.changedDocuments).toEqual(["About us — page removed"]);
    expect(summary.publicEffect).toContain("The page at /about is gone.");
    expect(summary.changedDocuments.join(" ")).not.toContain("page_about");
  });

  it("reports a content change on a page that is not the home page", () => {
    const summary = createContentChangeSummary({
      base: twoPages,
      draft: editAboutHero(twoPages, { title: "About our studio" }),
    });

    expect(summary.pages).toEqual([
      expect.objectContaining({
        title: "About us",
        state: "changed",
        changedFields: ["Hero: Hero title"],
      }),
    ]);
    expect(summary.changedDocuments).toEqual([
      "About us — Hero: Hero title",
    ]);
    expect(summary.designChanges).toEqual([]);
    expect(summary.publicEffect).toContain("The page at /about changes.");
  });

  it("separates a design change on another page from a content change", () => {
    const summary = createContentChangeSummary({
      base: twoPages,
      draft: editAboutHero(twoPages, { variant: "focused" }),
    });

    expect(summary.changedDocuments).toEqual([]);
    expect(summary.designChanges).toEqual(["About us — Opening section"]);
  });

  it("reports a renamed page and a moved page in plain words", () => {
    const draft: SiteDefinition = {
      ...twoPages,
      pages: twoPages.pages.map((page) =>
        page.id !== "page_about"
          ? page
          : { ...page, title: "Our studio", slug: "studio" },
      ),
    };
    const summary = createContentChangeSummary({ base: twoPages, draft });

    expect(summary.pages).toEqual([
      expect.objectContaining({
        title: "Our studio",
        path: "/studio",
        state: "changed",
        changedFields: ["Page name", "Web address"],
      }),
    ]);
  });

  it("keeps settings that belong to the whole site out of the page list", () => {
    const summary = createContentChangeSummary({
      base: twoPages,
      draft: {
        ...twoPages,
        site: { ...twoPages.site, footer: "A new footer line." },
      },
    });

    expect(summary.pages).toEqual([]);
    expect(summary.changedDocuments).toEqual(["Whole site — Footer"]);
    expect(summary.publicEffect).toContain(
      "Settings that every page shares change.",
    );
  });

  it("covers a change, a new page and a removed page together", () => {
    const threePages: SiteDefinition = {
      ...twoPages,
      pages: [
        ...twoPages.pages,
        { ...aboutPage(base), id: "page_contact", slug: "contact", title: "Contact" },
      ],
    };
    const draft: SiteDefinition = {
      ...threePages,
      pages: threePages.pages
        .filter(({ id }) => id !== "page_about")
        .map((page) =>
          page.id !== homePage(threePages).id
            ? page
            : {
                ...page,
                sections: page.sections.map((section) =>
                  section.id !== "section_hero"
                    ? section
                    : { ...section, title: "A new headline" },
                ),
              },
        ),
    };
    const summary = createContentChangeSummary({ base: threePages, draft });

    expect(summary.pages.map(({ title, state }) => [title, state])).toEqual([
      ["Foundry Reference", "changed"],
      ["About us", "removed"],
    ]);
    expect(summary.changedDocuments).toEqual([
      "Foundry Reference — Hero: Hero title",
      "About us — page removed",
    ]);
  });
});

import { describe, expect, it } from "vitest";

import {
  DuplicateEditableSiteFieldPathError,
  applySiteDefinitionEdits,
  homePage,
  homePageSlug,
  isSiteDefinition,
  listEditableSiteFields,
  pageFieldPath,
  referenceSiteDefinition,
  serializeSiteDefinitionRichTextForPublication,
  type SiteDefinition,
  type SitePage,
} from "./index";

/**
 * The reference site with one more page, built from the home page's own
 * sections and SEO block.
 *
 * Copying the home page's sections gives the new page sections with the same
 * ids as the home page's sections. That is a valid definition: a section id is
 * unique inside its page and nowhere else. It is also the case a page-scoped
 * field path has to survive.
 *
 * The copy is a deep copy, because a stored definition is read from JSON and
 * so never shares one object between two pages.
 */
function withSecondPage(page: Partial<SitePage> = {}): SiteDefinition {
  const definition = referenceSiteDefinition;
  const home = homePage(definition);
  return {
    ...definition,
    pages: [
      ...definition.pages,
      {
        id: "page_about",
        slug: "about",
        title: "About",
        seo: structuredClone(home.seo),
        sections: structuredClone(home.sections),
        ...page,
      },
    ],
  };
}

/** The paths of every editable field that belongs to one page. */
function pathsOfPage(
  definition: SiteDefinition,
  pageId: string,
): ReadonlyArray<string> {
  return listEditableSiteFields(definition)
    .filter((field) => field.pageId === pageId)
    .map(({ path }) => path);
}

describe("published rich-text file paths", () => {
  /**
   * The file paths the installed reference site already stores. An
   * installation that upgrades and publishes must write the same file names,
   * so a publish after the upgrade shows no change. These literals are the
   * record of that promise, so they must never be rewritten to match new
   * behaviour.
   */
  const storedHomeRichTextPaths = [
    {
      fieldPath: "section_contact.body",
      filePath: "content/rich-text/section_contact/body.md",
    },
  ];

  it("publishes the home page's rich text at the paths the installed site stores", () => {
    expect(
      serializeSiteDefinitionRichTextForPublication(
        referenceSiteDefinition,
      ).map(({ fieldPath, filePath }) => ({ fieldPath, filePath })),
    ).toStrictEqual(storedHomeRichTextPaths);
  });

  it("keeps the home page's paths when the site gains a second page", () => {
    const artifacts = serializeSiteDefinitionRichTextForPublication(
      withSecondPage(),
    );

    expect(
      artifacts
        .filter(({ fieldPath }) => !fieldPath.startsWith("page_about."))
        .map(({ fieldPath, filePath }) => ({ fieldPath, filePath })),
    ).toStrictEqual(storedHomeRichTextPaths);
  });

  it("publishes a second page's rich text under its page id", () => {
    expect(
      serializeSiteDefinitionRichTextForPublication(withSecondPage()).map(
        ({ filePath }) => filePath,
      ),
    ).toContain("content/rich-text/page_about/section_contact/body.md");
  });

  it("writes the same file for a second page after its slug changes", () => {
    const before = serializeSiteDefinitionRichTextForPublication(
      withSecondPage(),
    );
    const after = serializeSiteDefinitionRichTextForPublication(
      withSecondPage({ slug: "company" }),
    );

    expect(after.map(({ filePath }) => filePath)).toStrictEqual(
      before.map(({ filePath }) => filePath),
    );
  });
});

describe("page-scoped editable field paths", () => {
  it("adds no prefix to a home page field and the page id to any other", () => {
    const definition = withSecondPage();

    expect(pageFieldPath(homePage(definition), "section_hero.title")).toBe(
      "section_hero.title",
    );
    expect(pageFieldPath(definition.pages[1]!, "section_hero.title")).toBe(
      "page_about.section_hero.title",
    );
  });

  it("leaves every home page field path and its order unchanged when a page is added", () => {
    const single = listEditableSiteFields(referenceSiteDefinition).map(
      ({ path }) => path,
    );

    // Drop the new page's own fields and the list must be the one the site
    // had before, in the same order. The order is part of the promise: the
    // MCP content tools publish these paths as an ordered list.
    expect(
      listEditableSiteFields(withSecondPage())
        .map(({ path }) => path)
        .filter((path) => !path.startsWith("page_about.")),
    ).toStrictEqual(single);
  });

  it("gives a second page the same field set as the home page", () => {
    const definition = withSecondPage();
    const homeFieldPaths = pathsOfPage(definition, "page_home");

    // Every home page path has one match on the second page. The home page's
    // own SEO paths already start with its page id, so the second page's SEO
    // paths start with its own id in place of the home page's.
    expect(pathsOfPage(definition, "page_about")).toStrictEqual(
      homeFieldPaths.map((path) =>
        path.startsWith("page_home.")
          ? path.replace("page_home.", "page_about.")
          : `page_about.${path}`,
      ),
    );
  });

  it("builds a second page's paths from its page id and not from its slug", () => {
    expect(
      pathsOfPage(withSecondPage({ slug: "company" }), "page_about"),
    ).toStrictEqual(pathsOfPage(withSecondPage(), "page_about"));
  });

  it("moves both pages' paths when another page takes the root slug", () => {
    // A page is the home page because it holds the root slug. Moving the root
    // slug therefore moves which page has unprefixed paths. This test records
    // that consequence. ADR-0017 accepts it, and ticket #159 owns the warning
    // an owner must see before a slug change on a published page.
    const base = withSecondPage();
    const swapped: SiteDefinition = {
      ...base,
      pages: [
        { ...base.pages[0]!, slug: "welcome" },
        { ...base.pages[1]!, slug: homePageSlug },
      ],
    };

    expect(pathsOfPage(swapped, "page_about")).toContain("section_hero.title");
    expect(pathsOfPage(swapped, "page_home")).toContain(
      "page_home.section_hero.title",
    );
  });

  it("names the page every page field belongs to", () => {
    const fields = listEditableSiteFields(withSecondPage());
    const pageIdOf = (path: string) =>
      fields.find((field) => field.path === path)?.pageId;

    expect(pageIdOf("section_hero.title")).toBe("page_home");
    expect(pageIdOf("page_home.seo.title")).toBe("page_home");
    expect(pageIdOf("section_hero.variant")).toBe("page_home");
    expect(pageIdOf("page_about.section_hero.title")).toBe("page_about");
    expect(pageIdOf("page_about.seo.title")).toBe("page_about");
    expect(pageIdOf("page_about.section_hero.variant")).toBe("page_about");

    // A field that belongs to the whole site, or to a blog post, names no page.
    expect(pageIdOf("site_foundry_reference.footer")).toBeUndefined();
    expect(pageIdOf("design.colour.accent")).toBeUndefined();
  });
});

describe("the duplicate field path guard", () => {
  it("accepts two pages that hold sections with the same id", () => {
    expect(() => listEditableSiteFields(withSecondPage())).not.toThrow();
  });

  it("refuses a repeated section id inside a second page", () => {
    const home = homePage(referenceSiteDefinition);
    const definition = withSecondPage({
      sections: [home.sections[0]!, home.sections[0]!],
    });

    expect(() => listEditableSiteFields(definition)).toThrow(
      DuplicateEditableSiteFieldPathError,
    );
    try {
      listEditableSiteFields(definition);
    } catch (error) {
      expect((error as DuplicateEditableSiteFieldPathError).path).toBe(
        "page_about.section_hero.variant",
      );
    }
  });
});

describe("editing a field on a page below the home page", () => {
  it("writes the edit to that page and leaves the home page as it was", () => {
    const definition = withSecondPage();

    const result = applySiteDefinitionEdits(definition, [
      { path: "page_about.section_hero.title", value: "About this workshop" },
      { path: "page_about.seo.description", value: "Who we are." },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isSiteDefinition(result.definition)).toBe(true);
    const [home, about] = result.definition.pages;
    expect(about!.sections[0]).toMatchObject({ title: "About this workshop" });
    expect(about!.seo.description).toBe("Who we are.");
    expect(home!.sections[0]).toStrictEqual(
      homePage(referenceSiteDefinition).sections[0],
    );
    expect(home!.seo).toStrictEqual(homePage(referenceSiteDefinition).seo);
  });

  it("refuses a path that names a page the site does not have", () => {
    const result = applySiteDefinitionEdits(withSecondPage(), [
      { path: "page_missing.section_hero.title", value: "Nowhere" },
    ]);

    expect(result.ok).toBe(false);
  });
});

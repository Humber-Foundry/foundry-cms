import { describe, expect, it } from "vitest";

import {
  addPageToDefinition,
  duplicatePageInDefinition,
  findPageById,
  findPageStartingLayout,
  homePage,
  homePageSlug,
  isBaseSiteDefinition,
  isMintedPageId,
  listEditableSiteFields,
  mintedPageId,
  pageDeleteBlockedMessage,
  pageMediaOccurrenceId,
  pageSlugRefusal,
  pageStartingLayouts,
  pageTitleRefusal,
  planPageSectionRestructure,
  PageLifecycleError,
  referenceSiteDefinition,
  removePageFromDefinition,
  suggestPageSlug,
  type SiteDefinition,
  type SiteLink,
  type PageSectionOperation,
  type SitePage,
} from "./index";

/** A minted-looking page id built from one repeated hexadecimal character. */
function pageId(character: string): string {
  return mintedPageId(character.repeat(20));
}

const firstPageId = pageId("a");
const secondPageId = pageId("b");

function create(
  definition: SiteDefinition,
  input: Partial<Parameters<typeof addPageToDefinition>[1]> = {},
): SiteDefinition {
  return addPageToDefinition(definition, {
    pageId: firstPageId,
    title: "About us",
    slug: "about-us",
    startingLayout: "blank",
    ...input,
  });
}

function refusal(run: () => unknown): PageLifecycleError {
  try {
    run();
  } catch (error) {
    if (error instanceof PageLifecycleError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected_a_refusal");
}

describe("minted page ids", () => {
  it("builds an id from a digest and never the id home", () => {
    expect(pageId("a")).toBe("page_aaaaaaaaaaaaaaaaaaaa");
    expect(pageId("a")).not.toBe("home");
    expect(isMintedPageId(pageId("a"))).toBe(true);
  });

  it("matches the identifier shape the schema requires", () => {
    expect(pageId("0")).toMatch(/^[a-z][a-z0-9_]*$/u);
  });

  it("refuses a digest that is too short or not hexadecimal", () => {
    expect(() => mintedPageId("abc")).toThrow("page_id_digest_invalid");
    expect(() => mintedPageId("z".repeat(20))).toThrow(
      "page_id_digest_invalid",
    );
  });

  it("does not treat a hand-written page id as minted", () => {
    expect(isMintedPageId("home")).toBe(false);
    expect(isMintedPageId("page_home")).toBe(false);
  });
});

describe("suggestPageSlug", () => {
  it("turns a page name into a web address", () => {
    expect(suggestPageSlug("About us")).toBe("about-us");
    expect(suggestPageSlug("  What We Do!  ")).toBe("what-we-do");
    expect(suggestPageSlug("Café & Bar")).toBe("cafe-bar");
  });

  it("falls back when the name has nothing usable in it", () => {
    expect(suggestPageSlug("!!!")).toBe("page");
    expect(suggestPageSlug("")).toBe("page");
  });

  it("keeps the suggestion within the length limit", () => {
    const suggested = suggestPageSlug(
      Array.from({ length: 40 }, () => "word").join(" "),
    );
    expect(suggested.length).toBeLessThanOrEqual(120);
    expect(suggested.endsWith("-")).toBe(false);
  });
});

describe("pageSlugRefusal", () => {
  const definition = create(referenceSiteDefinition);
  const home = homePage(definition);

  it("accepts a free, well-formed address for a new page", () => {
    expect(pageSlugRefusal(definition, "contact", null)).toBeNull();
  });

  it("refuses an address another page already uses", () => {
    expect(pageSlugRefusal(definition, "about-us", null)).toBe(
      "Another page already sits at /about-us.",
    );
  });

  it("lets a page keep its own address", () => {
    expect(pageSlugRefusal(definition, "about-us", firstPageId)).toBeNull();
  });

  it("refuses an address the site already serves itself", () => {
    expect(pageSlugRefusal(definition, "blog", null)).toBe(
      "The site already uses /blog for something else. Choose another web address.",
    );
  });

  it("refuses an address that is not lowercase words and hyphens", () => {
    for (const slug of ["About Us", "about us", "about--us", "-about"]) {
      expect(pageSlugRefusal(definition, slug, null)).toBe(
        "Use lowercase letters, numbers and single hyphens, like about-us.",
      );
    }
  });

  it("refuses an address longer than the limit", () => {
    expect(pageSlugRefusal(definition, "a".repeat(121), null)).toBe(
      "Use at most 120 characters.",
    );
  });

  it("refuses the root address for any page but the home page", () => {
    expect(pageSlugRefusal(definition, homePageSlug, null)).toBe(
      "Only the home page can sit at the top of the site. Give this page a web address.",
    );
    expect(pageSlugRefusal(definition, homePageSlug, firstPageId)).toBe(
      "Only the home page can sit at the top of the site. Give this page a web address.",
    );
  });

  it("refuses to move the home page away from the root", () => {
    expect(pageSlugRefusal(definition, "front", home.id)).toBe(
      "The home page always sits at the top of the site, so its web address cannot change.",
    );
    expect(pageSlugRefusal(definition, homePageSlug, home.id)).toBeNull();
  });
});

describe("pageTitleRefusal", () => {
  it("asks for a name when the name is blank", () => {
    expect(pageTitleRefusal("   ")).toBe("Give this page a name.");
    expect(pageTitleRefusal("About")).toBeNull();
  });
});

describe("starting layouts", () => {
  it("offers a blank page and two layouts of registered sections", () => {
    expect(pageStartingLayouts.map(({ id }) => id)).toStrictEqual([
      "blank",
      "introduction",
      "what_you_offer",
    ]);
    expect(findPageStartingLayout("blank")?.components).toStrictEqual([]);
    expect(findPageStartingLayout("nothing")).toBeUndefined();
  });

  it("builds every layout only from registered sections", () => {
    for (const layout of pageStartingLayouts) {
      const definition = create(referenceSiteDefinition, {
        startingLayout: layout.id,
      });
      const page = findPageById(definition, firstPageId)!;
      expect(page.sections.map(({ type }) => type)).toStrictEqual([
        ...layout.components,
      ]);
      expect(isBaseSiteDefinition(definition)).toBe(true);
    }
  });
});

describe("addPageToDefinition", () => {
  it("adds a page at the end of the page list and leaves the home page alone", () => {
    const definition = create(referenceSiteDefinition);
    expect(definition.pages).toHaveLength(
      referenceSiteDefinition.pages.length + 1,
    );
    expect(definition.pages.at(-1)!.id).toBe(firstPageId);
    expect(homePage(definition).id).toBe(homePage(referenceSiteDefinition).id);
    expect(referenceSiteDefinition.pages).toHaveLength(1);
  });

  it("gives the new page the name and address that were asked for", () => {
    const page = findPageById(create(referenceSiteDefinition), firstPageId)!;
    expect(page.title).toBe("About us");
    expect(page.slug).toBe("about-us");
    expect(page.seo).toStrictEqual({
      title: "",
      description: "",
      keywords: [],
      shareImage: null,
    });
  });

  it("names every section after the page that holds it", () => {
    const definition = create(referenceSiteDefinition, {
      startingLayout: "what_you_offer",
    });
    const page = findPageById(definition, firstPageId)!;
    expect(page.sections.map(({ id }) => id)).toStrictEqual([
      `${firstPageId}_hero`,
      `${firstPageId}_services`,
      `${firstPageId}_call_to_action`,
    ]);
    for (const section of page.sections) {
      expect(section.id.startsWith(firstPageId)).toBe(true);
    }
  });

  it("refuses the page id home and any id it did not mint", () => {
    for (const badId of ["home", "page_about", "Page_1"]) {
      expect(refusal(() => create(referenceSiteDefinition, { pageId: badId })).code).toBe(
        "page_id_reserved",
      );
    }
  });

  it("refuses a page id already in the draft", () => {
    const definition = create(referenceSiteDefinition);
    expect(
      refusal(() => create(definition, { slug: "other" })).code,
    ).toBe("page_id_taken");
  });

  it("refuses a blank name, a refused address and an unknown starting point", () => {
    expect(refusal(() => create(referenceSiteDefinition, { title: " " })).code).toBe(
      "page_title_refused",
    );
    expect(refusal(() => create(referenceSiteDefinition, { slug: "dash" })).code).toBe(
      "page_slug_refused",
    );
    expect(
      refusal(() => create(referenceSiteDefinition, { slug: homePageSlug })).code,
    ).toBe("page_slug_refused");
    expect(
      refusal(() =>
        create(referenceSiteDefinition, { startingLayout: "nothing" }),
      ).code,
    ).toBe("page_starting_layout_unknown");
  });

  it("carries a sentence the owner can read for every refusal", () => {
    const error = refusal(() => create(referenceSiteDefinition, { slug: "blog" }));
    expect(Object.values(error.fields)).toStrictEqual([
      "The site already uses /blog for something else. Choose another web address.",
    ]);
  });
});

describe("duplicatePageInDefinition", () => {
  const source = create(referenceSiteDefinition, {
    startingLayout: "what_you_offer",
  });

  function duplicate(definition: SiteDefinition = source): SiteDefinition {
    return duplicatePageInDefinition(definition, {
      sourcePageId: firstPageId,
      pageId: secondPageId,
      title: "About us copy",
      slug: "about-us-copy",
    });
  }

  it("puts the copy straight after the page it came from", () => {
    const definition = duplicate();
    expect(definition.pages.map(({ id }) => id)).toStrictEqual([
      homePage(source).id,
      firstPageId,
      secondPageId,
    ]);
    expect(isBaseSiteDefinition(definition)).toBe(true);
  });

  it("gives every copied section a fresh id, shared with no other page", () => {
    const definition = duplicate();
    const original = findPageById(definition, firstPageId)!;
    const copy = findPageById(definition, secondPageId)!;
    const originalIds = original.sections.map(({ id }) => id);
    const copyIds = copy.sections.map(({ id }) => id);
    expect(copyIds).toStrictEqual([
      `${secondPageId}_hero`,
      `${secondPageId}_services`,
      `${secondPageId}_call_to_action`,
    ]);
    for (const id of copyIds) {
      expect(originalIds).not.toContain(id);
    }
    expect(original.sections).toStrictEqual(
      findPageById(source, firstPageId)!.sections,
    );
  });

  it("gives every nested item in a copied section a fresh id too", () => {
    const definition = duplicate();
    const copy = findPageById(definition, secondPageId)!;
    const nested: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (typeof value !== "object" || value === null) return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === "id" && typeof entry === "string") nested.push(entry);
        else visit(entry);
      }
    };
    visit(copy.sections);
    for (const id of nested) {
      expect(id.startsWith(secondPageId)).toBe(true);
    }
    expect(new Set(nested).size).toBe(nested.length);
  });

  it("keeps the words and the design choices of the page it copied", () => {
    const definition = duplicate();
    const original = findPageById(definition, firstPageId)!;
    const copy = findPageById(definition, secondPageId)!;
    expect(copy.title).toBe("About us copy");
    expect(copy.slug).toBe("about-us-copy");
    expect(copy.sections.map(({ type }) => type)).toStrictEqual(
      original.sections.map(({ type }) => type),
    );
    expect(copy.sections.map((section) => section.variant)).toStrictEqual(
      original.sections.map((section) => section.variant),
    );
    const heroOf = (page: SitePage) =>
      page.sections.find((section) => section.type === "hero")!;
    expect((heroOf(copy) as { title: string }).title).toBe(
      (heroOf(original) as { title: string }).title,
    );
  });

  it("points a copied link at the copy's own section, not the original", () => {
    const withAnchor: SiteDefinition = {
      ...source,
      pages: source.pages.map((page) =>
        page.id !== firstPageId
          ? page
          : {
              ...page,
              sections: page.sections.map((section) =>
                section.type !== "hero"
                  ? section
                  : {
                      ...section,
                      primaryAction: {
                        ...section.primaryAction,
                        href: `page:${firstPageId}#${firstPageId}_call_to_action`,
                      } as SiteLink,
                    },
              ),
            },
      ),
    };
    const copy = findPageById(duplicate(withAnchor), secondPageId)!;
    const hero = copy.sections.find((section) => section.type === "hero")!;
    expect((hero as { primaryAction: SiteLink }).primaryAction.href).toBe(
      `page:${secondPageId}#${secondPageId}_call_to_action`,
    );
  });

  it("leaves a link to somewhere else exactly as it was", () => {
    const copy = findPageById(duplicate(), secondPageId)!;
    const original = findPageById(source, firstPageId)!;
    const hrefsOf = (page: SitePage) =>
      page.sections.flatMap((section) =>
        section.type === "callToAction" ? [section.action.href] : [],
      );
    expect(hrefsOf(copy)).toStrictEqual(hrefsOf(original));
  });

  it("copies a photo by reference and renames the occurrence for the copy", () => {
    const sourcePage = findPageById(source, firstPageId)!;
    const withPhoto: SiteDefinition = {
      ...source,
      pages: source.pages.map((page) =>
        page.id !== firstPageId
          ? page
          : {
              ...page,
              media: [
                {
                  occurrenceId: pageMediaOccurrenceId(sourcePage, "hero"),
                  revision: 1,
                  asset: {
                    assetId: "asset_harbour",
                    width: 1200,
                    height: 800,
                    contentType: "image/jpeg" as const,
                  },
                  crop: null,
                },
              ],
            },
      ),
    };
    const definition = duplicate(withPhoto);
    const copy = findPageById(definition, secondPageId)!;
    expect(copy.media).toHaveLength(1);
    expect(copy.media![0]!.occurrenceId).toBe(
      pageMediaOccurrenceId(copy, "hero"),
    );
    // The same stored picture, not a second copy of it.
    expect(copy.media![0]!.asset.assetId).toBe("asset_harbour");
    expect(isBaseSiteDefinition(definition)).toBe(true);
  });

  it("refuses to copy a page that is not in the draft", () => {
    expect(
      refusal(() =>
        duplicatePageInDefinition(source, {
          sourcePageId: pageId("c"),
          pageId: secondPageId,
          title: "Copy",
          slug: "copy",
        }),
      ).code,
    ).toBe("page_not_found");
  });

  it("refuses an address another page already uses", () => {
    expect(
      refusal(() =>
        duplicatePageInDefinition(source, {
          sourcePageId: firstPageId,
          pageId: secondPageId,
          title: "Copy",
          slug: "about-us",
        }),
      ).code,
    ).toBe("page_slug_refused");
  });
});

describe("removePageFromDefinition", () => {
  it("removes the page and leaves every other page alone", () => {
    const definition = create(referenceSiteDefinition);
    const next = removePageFromDefinition(definition, firstPageId);
    expect(findPageById(next, firstPageId)).toBeUndefined();
    expect(next.pages).toStrictEqual(referenceSiteDefinition.pages);
    expect(isBaseSiteDefinition(next)).toBe(true);
  });

  it("refuses to delete the home page", () => {
    const definition = create(referenceSiteDefinition);
    const error = refusal(() =>
      removePageFromDefinition(definition, homePage(definition).id),
    );
    expect(error.code).toBe("page_is_home");
    expect(error.fields.pageId).toBe(
      "The home page cannot be deleted. Every site needs a home page.",
    );
  });

  it("refuses to delete a page a navigation item still links to", () => {
    const definition = create(referenceSiteDefinition);
    const linked: SiteDefinition = {
      ...definition,
      site: {
        ...definition.site,
        navigation: [
          ...definition.site.navigation,
          { id: "nav_about", label: "About us", href: `page:${firstPageId}` },
        ],
      },
    };
    const error = refusal(() =>
      removePageFromDefinition(linked, firstPageId),
    );
    expect(error.code).toBe("page_still_linked");
    expect(error.references).toStrictEqual([
      { location: "navigation", label: "About us" },
    ]);
    expect(error.fields.pageId).toBe(
      "About us at /about-us is still linked from: Navigation — About us. Change those links first, then delete the page.",
    );
  });

  it("names every blocking link, not only the first", () => {
    const definition = create(referenceSiteDefinition);
    const home = homePage(definition);
    const linked: SiteDefinition = {
      ...definition,
      site: {
        ...definition.site,
        navigation: [
          { id: "nav_about", label: "About us", href: `page:${firstPageId}` },
        ],
      },
    };
    const message = pageDeleteBlockedMessage(
      linked,
      findPageById(linked, firstPageId)!,
      [
        { location: "navigation", label: "About us" },
        { location: "page", label: "Read more", pageId: home.id },
      ],
    );
    expect(message).toBe(
      `About us at /about-us is still linked from: Navigation — About us, ${home.title} — Read more. Change those links first, then delete the page.`,
    );
  });

  it("refuses to delete a page that is not in the draft", () => {
    expect(
      refusal(() => removePageFromDefinition(referenceSiteDefinition, pageId("f"))).code,
    ).toBe("page_not_found");
  });
});

describe("the page name and web address as editable fields", () => {
  const definition = create(referenceSiteDefinition);
  const fields = listEditableSiteFields(definition);
  const field = (path: string) => fields.find((one) => one.path === path)!;

  it("gives every page a name field and a web address field", () => {
    for (const page of definition.pages) {
      expect(field(`${page.id}.title`).label).toBe("Page name");
      expect(field(`${page.id}.slug`).label).toBe("Web address");
      expect(field(`${page.id}.title`).pageId).toBe(page.id);
    }
  });

  it("warns on the web address field that an old address stops working", () => {
    // The Rename control says this too, and says it precisely because it
    // knows what is published. This is the other way an address changes.
    expect(field(`${firstPageId}.slug`).hint).toContain(
      "stops the old address working",
    );
  });

  it("says instead that the home page sits at the top of the site", () => {
    const home = homePage(definition);
    expect(field(`${home.id}.slug`).hint).toBe(
      "The home page always sits at the top of the site.",
    );
  });

  it("lets the web address be left blank only on the home page", () => {
    expect(field(`${firstPageId}.slug`).optional).toBe(true);
    expect(field(`${firstPageId}.title`).optional).toBe(false);
  });
});

describe("planPageSectionRestructure", () => {
  const definition = create(referenceSiteDefinition, {
    startingLayout: "what_you_offer",
  });
  const page = findPageById(definition, firstPageId)!;
  const plan = (operations: ReadonlyArray<PageSectionOperation>) =>
    planPageSectionRestructure(definition, page, operations);
  const types = (sections: ReadonlyArray<{ type: string }>) =>
    sections.map(({ type }) => type);

  it("leaves the page as it is when no operation is given", () => {
    const result = plan([]);
    expect(result.sections).toEqual(page.sections);
    expect(result.variantChanges).toEqual({});
  });

  it("adds a registered section at the position asked for", () => {
    const result = plan([{ op: "add", sectionType: "proof", position: 1 }]);
    expect(types(result.sections)).toEqual([
      "hero",
      "proof",
      "services",
      "callToAction",
    ]);
  });

  it("names a new section after the page that holds it", () => {
    const result = plan([{ op: "add", sectionType: "proof", position: 3 }]);
    expect(result.sections[3]!.id).toBe(`${firstPageId}_proof`);
  });

  it("gives two sections of the same kind different identifiers", () => {
    const result = plan([
      { op: "add", sectionType: "proof", position: 3 },
      { op: "add", sectionType: "proof", position: 4 },
    ]);
    expect(result.sections[3]!.id).toBe(`${firstPageId}_proof`);
    expect(result.sections[4]!.id).toBe(`${firstPageId}_proof_2`);
  });

  it("gives a new section the arrangement the caller chose", () => {
    const result = plan([
      { op: "add", sectionType: "proof", position: 3, variant: "panel" },
    ]);
    const added = result.sections[3]!;
    expect(added.type === "proof" && added.variant).toBe("panel");
    // A section this request added carries its arrangement in the section
    // itself, because there is no earlier value to compare it with.
    expect(result.variantChanges).toEqual({});
  });

  it("removes a section", () => {
    const result = plan([
      { op: "remove", sectionId: `${firstPageId}_services` },
    ]);
    expect(types(result.sections)).toEqual(["hero", "callToAction"]);
  });

  it("moves a section to a new position", () => {
    const result = plan([
      { op: "move", sectionId: `${firstPageId}_call_to_action`, position: 0 },
    ]);
    expect(types(result.sections)).toEqual(["callToAction", "hero", "services"]);
  });

  it("puts a copied section straight after the section it came from", () => {
    const result = plan([
      { op: "duplicate", sectionId: `${firstPageId}_services` },
    ]);
    expect(types(result.sections)).toEqual([
      "hero",
      "services",
      "services",
      "callToAction",
    ]);
    expect(result.sections[2]!.id).toBe(`${firstPageId}_services_2`);
  });

  it("gives every nested item in a copied section a fresh identifier", () => {
    const result = plan([
      { op: "duplicate", sectionId: `${firstPageId}_services` },
    ]);
    const copy = result.sections[2]!;
    expect(copy.type === "services" && copy.items.map(({ id }) => id)).toEqual([
      `${copy.id}_item_1`,
    ]);
  });

  it("reports an arrangement change on a section the page already held", () => {
    const result = plan([
      {
        op: "set_variant",
        sectionId: `${firstPageId}_hero`,
        variant: "focused",
      },
    ]);
    expect(result.variantChanges).toEqual({
      [`${firstPageId}_hero`]: "focused",
    });
  });

  it("reports no arrangement change when the section keeps its arrangement", () => {
    const hero = page.sections[0]!;
    const result = plan([
      {
        op: "set_variant",
        sectionId: hero.id,
        variant: hero.type === "hero" ? hero.variant : "editorial",
      },
    ]);
    expect(result.variantChanges).toEqual({});
  });

  it("reports no arrangement change for a section the request removed again", () => {
    const result = plan([
      {
        op: "set_variant",
        sectionId: `${firstPageId}_hero`,
        variant: "focused",
      },
      { op: "remove", sectionId: `${firstPageId}_hero` },
    ]);
    expect(result.variantChanges).toEqual({});
  });

  it("carries out the operations in the order they are given", () => {
    const result = plan([
      { op: "add", sectionType: "proof", position: 3 },
      { op: "move", sectionId: `${firstPageId}_proof`, position: 0 },
    ]);
    expect(types(result.sections)).toEqual([
      "proof",
      "hero",
      "services",
      "callToAction",
    ]);
  });

  it("refuses a section that is not on this page", () => {
    expect(
      refusal(() => plan([{ op: "remove", sectionId: "not_a_section" }])).code,
    ).toBe("page_section_not_found");
  });

  it("refuses a kind of section this site does not register", () => {
    expect(
      refusal(() =>
        plan([{ op: "add", sectionType: "carousel", position: 0 }]),
      ).code,
    ).toBe("page_section_type_unknown");
  });

  it("refuses a position outside the section list", () => {
    expect(
      refusal(() =>
        plan([{ op: "add", sectionType: "proof", position: 4 }]),
      ).code,
    ).toBe("page_section_position_invalid");
    expect(
      refusal(() =>
        plan([{ op: "move", sectionId: `${firstPageId}_hero`, position: 3 }]),
      ).code,
    ).toBe("page_section_position_invalid");
  });

  it("refuses an arrangement this kind of section does not offer", () => {
    expect(
      refusal(() =>
        plan([
          {
            op: "set_variant",
            sectionId: `${firstPageId}_hero`,
            variant: "cards",
          },
        ]),
      ).code,
    ).toBe("page_section_variant_unknown");
  });

  it("carries a sentence the owner can read for every refusal", () => {
    expect(
      Object.values(
        refusal(() => plan([{ op: "remove", sectionId: "not_a_section" }]))
          .fields,
      ),
    ).toEqual(["That section is not on this page."]);
  });

  it("leaves the page it was planned from untouched", () => {
    plan([{ op: "remove", sectionId: `${firstPageId}_services` }]);
    expect(findPageById(definition, firstPageId)!.sections).toHaveLength(3);
  });
});

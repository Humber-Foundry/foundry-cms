import {
  homePage,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

/**
 * The reference site with one more page, built from the home page's own
 * sections and SEO block.
 *
 * The reference installation has one page, and creating a page is ticket #159,
 * so a test that needs two pages builds them here. Copying the home page's
 * sections gives the new page sections with the same ids as the home page's
 * sections. That is a valid definition: a section id is unique inside its page
 * and nowhere else. It is also the case a page-scoped field path has to
 * survive.
 *
 * The copy is a deep copy, because a stored definition is read from JSON and
 * so never shares one object between two pages.
 *
 * This is a test fixture. It is never published and never reaches the
 * installed reference content.
 */
export function withSecondPage(page: Partial<SitePage> = {}): SiteDefinition {
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

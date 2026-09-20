import {
  homePage,
  pageMediaOccurrenceId,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

/**
 * A second-page test fixture.
 *
 * PR #188 (not merged when this ticket started) was expected to add a shared
 * `two-page-site-definition.ts` fixture. It has not landed yet, so this file
 * is a small fixture of its own, built the same way `public-page.test.ts`
 * already builds one: the reference definition's home page plus one more
 * page below it.
 *
 * The second page carries its own section, so a test can prove a per-page
 * public subject id, and its own detail media occurrence, so a test can
 * prove a per-page media reference and deletion guard. Its ids are chosen to
 * read clearly in a failure message, not to match any real installation.
 */
export const secondPageId = "page_about";
export const secondPageSlug = "about";
export const secondPageSectionId = "section_about_intro";
export const secondPageAssetId = "asset_about_detail";

const secondPageBase: SitePage = {
  id: secondPageId,
  slug: secondPageSlug,
  title: "About",
  seo: { title: "", description: "", keywords: [], shareImage: null },
  media: [],
  sections: [
    {
      id: secondPageSectionId,
      type: "proof",
      variant: "panel",
      quote: "This page proves the fixture, not a real testimonial.",
      attribution: "Two-page fixture",
      metrics: [],
    },
  ],
};

export function withSecondPage(page: Partial<SitePage> = {}): SiteDefinition {
  const home = homePage(referenceSiteDefinition);
  const merged: SitePage = { ...secondPageBase, ...page };
  const secondPage: SitePage =
    page.media !== undefined
      ? merged
      : {
          ...merged,
          media: [
            {
              occurrenceId: pageMediaOccurrenceId(merged, "detail"),
              revision: 1,
              asset: {
                assetId: secondPageAssetId,
                width: 800,
                height: 600,
                contentType: "image/jpeg",
              },
              crop: null,
            },
          ],
        };
  return {
    ...referenceSiteDefinition,
    pages: [home, secondPage],
  };
}

export const twoPageSiteDefinition: SiteDefinition = withSecondPage();

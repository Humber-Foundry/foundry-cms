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
 * The reference installation has one page, and creating a page is ticket #159,
 * so every test that needs two pages builds them here: the reference
 * definition's home page plus one more page below it. Ticket #157 reads it for
 * the Pages list and the page switcher; ticket #162 reads it for per-page
 * analytics and media.
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

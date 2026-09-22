import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  homePage,
  pageMediaOccurrenceId,
  referenceSiteDefinition,
  type SiteDefinition,
} from "@humber-foundry/site-definition";

import {
  sitePhotoUsage,
  siteStaticImageTiles,
  siteUsedAssetIds,
} from "./site-used-photos";
import {
  secondPageAssetId,
  withSecondPage,
} from "./test-support/two-page-site-definition";

describe("siteStaticImageTiles", () => {
  it("finds a built-in or external photo placed on a page below the home page", () => {
    const definition = withSecondPage({
      sections: [
        {
          id: "section_about_photo",
          type: "registered",
          component: "photoBand",
          props: {
            imageSrc: "/foundry-gathering.svg",
            imageAlt: "Alt",
            caption: "Caption",
          },
        },
      ],
    });

    const tiles = siteStaticImageTiles(definition);
    expect(tiles.some((tile) => tile.src === "/foundry-gathering.svg")).toBe(
      true,
    );
  });

  it("finds nothing when only the reference definition's home page is passed", () => {
    // Sanity check: the reference installation ships no built-in image field
    // value on its home page today, so this list is empty without a second
    // page contributing one.
    expect(siteStaticImageTiles(referenceSiteDefinition)).toEqual([]);
  });
});

describe("siteUsedAssetIds", () => {
  it("includes a gallery asset placed as a media occurrence on a page below home", () => {
    const definition = withSecondPage();
    const ids = siteUsedAssetIds(definition);
    expect(ids.has(secondPageAssetId)).toBe(true);
  });
});

describe("sitePhotoUsage", () => {
  /** Two pages, each holding one photo in its own place. */
  function twoPagesWithAPhotoEach(): SiteDefinition {
    const definition = withSecondPage();
    const home = homePage(definition);
    const homeWithPhoto = {
      ...home,
      media: [
        {
          occurrenceId: pageMediaOccurrenceId(home, "hero"),
          revision: 1,
          asset: {
            assetId: "asset_home_hero",
            width: 1600,
            height: 900,
            contentType: "image/jpeg",
          },
          crop: null,
        },
      ],
    } as const;
    return {
      ...definition,
      pages: [homeWithPhoto, definition.pages[1]!],
    };
  }

  it("names the page and the place of every use, on every page", () => {
    const usage = sitePhotoUsage(twoPagesWithAPhotoEach());

    expect(usage.get("asset_home_hero")).toEqual([
      `${homePage(referenceSiteDefinition).title} — Top of the page`,
    ]);
    // The second page's photo sits in its detail place, and the line names
    // that page, not the home page.
    expect(usage.get(secondPageAssetId)).toEqual([
      "About — Further down the page",
    ]);
  });

  it("says nothing about a photo no page uses", () => {
    expect(sitePhotoUsage(twoPagesWithAPhotoEach()).has("asset_spare")).toBe(
      false,
    );
  });

  it("names the section a photo chosen for an image field sits in", () => {
    const definition = withSecondPage({
      media: [],
      sections: [
        {
          id: "section_about_photo",
          type: "registered",
          component: "photoBand",
          props: {
            imageSrc: "/api/media/asset_about_band",
            imageAlt: "Alt",
            caption: "Caption",
          },
        },
      ],
    });

    expect(sitePhotoUsage(definition).get("asset_about_band")).toEqual([
      "About — Full-width image",
    ]);
  });

  it("keeps one line for a photo two definitions both use the same way", () => {
    const definition = twoPagesWithAPhotoEach();

    // The published site and the draft are walked together, so an unchanged
    // photo is not listed twice.
    expect(sitePhotoUsage(definition, definition).get(secondPageAssetId)).toEqual(
      ["About — Further down the page"],
    );
  });
});

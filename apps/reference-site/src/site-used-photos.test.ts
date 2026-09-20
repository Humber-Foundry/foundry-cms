import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { referenceSiteDefinition } from "@humber-foundry/site-definition";

import { siteStaticImageTiles, siteUsedAssetIds } from "./site-used-photos";
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

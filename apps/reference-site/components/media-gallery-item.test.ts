import { describe, expect, it } from "vitest";

import {
  chosenPhoto,
  mediaSourceUrl,
  mediaThumbnailUrl,
  photoSizeLabel,
  photoTileHeight,
  photoUsageNames,
} from "./media-gallery-item";

describe("photo size label", () => {
  it("reports a small file in whole kilobytes", () => {
    expect(photoSizeLabel(4_096)).toBe("4 KB");
  });

  it("reports a file under one kilobyte in bytes", () => {
    expect(photoSizeLabel(512)).toBe("512 bytes");
  });

  it("reports a single byte without a plural", () => {
    expect(photoSizeLabel(1)).toBe("1 byte");
  });

  it("reports a large file in megabytes with one decimal", () => {
    expect(photoSizeLabel(2_411_724)).toBe("2.3 MB");
  });

  it("rounds a file just under one megabyte to kilobytes", () => {
    expect(photoSizeLabel(1_048_575)).toBe("1024 KB");
  });

  it("reports an unknown size as unknown", () => {
    expect(photoSizeLabel(0)).toBe("Size unknown");
    expect(photoSizeLabel(-1)).toBe("Size unknown");
    expect(photoSizeLabel(Number.NaN)).toBe("Size unknown");
  });
});

describe("photo usage", () => {
  const occurrences = [
    { occurrenceId: "occurrence_home_hero", revision: 1, assetId: "asset_a", crop: null },
    { occurrenceId: "occurrence_home_detail", revision: 1, assetId: "asset_b", crop: null },
    { occurrenceId: "occurrence_home_hero", revision: 2, assetId: "asset_b", crop: null },
  ];
  const placeName = (id: string) =>
    id === "occurrence_home_hero" ? "Top of the page" : "Further down the page";

  it("names every place a photo is used", () => {
    expect(photoUsageNames(occurrences, "asset_b", placeName)).toEqual([
      "Further down the page",
      "Top of the page",
    ]);
  });

  it("returns no names for a photo that is not on the page", () => {
    expect(photoUsageNames(occurrences, "asset_unused", placeName)).toEqual([]);
  });

  it("never repeats a place a photo fills twice", () => {
    expect(
      photoUsageNames(
        [occurrences[0], occurrences[0]],
        "asset_a",
        placeName,
      ),
    ).toEqual(["Top of the page"]);
  });
});

describe("media urls", () => {
  it("asks the media route for the thumbnail variant", () => {
    expect(mediaThumbnailUrl("asset_hero", "token/value")).toBe(
      "/api/foundry-cms/media?assetId=asset_hero&accessToken=token%2Fvalue&variant=thumbnail",
    );
  });

  it("asks the media route for the full-resolution source", () => {
    expect(mediaSourceUrl("asset_hero", "token/value")).toBe(
      "/api/foundry-cms/media?assetId=asset_hero&accessToken=token%2Fvalue",
    );
  });
});

describe("photo tile height", () => {
  it("scales the height to the tile width for a wide photo", () => {
    expect(photoTileHeight(1600, 900, 160)).toBe(90);
  });

  it("caps a very tall photo at the tile width", () => {
    expect(photoTileHeight(400, 4000, 160)).toBe(160);
  });

  it("falls back to a square tile when the photo size is unusable", () => {
    expect(photoTileHeight(0, 0, 160)).toBe(160);
  });
});

describe("chosen photo", () => {
  it("hands the caller the asset identity and both rendered addresses", () => {
    expect(
      chosenPhoto(
        {
          assetId: "asset_hero",
          fileName: "harbour.jpg",
          width: 1600,
          height: 900,
          contentType: "image/jpeg",
        },
        "token",
      ),
    ).toEqual({
      assetId: "asset_hero",
      fileName: "harbour.jpg",
      width: 1600,
      height: 900,
      contentType: "image/jpeg",
      thumbnailUrl:
        "/api/foundry-cms/media?assetId=asset_hero&accessToken=token&variant=thumbnail",
      sourceUrl: "/api/foundry-cms/media?assetId=asset_hero&accessToken=token",
    });
  });
});

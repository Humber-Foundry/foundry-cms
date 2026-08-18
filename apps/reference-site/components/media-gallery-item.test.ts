import { describe, expect, it } from "vitest";

import {
  chosenPhoto,
  chosenSiteImage,
  mediaThumbnailUrl,
  photoSizeLabel,
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
  it("asks the media route for the thumbnail variant with the library capability", () => {
    expect(mediaThumbnailUrl("asset_hero", "token/value")).toBe(
      "/api/foundry-cms/media?assetId=asset_hero&libraryToken=token%2Fvalue&variant=thumbnail",
    );
  });

  it("never puts the per-asset capability on a thumbnail address", () => {
    expect(mediaThumbnailUrl("asset_hero", "token")).not.toContain(
      "accessToken",
    );
  });
});

describe("chosen photo", () => {
  it("hands the caller the asset identity and one thumbnail address", () => {
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
        "/api/foundry-cms/media?assetId=asset_hero&libraryToken=token&variant=thumbnail",
      imageSrc: "/api/media/asset_hero",
    });
  });

  it("hands back a built-in site photo by its own address", () => {
    expect(chosenSiteImage("/foundry-gathering.svg", "foundry-gathering.svg")).toEqual({
      assetId: "",
      fileName: "foundry-gathering.svg",
      width: 0,
      height: 0,
      contentType: "",
      thumbnailUrl: "/foundry-gathering.svg",
      imageSrc: "/foundry-gathering.svg",
    });
  });
});

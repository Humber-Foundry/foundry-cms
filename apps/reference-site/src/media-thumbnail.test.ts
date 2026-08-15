import { describe, expect, it } from "vitest";

import {
  acceptedThumbnailTypes,
  thumbnailDimensions,
  thumbnailMaxEdge,
} from "./media-thumbnail";

describe("thumbnail dimensions", () => {
  it("keeps a photo that already fits inside the limit at its own size", () => {
    expect(thumbnailDimensions(320, 200)).toEqual({ width: 320, height: 200 });
  });

  it("never enlarges a photo smaller than the limit", () => {
    expect(thumbnailDimensions(40, 12)).toEqual({ width: 40, height: 12 });
  });

  it("puts the longest edge on the limit for a wide photo", () => {
    expect(thumbnailDimensions(1600, 900)).toEqual({
      width: thumbnailMaxEdge,
      height: 270,
    });
  });

  it("puts the longest edge on the limit for a tall photo", () => {
    expect(thumbnailDimensions(900, 1600)).toEqual({
      width: 270,
      height: thumbnailMaxEdge,
    });
  });

  it("keeps a square photo square", () => {
    expect(thumbnailDimensions(2000, 2000)).toEqual({
      width: thumbnailMaxEdge,
      height: thumbnailMaxEdge,
    });
  });

  it("keeps the short edge at one pixel for an extremely long photo", () => {
    expect(thumbnailDimensions(20_000, 3)).toEqual({
      width: thumbnailMaxEdge,
      height: 1,
    });
  });

  it("rejects a size that is not a positive whole number of pixels", () => {
    expect(() => thumbnailDimensions(0, 100)).toThrow("invalid_image_size");
    expect(() => thumbnailDimensions(100, -1)).toThrow("invalid_image_size");
    expect(() => thumbnailDimensions(100.5, 100)).toThrow("invalid_image_size");
    expect(() => thumbnailDimensions(Number.NaN, 100)).toThrow(
      "invalid_image_size",
    );
  });

  it("lists only the image types the media library stores", () => {
    expect([...acceptedThumbnailTypes]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

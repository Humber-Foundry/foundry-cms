import { describe, expect, it } from "vitest";

import { mediaCropStyle } from "./media-crop";

describe("media occurrence crop", () => {
  it("uses the crop width and height as well as its origin", () => {
    expect(
      mediaCropStyle(
        { x: 0.1, y: 0.2, width: 0.5, height: 0.25 },
        { width: 1600, height: 900 },
      ),
    ).toEqual({
      frame: { aspectRatio: 32 / 9, overflow: "hidden" },
      image: {
        height: "400%",
        maxWidth: "none",
        transform: "translate(-10%, -20%)",
        width: "200%",
      },
    });
  });
});

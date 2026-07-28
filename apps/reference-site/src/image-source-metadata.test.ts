import { describe, expect, it } from "vitest";
import { inspectImageSource } from "./image-source-metadata";

describe("image source metadata", () => {
  it("reads PNG dimensions from the bytes", () => {
    const source = new Uint8Array(24);
    source.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    source.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(source.buffer);
    view.setUint32(16, 1600);
    view.setUint32(20, 900);
    expect(inspectImageSource(source)).toEqual({ contentType: "image/png", width: 1600, height: 900 });
  });

  it("rejects content that only claims to be an image", () => {
    expect(() => inspectImageSource(new TextEncoder().encode("not an image"))).toThrow("invalid_image_source");
  });
});

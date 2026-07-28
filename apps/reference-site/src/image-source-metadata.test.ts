import { describe, expect, it } from "vitest";
import { inspectImageSource } from "./image-source-metadata";

const validPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("image source metadata", () => {
  it("reads dimensions from a structurally complete PNG", () => {
    expect(inspectImageSource(validPng)).toEqual({
      contentType: "image/png",
      width: 1,
      height: 1,
    });
  });

  it("accepts AVIF image data stored in a 64-bit extended-size box", () => {
    const source = new Uint8Array(20 + 32 + 17);
    const view = new DataView(source.buffer);
    view.setUint32(0, 20);
    source.set(new TextEncoder().encode("ftypavif\u0000\u0000\u0000\u0000"), 4);
    view.setUint32(20, 32);
    source.set(new TextEncoder().encode("meta"), 24);
    view.setUint32(32, 20);
    source.set(new TextEncoder().encode("ispe"), 36);
    view.setUint32(44, 120);
    view.setUint32(48, 80);
    view.setUint32(52, 1);
    source.set(new TextEncoder().encode("mdat"), 56);
    view.setBigUint64(60, 17n);
    source[68] = 1;

    expect(inspectImageSource(source)).toEqual({
      contentType: "image/avif",
      width: 120,
      height: 80,
    });
  });

  it.each([
    ["PNG", validPng.slice(0, 24)],
    ["JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xd9, ...new Uint8Array(8)])],
    [
      "WebP",
      new TextEncoder().encode("RIFF\u0004\u0000\u0000\u0000WEBP"),
    ],
    [
      "AVIF",
      new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]),
    ],
  ])("rejects a truncated %s container", (_format, source) => {
    expect(() => inspectImageSource(source)).toThrow("invalid_image_source");
  });
});

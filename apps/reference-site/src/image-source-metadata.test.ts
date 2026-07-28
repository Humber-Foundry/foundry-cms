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

  it(
    "rejects a large AVIF without dimensions through bounded box traversal",
    () => {
      const source = new Uint8Array(10 * 1024 * 1024);
      const view = new DataView(source.buffer);
      view.setUint32(0, 20);
      source.set(
        new TextEncoder().encode("ftypavif\u0000\u0000\u0000\u0000"),
        4,
      );
      view.setUint32(20, 12);
      source.set(new TextEncoder().encode("meta"), 24);
      view.setUint32(32, source.byteLength - 32);
      source.set(new TextEncoder().encode("mdat"), 36);

      expect(() => inspectImageSource(source)).toThrow("invalid_image_source");
    },
    1_000,
  );

  it("does not treat the ftyp minor version as an AVIF brand", () => {
    const source = new Uint8Array(20 + 32 + 9);
    const view = new DataView(source.buffer);
    view.setUint32(0, 20);
    source.set(new TextEncoder().encode("ftypmif1avif\u0000\u0000\u0000\u0000"), 4);
    view.setUint32(20, 32);
    source.set(new TextEncoder().encode("meta"), 24);
    view.setUint32(32, 20);
    source.set(new TextEncoder().encode("ispe"), 36);
    view.setUint32(44, 120);
    view.setUint32(48, 80);
    view.setUint32(52, 9);
    source.set(new TextEncoder().encode("mdat"), 56);
    source[60] = 1;

    expect(() => inspectImageSource(source)).toThrow("invalid_image_source");
  });

  it("rejects AVIF rotation properties until transforms are represented", () => {
    const source = new Uint8Array(20 + 41 + 9);
    const view = new DataView(source.buffer);
    view.setUint32(0, 20);
    source.set(new TextEncoder().encode("ftypavif\u0000\u0000\u0000\u0000"), 4);
    view.setUint32(20, 41);
    source.set(new TextEncoder().encode("meta"), 24);
    view.setUint32(32, 20);
    source.set(new TextEncoder().encode("ispe"), 36);
    view.setUint32(44, 120);
    view.setUint32(48, 80);
    view.setUint32(52, 9);
    source.set(new TextEncoder().encode("irot"), 56);
    source[60] = 1;
    view.setUint32(61, 9);
    source.set(new TextEncoder().encode("mdat"), 65);
    source[69] = 1;

    expect(() => inspectImageSource(source)).toThrow("invalid_image_source");
  });

  it("preserves EXIF orientation when a later APP1 segment contains XMP", () => {
    const exif = new Uint8Array(32);
    exif.set(new TextEncoder().encode("Exif\u0000\u0000"), 0);
    exif.set([0x49, 0x49, 42, 0, 8, 0, 0, 0], 6);
    exif.set([1, 0], 14);
    exif.set([0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0], 16);
    const source = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe1,
      0,
      34,
      ...exif,
      0xff,
      0xe1,
      0,
      7,
      0x58,
      0x4d,
      0x50,
      0,
      0,
      0xff,
      0xc0,
      0,
      7,
      8,
      0,
      80,
      0,
      120,
      0xff,
      0xda,
      0,
      2,
      0,
      0xff,
      0xd9,
    ]);

    expect(inspectImageSource(source)).toEqual({
      contentType: "image/jpeg",
      width: 80,
      height: 120,
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

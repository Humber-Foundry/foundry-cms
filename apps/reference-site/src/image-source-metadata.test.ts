import { describe, expect, it } from "vitest";
import { inspectImageSource } from "./image-source-metadata";

const validPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const minimalJpegTables = [
  0xff, 0xdb, 0, 67, 0,
  ...new Array(64).fill(1),
  0xff, 0xc4, 0, 38,
  0, 1, ...new Array(15).fill(0), 0,
  0x10, 1, ...new Array(15).fill(0), 0,
];
const minimalProgressiveDcTables = [
  ...minimalJpegTables.slice(0, 69),
  0xff, 0xc4, 0, 20,
  0, 1, ...new Array(15).fill(0), 0,
];

function pngWithHeight(height: number) {
  const source = validPng.slice();
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  view.setUint32(20, height);
  let crc = 0xffffffff;
  for (let index = 12; index < 29; index += 1) {
    crc ^= source[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  view.setUint32(29, (crc ^ 0xffffffff) >>> 0);
  return source;
}

function pngWithoutChunk(source: Uint8Array, removedType: string) {
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  const chunks: Uint8Array[] = [source.slice(0, 8)];
  let offset = 8;
  while (offset < source.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    const type = String.fromCharCode(...source.slice(offset + 4, offset + 8));
    if (type !== removedType) chunks.push(source.slice(offset, end));
    offset = end;
  }
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let resultOffset = 0;
  for (const chunk of chunks) {
    result.set(chunk, resultOffset);
    resultOffset += chunk.byteLength;
  }
  return result;
}

function pngWithEmptyImageDataChunks(source: Uint8Array, count: number) {
  const emptyIdat = Uint8Array.from([
    0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0x35, 0xaf, 0x06, 0x1e,
  ]);
  const result = new Uint8Array(source.byteLength + count * emptyIdat.byteLength);
  result.set(source.slice(0, 33));
  for (let index = 0; index < count; index += 1) {
    result.set(emptyIdat, 33 + index * emptyIdat.byteLength);
  }
  result.set(source.slice(33), 33 + count * emptyIdat.byteLength);
  return result;
}

function pngWithEmptyChunk(source: Uint8Array, type: string) {
  const chunk = new Uint8Array(12);
  chunk.set(new TextEncoder().encode(type), 4);
  let crc = 0xffffffff;
  for (let index = 4; index < 8; index += 1) {
    crc ^= chunk[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  new DataView(chunk.buffer).setUint32(8, (crc ^ 0xffffffff) >>> 0);
  const result = new Uint8Array(source.byteLength + chunk.byteLength);
  result.set(source.slice(0, 33));
  result.set(chunk, 33);
  result.set(source.slice(33), 45);
  return result;
}

function avifBox(
  type: string,
  payload: ReadonlyArray<number> | Uint8Array,
  extended = false,
) {
  const headerSize = extended ? 16 : 8;
  const result = new Uint8Array(headerSize + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, extended ? 1 : result.byteLength);
  result.set(new TextEncoder().encode(type), 4);
  if (extended) view.setBigUint64(8, BigInt(result.byteLength));
  result.set(payload, headerSize);
  return result;
}

function avifConcat(...parts: ReadonlyArray<Uint8Array>) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function av1ReducedStillSequenceHeader(width: number, height: number) {
  const widthBits = Math.ceil(Math.log2(width));
  const heightBits = Math.ceil(Math.log2(height));
  const binary = (value: number, size: number) =>
    Array.from({ length: size }, (_, index) => (value >> (size - 1 - index)) & 1);
  const bits = [
    ...binary(0, 3),
    1,
    1,
    ...binary(0, 5),
    ...binary(widthBits - 1, 4),
    ...binary(heightBits - 1, 4),
    ...binary(width - 1, widthBits),
    ...binary(height - 1, heightBits),
    0, 0, 0,
    0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0,
    0,
    1,
  ];
  while (bits.length % 8 !== 0) bits.push(0);
  return Uint8Array.from(
    Array.from({ length: bits.length / 8 }, (_, byte) =>
      bits
        .slice(byte * 8, byte * 8 + 8)
        .reduce((value, bit) => (value << 1) | bit, 0),
    ),
  );
}

function structurallyCompleteAvif({
  width = 120,
  height = 80,
  extendedMediaData = false,
  transform = false,
  unknownEssential = false,
  extentCount = 1,
  extentLength = 8,
  omitHandlerName = false,
  omitItemName = false,
  duplicateSequenceHeader = false,
  sequenceBrandOnly = false,
  codedWidth = width,
  codedHeight = height,
  mismatchedAv1Configuration = false,
}: {
  width?: number;
  height?: number;
  extendedMediaData?: boolean;
  transform?: boolean;
  unknownEssential?: boolean;
  extentCount?: number;
  extentLength?: number;
  omitHandlerName?: boolean;
  omitItemName?: boolean;
  duplicateSequenceHeader?: boolean;
  sequenceBrandOnly?: boolean;
  codedWidth?: number;
  codedHeight?: number;
  mismatchedAv1Configuration?: boolean;
} = {}) {
  const sequenceHeader = av1ReducedStillSequenceHeader(codedWidth, codedHeight);
  const completeAv1Payload = Uint8Array.from([
    0x12,
    0,
    0x0a,
    sequenceHeader.byteLength,
    ...sequenceHeader,
    ...(duplicateSequenceHeader
      ? [0x0a, sequenceHeader.byteLength, ...sequenceHeader]
      : []),
    0x32,
    1,
    0,
  ]);
  const effectiveExtentLength =
    duplicateSequenceHeader || extentLength === 8
      ? completeAv1Payload.byteLength
      : extentLength;
  const full = [0, 0, 0, 0];
  const hdlr = avifBox("hdlr", [
    ...full,
    0,
    0,
    0,
    0,
    0x70,
    0x69,
    0x63,
    0x74,
    ...new Array(12).fill(0),
    ...(omitHandlerName ? [] : [0]),
  ]);
  const pitm = avifBox("pitm", [...full, 0, 1]);
  const infe = avifBox("infe", [
    2,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0x61,
    0x76,
    0x30,
    0x31,
    ...(omitItemName ? [] : [0]),
  ]);
  const iinf = avifBox("iinf", avifConcat(Uint8Array.from([...full, 0, 1]), infe));
  const ilocPayload = Uint8Array.from([
    ...full,
    0x44,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    extentCount >>> 8,
    extentCount & 0xff,
    ...Array.from({ length: extentCount }, () => [
      0,
      0,
      0,
      0,
      0,
      (effectiveExtentLength >>> 16) & 0xff,
      (effectiveExtentLength >>> 8) & 0xff,
      effectiveExtentLength & 0xff,
    ]).flat(),
  ]);
  const iloc = avifBox("iloc", ilocPayload);
  const ispePayload = new Uint8Array(12);
  const ispeView = new DataView(ispePayload.buffer);
  ispeView.setUint32(4, width);
  ispeView.setUint32(8, height);
  const ispe = avifBox("ispe", ispePayload);
  const av1c = avifBox(
    "av1C",
    [0x81, 0, mismatchedAv1Configuration ? 0x4c : 0x0c, 0],
  );
  const irot = avifBox("irot", [0]);
  const unknown = avifBox("zzzz", [0]);
  const ipco = avifBox(
    "ipco",
    transform
      ? avifConcat(ispe, av1c, irot)
      : unknownEssential
        ? avifConcat(ispe, av1c, unknown)
        : avifConcat(ispe, av1c),
  );
  const ipma = avifBox(
    "ipma",
    Uint8Array.from([
      ...full,
      0,
      0,
      0,
      1,
      0,
      1,
      transform || unknownEssential ? 3 : 2,
      1,
      0x82,
      ...(transform ? [3] : unknownEssential ? [0x83] : []),
    ]),
  );
  const iprp = avifBox("iprp", avifConcat(ipco, ipma));
  const meta = avifBox(
    "meta",
    avifConcat(Uint8Array.from(full), hdlr, pitm, iinf, iloc, iprp),
  );
  const ftyp = avifBox(
    "ftyp",
    new TextEncoder().encode(
      `${sequenceBrandOnly ? "avis" : "avif"}\u0000\u0000\u0000\u0000mif1`,
    ),
  );
  const av1Payload = new Uint8Array(effectiveExtentLength);
  av1Payload.set(completeAv1Payload.subarray(0, av1Payload.byteLength));
  const mdat = avifBox("mdat", av1Payload, extendedMediaData);
  const source = avifConcat(ftyp, meta, mdat);
  const ilocOffset =
    ftyp.byteLength +
    8 +
    4 +
    hdlr.byteLength +
    pitm.byteLength +
    iinf.byteLength +
    22;
  const mediaOffset =
    ftyp.byteLength + meta.byteLength + (extendedMediaData ? 16 : 8);
  const sourceView = new DataView(source.buffer);
  for (let extent = 0; extent < extentCount; extent += 1) {
    sourceView.setUint32(ilocOffset + extent * 8, mediaOffset);
  }
  return source;
}

describe("image source metadata", () => {
  it("reads dimensions from a structurally complete PNG", async () => {
    expect(await inspectImageSource(validPng)).toEqual({
      contentType: "image/png",
      width: 1,
      height: 1,
    });
  });

  it("rejects AVIF until a bounded frame decoder is available", async () => {
    const source = structurallyCompleteAvif({ extendedMediaData: true });

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it(
    "rejects a large AVIF without dimensions through bounded box traversal",
    async () => {
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

      await expect(inspectImageSource(source)).rejects.toThrow(
        "invalid_image_source",
      );
    },
    1_000,
  );

  it("does not treat the ftyp minor version as an AVIF brand", async () => {
    const source = structurallyCompleteAvif();
    source.set(new TextEncoder().encode("mif1avif"), 8);
    source.fill(0, 16, 20);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects AVIF rotation properties until transforms are represented", async () => {
    const source = structurallyCompleteAvif({ transform: true });

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("requires the AVIF picture metadata handler", async () => {
    const source = structurallyCompleteAvif();
    const pict = new TextEncoder().encode("pict");
    const handlerTypeOffset = source.findIndex(
      (_value, index) =>
        index + pict.length <= source.length &&
        pict.every((value, part) => source[index + part] === value),
    );
    source.set(new TextEncoder().encode("vide"), handlerTypeOffset);
    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("requires the AVIF metadata handler name terminator", async () => {
    await expect(
      inspectImageSource(structurallyCompleteAvif({ omitHandlerName: true })),
    ).rejects.toThrow("invalid_image_source");
  });

  it("requires an AVIF item-info name terminator", async () => {
    await expect(
      inspectImageSource(structurallyCompleteAvif({ omitItemName: true })),
    ).rejects.toThrow("invalid_image_source");
  });

  it("requires exactly one AV1 sequence header OBU", async () => {
    await expect(
      inspectImageSource(
        structurallyCompleteAvif({ duplicateSequenceHeader: true }),
      ),
    ).rejects.toThrow("invalid_image_source");
  });

  it("does not accept an unvalidated AV1 image-sequence brand", async () => {
    await expect(
      inspectImageSource(structurallyCompleteAvif({ sequenceBrandOnly: true })),
    ).rejects.toThrow("invalid_image_source");
  });

  it("binds AVIF item dimensions to the coded AV1 sequence", async () => {
    await expect(
      inspectImageSource(structurallyCompleteAvif({ codedWidth: 121 })),
    ).rejects.toThrow("invalid_image_source");
  });

  it("binds AVIF configuration properties to the coded AV1 sequence", async () => {
    await expect(
      inspectImageSource(
        structurallyCompleteAvif({ mismatchedAv1Configuration: true }),
      ),
    ).rejects.toThrow("invalid_image_source");
  });

  it("rejects unsupported essential AVIF item properties", async () => {
    await expect(
      inspectImageSource(structurallyCompleteAvif({ unknownEssential: true })),
    ).rejects.toThrow("invalid_image_source");
  });

  it("requires one essential AV1 configuration association", async () => {
    const source = structurallyCompleteAvif();
    const ipma = new TextEncoder().encode("ipma");
    const ipmaTypeOffset = source.findIndex(
      (_value, index) =>
        index + ipma.length <= source.length &&
        ipma.every((value, part) => source[index + part] === value),
    );
    source[ipmaTypeOffset + 16] = 2;
    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects reserved AVIF property-association flags", async () => {
    const source = structurallyCompleteAvif();
    const ipma = new TextEncoder().encode("ipma");
    const ipmaTypeOffset = source.findIndex(
      (_value, index) =>
        index + ipma.length <= source.length &&
        ipma.every((value, part) => source[index + part] === value),
    );
    source[ipmaTypeOffset + 7] = 2;
    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects AVIF metadata and payloads not bound to a primary AV1 item", async () => {
    const missingPrimary = structurallyCompleteAvif();
    const pitm = new TextEncoder().encode("pitm");
    const pitmOffset = missingPrimary.findIndex(
      (_value, index) =>
        index + pitm.length <= missingPrimary.length &&
        pitm.every((value, part) => missingPrimary[index + part] === value),
    );
    missingPrimary[pitmOffset + 9] = 2;
    await expect(inspectImageSource(missingPrimary)).rejects.toThrow(
      "invalid_image_source",
    );

    const malformedPayload = structurallyCompleteAvif();
    malformedPayload[malformedPayload.length - 6] = 0;
    await expect(inspectImageSource(malformedPayload)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects nonstandard and reserved AVIF item-location fields", async () => {
    const nonstandardWidth = structurallyCompleteAvif();
    const iloc = new TextEncoder().encode("iloc");
    const ilocTypeOffset = nonstandardWidth.findIndex(
      (_value, index) =>
        index + iloc.length <= nonstandardWidth.length &&
        iloc.every((value, part) => nonstandardWidth[index + part] === value),
    );
    nonstandardWidth[ilocTypeOffset + 8] = 0x14;
    await expect(inspectImageSource(nonstandardWidth)).rejects.toThrow(
      "invalid_image_source",
    );

    const reservedNibble = structurallyCompleteAvif();
    reservedNibble[ilocTypeOffset + 9] = 1;
    await expect(inspectImageSource(reservedNibble)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects image dimensions above the global pixel ceiling", async () => {
    await expect(
      inspectImageSource(structurallyCompleteAvif({ width: 10_000, height: 10_000 })),
    ).rejects.toThrow("invalid_image_source");
    const oversizedWebp = new Uint8Array(30);
    const view = new DataView(oversizedWebp.buffer);
    oversizedWebp.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, 22, true);
    oversizedWebp.set(new TextEncoder().encode("WEBPVP8 "), 8);
    view.setUint32(16, 10, true);
    oversizedWebp.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
    view.setUint16(26, 16_383, true);
    view.setUint16(28, 16_383, true);
    await expect(inspectImageSource(oversizedWebp)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("bounds aggregate AVIF extents before copying their payloads", async () => {
    await expect(
      inspectImageSource(
        structurallyCompleteAvif({ extentCount: 4_096, extentLength: 1_024 }),
      ),
    ).rejects.toThrow("invalid_image_source");
  });

  it("preserves EXIF orientation when a later APP1 segment contains XMP", async () => {
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
      ...minimalJpegTables,
      0xff,
      0xc0,
      0,
      11,
      8,
      0,
      80,
      0,
      120,
      1,
      1,
      0x11,
      0,
      0xff,
      0xda,
      0,
      8,
      1,
      1,
      0,
      0,
      63,
      0,
      0,
      0xff,
      0xd9,
    ]);

    expect(await inspectImageSource(source)).toEqual({
      contentType: "image/jpeg",
      width: 80,
      height: 120,
    });
  });

  it("rejects JPEG scans without component descriptors", async () => {
    const malformed = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 2,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(malformed)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects repeated JPEG start-of-image markers", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xd8, 0, 4, 0, 0,
      ...minimalJpegTables,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects invalid JPEG marker codes outside entropy data", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0x00, 0, 4, 0, 0,
      ...minimalJpegTables,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects unsupported JPEG frame markers", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc3, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects invalid JPEG sampling and table selectors", async () => {
    const invalidSampling = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);
    const invalidHuffmanTable = invalidSampling.slice();
    invalidHuffmanTable[13] = 0x11;
    invalidHuffmanTable[21] = 0x40;

    await expect(inspectImageSource(invalidSampling)).rejects.toThrow(
      "invalid_image_source",
    );
    await expect(inspectImageSource(invalidHuffmanTable)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("limits baseline JPEG Huffman table selectors to zero and one", async () => {
    const tableTwo = [...minimalJpegTables];
    tableTwo[73] = 2;
    tableTwo[91] = 0x12;
    const jpegWithTableTwo = (frameMarker: number) =>
      Uint8Array.from([
        0xff, 0xd8,
        ...tableTwo,
        0xff, frameMarker, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
        0xff, 0xda, 0, 8, 1, 1, 0x22, 0, 63, 0,
        0,
        0xff, 0xd9,
      ]);

    await expect(inspectImageSource(jpegWithTableTwo(0xc0))).rejects.toThrow(
      "invalid_image_source",
    );
    await expect(inspectImageSource(jpegWithTableTwo(0xc1))).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("rejects 16-bit quantization tables for 8-bit JPEG frames", async () => {
    const sixteenBitTable = [
      0xff, 0xdb, 0, 131, 0x10,
      ...Array.from({ length: 64 }, () => [0, 1]).flat(),
      ...minimalJpegTables.slice(69),
    ];
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...sixteenBitTable,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects JPEG scans that omit declared frame components", async () => {
    const incompleteFrame = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3,
      1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(incompleteFrame)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("accepts a progressive DC scan before an AC table is defined", async () => {
    const progressiveDc = Uint8Array.from([
      0xff, 0xd8,
      ...minimalProgressiveDcTables,
      0xff, 0xc2, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(progressiveDc)).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("rejects progressive AC scans before the component DC scan", async () => {
    const acBeforeDc = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc2, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 1, 1, 0,
      0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(acBeforeDc)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects invalid zero-size AC Huffman symbols", async () => {
    const invalidTables = [...minimalJpegTables];
    invalidTables[invalidTables.length - 1] = 0x10;
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...invalidTables,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("accepts progressive EOB-run AC Huffman symbols", async () => {
    const progressiveTables = [...minimalJpegTables];
    progressiveTables[progressiveTables.length - 1] = 0x10;
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...progressiveTables,
      0xff, 0xc2, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0,
      0,
      0xff, 0xda, 0, 8, 1, 1, 0, 1, 1, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("rejects quantization-table changes while a component is active", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc2, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0,
      0,
      0xff, 0xdb, 0, 67, 0,
      ...new Array(64).fill(2),
      0xff, 0xda, 0, 8, 1, 1, 0, 1, 1, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("allows quantization-table changes between sequential components", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc0, 0, 14, 8, 0, 1, 0, 1, 2,
      1, 0x11, 0, 2, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xdb, 0, 67, 0,
      ...new Array(64).fill(2),
      0xff, 0xda, 0, 8, 1, 2, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("allows DQT reuse between disjoint progressive component scans", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc2, 0, 14, 8, 0, 1, 0, 1, 2,
      1, 0x11, 0, 2, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0,
      0,
      0xff, 0xdb, 0, 67, 0,
      ...new Array(64).fill(2),
      0xff, 0xda, 0, 8, 1, 2, 0, 0, 0, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("allows a quantization table to be defined before its component's first scan", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc2, 0, 14, 8, 0, 1, 0, 1, 2,
      1, 0x11, 0, 2, 0x11, 1,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0,
      0,
      0xff, 0xdb, 0, 67, 1,
      ...new Array(64).fill(2),
      0xff, 0xda, 0, 8, 1, 2, 0, 0, 0, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("accepts multi-component progressive DC refinement scans", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalProgressiveDcTables,
      0xff, 0xc2, 0, 14, 8, 0, 1, 0, 1, 2,
      1, 0x11, 0, 2, 0x11, 0,
      0xff, 0xda, 0, 10, 2, 1, 0, 2, 0, 0, 0, 0x01,
      0,
      0xff, 0xda, 0, 10, 2, 1, 0, 2, 0, 0, 0, 0x10,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("rejects repeated components across sequential JPEG scans", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("requires DRI and cyclic restart markers inside JPEG entropy data", async () => {
    const jpegWithRestartMarkers = (restartData: number[], dri = true) =>
      Uint8Array.from([
        0xff, 0xd8,
        ...minimalJpegTables,
        0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
        ...(dri ? [0xff, 0xdd, 0, 4, 0, 1] : []),
        0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
        ...restartData,
        0xff, 0xd9,
      ]);

    await expect(
      inspectImageSource(
        jpegWithRestartMarkers([0, 0xff, 0xd0, 0, 0xff, 0xd1, 0]),
      ),
    ).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
    await expect(
      inspectImageSource(
        jpegWithRestartMarkers([0, 0xff, 0xd0, 0], false),
      ),
    ).rejects.toThrow("invalid_image_source");
    await expect(
      inspectImageSource(
        jpegWithRestartMarkers([0, 0xff, 0xd1, 0]),
      ),
    ).rejects.toThrow("invalid_image_source");
  });

  it("rejects JPEG restart markers outside entropy data", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xdd, 0, 4, 0, 1,
      0xff, 0xd0,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("allows a zero DRI interval to disable JPEG restart processing", async () => {
    const source = Uint8Array.from([
      0xff, 0xd8,
      ...minimalJpegTables,
      0xff, 0xc2, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
      0xff, 0xdd, 0, 4, 0, 1,
      0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0,
      0, 0xff, 0xd0, 0,
      0xff, 0xdd, 0, 4, 0, 0,
      0xff, 0xda, 0, 8, 1, 1, 0, 1, 1, 0,
      0,
      0xff, 0xd9,
    ]);

    await expect(inspectImageSource(source)).resolves.toEqual({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
  });

  it("rejects excessive WebP chunks before traversing the whole source", async () => {
    const chunkCount = 4_097;
    const source = new Uint8Array(12 + chunkCount * 8 + 18);
    const view = new DataView(source.buffer);
    source.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, source.byteLength - 8, true);
    source.set(new TextEncoder().encode("WEBP"), 8);
    let offset = 12;
    for (let index = 0; index < chunkCount; index += 1) {
      source.set(new TextEncoder().encode("JUNK"), offset);
      offset += 8;
    }
    source.set(new TextEncoder().encode("VP8 "), offset);
    view.setUint32(offset + 4, 10, true);
    source.set([0x9d, 0x01, 0x2a], offset + 11);
    view.setUint16(offset + 14, 1, true);
    view.setUint16(offset + 16, 1, true);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("validates animated WebP frame payloads and canvas bounds", async () => {
    const animatedWebp = ({
      frameWidth = 1,
      childType = "VP8 ",
      trailingJunk = false,
      trailingType = "JUNK",
      canvasWidth = 1,
      canvasHeight = 1,
    }: {
      frameWidth?: number;
      childType?: string;
      trailingJunk?: boolean;
      trailingType?: string;
      canvasWidth?: number;
      canvasHeight?: number;
    } = {}) => {
      const source = new Uint8Array(trailingJunk ? 94 : 86);
      const view = new DataView(source.buffer);
      source.set(new TextEncoder().encode("RIFF"), 0);
      view.setUint32(4, source.byteLength - 8, true);
      source.set(new TextEncoder().encode("WEBPVP8X"), 8);
      view.setUint32(16, 10, true);
      source[20] = 0x02;
      source[24] = (canvasWidth - 1) & 0xff;
      source[25] = ((canvasWidth - 1) >>> 8) & 0xff;
      source[26] = ((canvasWidth - 1) >>> 16) & 0xff;
      source[27] = (canvasHeight - 1) & 0xff;
      source[28] = ((canvasHeight - 1) >>> 8) & 0xff;
      source[29] = ((canvasHeight - 1) >>> 16) & 0xff;
      source.set(new TextEncoder().encode("ANIM"), 30);
      view.setUint32(34, 6, true);
      source.set(new TextEncoder().encode("ANMF"), 44);
      view.setUint32(48, trailingJunk ? 42 : 34, true);
      source[58] = frameWidth - 1;
      source.set(new TextEncoder().encode(childType), 68);
      view.setUint32(72, 10, true);
      source.set([0x9d, 0x01, 0x2a], 79);
      view.setUint16(82, frameWidth, true);
      view.setUint16(84, 1, true);
      if (trailingJunk) {
        source.set(new TextEncoder().encode(trailingType), 86);
      }
      return source;
    };

    await expect(inspectImageSource(animatedWebp())).resolves.toEqual({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    await expect(
      inspectImageSource(animatedWebp({ childType: "JUNK" })),
    ).rejects.toThrow("invalid_image_source");
    await expect(
      inspectImageSource(animatedWebp({ frameWidth: 2 })),
    ).rejects.toThrow("invalid_image_source");
    await expect(
      inspectImageSource(
        animatedWebp({ canvasWidth: 65_536, canvasHeight: 65_536 }),
      ),
    ).rejects.toThrow("invalid_image_source");
    await expect(
      inspectImageSource(animatedWebp({ trailingJunk: true })),
    ).resolves.toEqual({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    await expect(
      inspectImageSource(
        animatedWebp({ trailingJunk: true, trailingType: "ANIM" }),
      ),
    ).rejects.toThrow("invalid_image_source");
    const reservedFlag = animatedWebp();
    reservedFlag[20] |= 0x80;
    await expect(inspectImageSource(reservedFlag)).rejects.toThrow(
      "invalid_image_source",
    );
    const reservedByte = animatedWebp();
    reservedByte[21] = 1;
    await expect(inspectImageSource(reservedByte)).rejects.toThrow(
      "invalid_image_source",
    );
    const reservedFrameFlag = animatedWebp();
    reservedFrameFlag[67] = 0x04;
    await expect(inspectImageSource(reservedFrameFlag)).rejects.toThrow(
      "invalid_image_source",
    );
    const withAlpha = (control: number) => {
      const base = animatedWebp();
      const source = new Uint8Array(base.byteLength + 10);
      const view = new DataView(source.buffer);
      source.set(base.slice(0, 68));
      source[20] |= 0x10;
      view.setUint32(4, source.byteLength - 8, true);
      view.setUint32(48, 44, true);
      source.set(new TextEncoder().encode("ALPH"), 68);
      view.setUint32(72, 2, true);
      source[76] = control;
      source[77] = 0;
      source.set(base.slice(68), 78);
      return source;
    };
    await expect(inspectImageSource(withAlpha(0))).resolves.toEqual({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    await expect(inspectImageSource(withAlpha(1))).resolves.toEqual({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    await expect(inspectImageSource(withAlpha(3))).rejects.toThrow(
      "invalid_image_source",
    );
    const headerOnlyCompressedAlpha = withAlpha(1);
    new DataView(headerOnlyCompressedAlpha.buffer).setUint32(72, 1, true);
    await expect(
      inspectImageSource(headerOnlyCompressedAlpha),
    ).rejects.toThrow("invalid_image_source");
    const alphaWithoutCanvasFlag = withAlpha(0);
    alphaWithoutCanvasFlag[20] &= ~0x10;
    await expect(inspectImageSource(alphaWithoutCanvasFlag)).rejects.toThrow(
      "invalid_image_source",
    );
    const opaqueFramesWithAlphaFlag = animatedWebp();
    opaqueFramesWithAlphaFlag[20] |= 0x10;
    await expect(
      inspectImageSource(opaqueFramesWithAlphaFlag),
    ).rejects.toThrow("invalid_image_source");
  });

  it("rejects WebP animation frames without an image subchunk", async () => {
    const source = new Uint8Array(70);
    const view = new DataView(source.buffer);
    source.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, source.byteLength - 8, true);
    source.set(new TextEncoder().encode("WEBPVP8X"), 8);
    view.setUint32(16, 10, true);
    source[20] = 0x02;
    source.set(new TextEncoder().encode("ANIM"), 30);
    view.setUint32(34, 6, true);
    source.set(new TextEncoder().encode("ANMF"), 44);
    view.setUint32(48, 17, true);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects duplicate top-level WebP still-image payloads", async () => {
    const source = new Uint8Array(48);
    const view = new DataView(source.buffer);
    source.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, source.byteLength - 8, true);
    source.set(new TextEncoder().encode("WEBPVP8 "), 8);
    view.setUint32(16, 10, true);
    source.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, 1, true);
    view.setUint16(28, 1, true);
    source.set(new TextEncoder().encode("VP8 "), 30);
    view.setUint32(34, 10, true);
    source.set([0x9d, 0x01, 0x2a], 41);
    view.setUint16(44, 1, true);
    view.setUint16(46, 1, true);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects unsupported VP8L header versions", async () => {
    const losslessWebp = (version: number) => {
      const source = new Uint8Array(26);
      const view = new DataView(source.buffer);
      source.set(new TextEncoder().encode("RIFF"), 0);
      view.setUint32(4, source.byteLength - 8, true);
      source.set(new TextEncoder().encode("WEBPVP8L"), 8);
      view.setUint32(16, 5, true);
      source[20] = 0x2f;
      view.setUint32(21, version << 29, true);
      return source;
    };

    await expect(inspectImageSource(losslessWebp(0))).resolves.toEqual({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    await expect(inspectImageSource(losslessWebp(1))).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects interframes and unsupported profiles in VP8 payloads", async () => {
    const source = new Uint8Array(30);
    const view = new DataView(source.buffer);
    source.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, source.byteLength - 8, true);
    source.set(new TextEncoder().encode("WEBPVP8 "), 8);
    view.setUint32(16, 10, true);
    source[20] = 1;
    source.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, 1, true);
    view.setUint16(28, 1, true);

    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
    source[20] = 4 << 1;
    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
    source[20] = 1 << 5;
    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("validates top-level ALPH chunks before a lossy WebP payload", async () => {
    const webpWithAlpha = (control: number, imageType = "VP8 ") => {
      const source = new Uint8Array(58);
      const view = new DataView(source.buffer);
      source.set(new TextEncoder().encode("RIFF"), 0);
      view.setUint32(4, source.byteLength - 8, true);
      source.set(new TextEncoder().encode("WEBPVP8X"), 8);
      view.setUint32(16, 10, true);
      source[20] = 0x10;
      source.set(new TextEncoder().encode("ALPH"), 30);
      view.setUint32(34, 2, true);
      source[38] = control;
      source[39] = 0;
      source.set(new TextEncoder().encode(imageType), 40);
      view.setUint32(44, 10, true);
      source.set([0x9d, 0x01, 0x2a], 51);
      view.setUint16(54, 1, true);
      view.setUint16(56, 1, true);
      return source;
    };

    await expect(inspectImageSource(webpWithAlpha(1))).resolves.toEqual({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    await expect(inspectImageSource(webpWithAlpha(3))).rejects.toThrow(
      "invalid_image_source",
    );
    await expect(
      inspectImageSource(webpWithAlpha(0, "VP8L")),
    ).rejects.toThrow("invalid_image_source");
  });

  it("validates signaled ICC profiles before WebP image data", async () => {
    const webpWithIccp = (flags: number, profileLength = 1) => {
      const source = new Uint8Array(58);
      const view = new DataView(source.buffer);
      source.set(new TextEncoder().encode("RIFF"), 0);
      view.setUint32(4, source.byteLength - 8, true);
      source.set(new TextEncoder().encode("WEBPVP8X"), 8);
      view.setUint32(16, 10, true);
      source[20] = flags;
      source.set(new TextEncoder().encode("ICCP"), 30);
      view.setUint32(34, profileLength, true);
      source[38] = 1;
      source.set(new TextEncoder().encode("VP8 "), 40);
      view.setUint32(44, 10, true);
      source.set([0x9d, 0x01, 0x2a], 51);
      view.setUint16(54, 1, true);
      view.setUint16(56, 1, true);
      return source;
    };

    await expect(inspectImageSource(webpWithIccp(0x20))).resolves.toEqual({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    await expect(inspectImageSource(webpWithIccp(0))).rejects.toThrow(
      "invalid_image_source",
    );
    await expect(inspectImageSource(webpWithIccp(0x20, 0))).rejects.toThrow(
      "invalid_image_source",
    );
    const nonzeroPadding = webpWithIccp(0x20);
    nonzeroPadding[39] = 1;
    await expect(inspectImageSource(nonzeroPadding)).rejects.toThrow(
      "invalid_image_source",
    );
    const lateExtendedHeader = new Uint8Array(66);
    const lateHeaderView = new DataView(lateExtendedHeader.buffer);
    const normalExtended = webpWithIccp(0x20);
    lateExtendedHeader.set(normalExtended.slice(0, 12));
    lateHeaderView.setUint32(4, lateExtendedHeader.byteLength - 8, true);
    lateExtendedHeader.set(new TextEncoder().encode("JUNK"), 12);
    lateExtendedHeader.set(normalExtended.slice(12), 20);
    await expect(inspectImageSource(lateExtendedHeader)).rejects.toThrow(
      "invalid_image_source",
    );
    const outOfOrder = new Uint8Array(68);
    const outOfOrderView = new DataView(outOfOrder.buffer);
    outOfOrder.set(new TextEncoder().encode("RIFF"), 0);
    outOfOrderView.setUint32(4, outOfOrder.byteLength - 8, true);
    outOfOrder.set(new TextEncoder().encode("WEBPVP8X"), 8);
    outOfOrderView.setUint32(16, 10, true);
    outOfOrder[20] = 0x30;
    outOfOrder.set(new TextEncoder().encode("ALPH"), 30);
    outOfOrderView.setUint32(34, 2, true);
    outOfOrder.set(new TextEncoder().encode("ICCP"), 40);
    outOfOrderView.setUint32(44, 1, true);
    outOfOrder[48] = 1;
    outOfOrder.set(new TextEncoder().encode("VP8 "), 50);
    outOfOrderView.setUint32(54, 10, true);
    outOfOrder.set([0x9d, 0x01, 0x2a], 61);
    outOfOrderView.setUint16(64, 1, true);
    outOfOrderView.setUint16(66, 1, true);
    await expect(inspectImageSource(outOfOrder)).rejects.toThrow(
      "invalid_image_source",
    );
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
  ])("rejects a truncated %s container", async (_format, source) => {
    await expect(inspectImageSource(source)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects PNG image data that cannot be decompressed into scanlines", async () => {
    const malformed = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAEElEQVRnYXJiYWdlLW5vdC16bGlinTtYuwAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    await expect(inspectImageSource(malformed)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects unknown critical PNG chunks", async () => {
    const unknownCriticalChunk = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAAEFCQ0TbFyClAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    await expect(inspectImageSource(unknownCriticalChunk)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects invalid PNG chunk type bytes and reserved bits", async () => {
    await expect(
      inspectImageSource(pngWithEmptyChunk(validPng, "a1CD")),
    ).rejects.toThrow("invalid_image_source");
    await expect(
      inspectImageSource(pngWithEmptyChunk(validPng, "abcd")),
    ).rejects.toThrow("invalid_image_source");
  });

  it("rejects excessive empty PNG image-data chunks", async () => {
    await expect(
      inspectImageSource(pngWithEmptyImageDataChunks(validPng, 4_097)),
    ).rejects.toThrow("invalid_image_source");
  });

  it("rejects noncontiguous PNG image-data chunks", async () => {
    const noncontiguousImageData = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAABUlEQVR42mNk+DShCs4AAAAAdEVYdJZCxYUAAAAGSURBVA8AAQUBARHLD0wAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    await expect(inspectImageSource(noncontiguousImageData)).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("rejects attacker-sized PNG scanlines before decompression", async () => {
    await expect(inspectImageSource(pngWithHeight(0xffffffff))).rejects.toThrow(
      "invalid_image_source",
    );
  });

  it("accepts narrow Adam7 images with empty passes", async () => {
    const narrowAdam7 = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAIAQMAAAF10zeUAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gccBhIglPOK2gAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yOFQwNjoxODozMiswMDowMPjQ7pIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjhUMDY6MTg6MzIrMDA6MDCJjVYuAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTI4VDA2OjE4OjMyKzAwOjAw3ph38QAAAAtJREFUCNdjYEAFAAAQAAGhxSHBAAAAAElFTkSuQmCC",
        "base64",
      ),
    );

    await expect(inspectImageSource(narrowAdam7)).resolves.toEqual({
      contentType: "image/png",
      width: 1,
      height: 8,
    });

    await expect(
      inspectImageSource(pngWithoutChunk(narrowAdam7, "PLTE")),
    ).rejects.toThrow("invalid_image_source");
  });

  it("accepts partial indexed palettes and rejects out-of-range indices", async () => {
    const partialPalette = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAACVBMVEX/AAAA/wAAAP8tSs2KAAAACklEQVR4nGNgAgAABAAD7+QY5AAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const outOfRangeIndex = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAACVBMVEX/AAAA/wAAAP8tSs2KAAAACklEQVR4nGNgBgAABQAE69OlZgAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    await expect(inspectImageSource(partialPalette)).resolves.toEqual({
      contentType: "image/png",
      width: 1,
      height: 1,
    });
    await expect(inspectImageSource(outOfRangeIndex)).rejects.toThrow(
      "invalid_image_source",
    );
  });
});

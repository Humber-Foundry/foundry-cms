export type ImageSourceMetadata = Readonly<{
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  width: number;
  height: number;
}>;

const invalid = (): never => {
  throw new TypeError("invalid_image_source");
};

function dimensions(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    invalid();
  }
  return { width, height };
}

function ascii(source: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...source.slice(start, end));
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(source: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ source[index]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(source: Uint8Array): ImageSourceMetadata | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => source[index] === byte)) return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let offset = 8;
  let metadata: ImageSourceMetadata | null = null;
  let sawImageData = false;
  while (offset + 12 <= source.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > source.byteLength) invalid();
    const type = ascii(source, offset + 4, offset + 8);
    const expectedCrc = view.getUint32(offset + 8 + length);
    if (crc32(source, offset + 4, offset + 8 + length) !== expectedCrc) {
      invalid();
    }
    if (metadata === null) {
      if (type !== "IHDR" || length !== 13) invalid();
      metadata = {
        contentType: "image/png",
        ...dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12)),
      };
    } else if (type === "IHDR") {
      invalid();
    }
    if (type === "IDAT") sawImageData = sawImageData || length > 0;
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || end !== source.byteLength) invalid();
      return metadata;
    }
    offset = end;
  }
  return invalid();
}

function exifOrientation(
  source: Uint8Array,
  payloadOffset: number,
  payloadLength: number,
) {
  if (
    payloadLength < 14 ||
    ascii(source, payloadOffset, payloadOffset + 6) !== "Exif\u0000\u0000"
  ) {
    return 1;
  }
  const tiff = payloadOffset + 6;
  const littleEndian =
    source[tiff] === 0x49 && source[tiff + 1] === 0x49
      ? true
      : source[tiff] === 0x4d && source[tiff + 1] === 0x4d
        ? false
        : null;
  if (littleEndian === null) return 1;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (view.getUint16(tiff + 2, littleEndian) !== 42) return 1;
  const directory = tiff + view.getUint32(tiff + 4, littleEndian);
  const payloadEnd = payloadOffset + payloadLength;
  if (directory < tiff || directory + 2 > payloadEnd) return 1;
  const count = view.getUint16(directory, littleEndian);
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > payloadEnd) return 1;
    if (
      view.getUint16(entry, littleEndian) === 0x0112 &&
      view.getUint16(entry + 2, littleEndian) === 3 &&
      view.getUint32(entry + 4, littleEndian) === 1
    ) {
      const orientation = view.getUint16(entry + 8, littleEndian);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}

function jpeg(source: Uint8Array): ImageSourceMetadata | null {
  if (source[0] !== 0xff || source[1] !== 0xd8) return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const frames = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  let metadata: ImageSourceMetadata | null = null;
  let orientation = 1;
  let sawScan = false;
  while (offset < source.byteLength) {
    if (source[offset] !== 0xff) invalid();
    while (source[offset] === 0xff) offset += 1;
    const marker = source[offset++];
    if (marker === undefined) invalid();
    if (marker === 0xd9) {
      if (!sawScan || offset !== source.byteLength) invalid();
      if (metadata === null) throw new TypeError("invalid_image_source");
      return orientation >= 5 && orientation <= 8
        ? { ...metadata, width: metadata.height, height: metadata.width }
        : metadata;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > source.byteLength) invalid();
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > source.byteLength) invalid();
    if (marker === 0xe1) {
      orientation = exifOrientation(source, offset + 2, length - 2);
    }
    if (frames.has(marker)) {
      if (length < 7 || metadata !== null) invalid();
      metadata = {
        contentType: "image/jpeg",
        ...dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)),
      };
    }
    offset += length;
    if (marker !== 0xda) continue;
    sawScan = true;
    while (offset + 1 < source.byteLength) {
      if (source[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const next = source[offset + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        offset += 2;
        continue;
      }
      break;
    }
  }
  return invalid();
}

function webp(source: Uint8Array): ImageSourceMetadata | null {
  if (ascii(source, 0, 4) !== "RIFF" || ascii(source, 8, 12) !== "WEBP") {
    return null;
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (source.byteLength < 20 || view.getUint32(4, true) + 8 !== source.byteLength) {
    invalid();
  }
  let offset = 12;
  let metadata: ImageSourceMetadata | null = null;
  let sawImagePayload = false;
  while (offset + 8 <= source.byteLength) {
    const type = ascii(source, offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    const end = data + length + (length % 2);
    if (end > source.byteLength) invalid();
    if (type === "VP8X") {
      if (length !== 10 || metadata !== null) invalid();
      const width = source[data + 4]! | (source[data + 5]! << 8) | (source[data + 6]! << 16);
      const height = source[data + 7]! | (source[data + 8]! << 8) | (source[data + 9]! << 16);
      metadata = { contentType: "image/webp", ...dimensions(width + 1, height + 1) };
    } else if (type === "VP8 ") {
      if (
        length < 10 ||
        source[data + 3] !== 0x9d ||
        source[data + 4] !== 0x01 ||
        source[data + 5] !== 0x2a
      ) {
        invalid();
      }
      sawImagePayload = true;
      metadata ??= {
        contentType: "image/webp",
        ...dimensions(
          view.getUint16(data + 6, true) & 0x3fff,
          view.getUint16(data + 8, true) & 0x3fff,
        ),
      };
    } else if (type === "VP8L") {
      if (length < 5 || source[data] !== 0x2f) invalid();
      sawImagePayload = true;
      const bits = view.getUint32(data + 1, true);
      metadata ??= {
        contentType: "image/webp",
        ...dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1),
      };
    } else if (type === "ANMF") {
      sawImagePayload = length > 16;
    }
    offset = end;
  }
  if (offset !== source.byteLength || metadata === null || !sawImagePayload) {
    invalid();
  }
  return metadata;
}

function avif(source: Uint8Array): ImageSourceMetadata | null {
  if (source.byteLength < 16 || ascii(source, 4, 8) !== "ftyp") return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let offset = 0;
  let validBrand = false;
  let sawMeta = false;
  let sawImagePayload = false;
  while (offset + 8 <= source.byteLength) {
    const size32 = view.getUint32(offset);
    const type = ascii(source, offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > source.byteLength) invalid();
      const extended = view.getBigUint64(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      size = source.byteLength - offset;
    }
    if (size < headerSize || offset + size > source.byteLength) invalid();
    if (type === "ftyp") {
      const brands = ascii(source, offset + headerSize, offset + size);
      validBrand = brands.includes("avif") || brands.includes("avis");
    }
    if (type === "meta") sawMeta = size > headerSize + 4;
    if (type === "mdat") sawImagePayload = size > headerSize;
    offset += size;
  }
  if (offset !== source.byteLength || !validBrand || !sawMeta || !sawImagePayload) {
    invalid();
  }
  for (let index = 0; index + 20 <= source.byteLength; index += 1) {
    if (ascii(source, index + 4, index + 8) !== "ispe") continue;
    const size = view.getUint32(index);
    if (size < 20 || index + size > source.byteLength) continue;
    return {
      contentType: "image/avif",
      ...dimensions(view.getUint32(index + 12), view.getUint32(index + 16)),
    };
  }
  return invalid();
}

export function inspectImageSource(source: Uint8Array): ImageSourceMetadata {
  if (source.byteLength < 12) invalid();
  return png(source) ?? jpeg(source) ?? webp(source) ?? avif(source) ?? invalid();
}

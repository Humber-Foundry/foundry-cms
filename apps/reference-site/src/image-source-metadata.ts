export type ImageSourceMetadata = Readonly<{
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  width: number;
  height: number;
}>;

function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError("invalid_image_source");
  }
  return { width, height };
}

function ascii(source: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...source.slice(start, end));
}

function png(source: Uint8Array): ImageSourceMetadata | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => source[index] === byte)) return null;
  if (source.byteLength < 24 || ascii(source, 12, 16) !== "IHDR") throw new TypeError("invalid_image_source");
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  return { contentType: "image/png", ...dimensions(view.getUint32(16), view.getUint32(20)) };
}

function jpeg(source: Uint8Array): ImageSourceMetadata | null {
  if (source[0] !== 0xff || source[1] !== 0xd8) return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < source.byteLength) {
    if (source[offset] !== 0xff) break;
    while (source[offset] === 0xff) offset += 1;
    const marker = source[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > source.byteLength) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > source.byteLength) break;
    if (frames.has(marker) && length >= 7) {
      return { contentType: "image/jpeg", ...dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)) };
    }
    offset += length;
  }
  throw new TypeError("invalid_image_source");
}

function webp(source: Uint8Array): ImageSourceMetadata | null {
  if (ascii(source, 0, 4) !== "RIFF" || ascii(source, 8, 12) !== "WEBP") return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const chunk = ascii(source, 12, 16);
  if (chunk === "VP8X" && source.byteLength >= 30) {
    const width = source[24]! | (source[25]! << 8) | (source[26]! << 16);
    const height = source[27]! | (source[28]! << 8) | (source[29]! << 16);
    return { contentType: "image/webp", ...dimensions(width + 1, height + 1) };
  }
  if (chunk === "VP8 " && source.byteLength >= 30 && source[23] === 0x9d && source[24] === 0x01 && source[25] === 0x2a) {
    return { contentType: "image/webp", ...dimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff) };
  }
  if (chunk === "VP8L" && source.byteLength >= 25 && source[20] === 0x2f) {
    const bits = view.getUint32(21, true);
    return { contentType: "image/webp", ...dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) };
  }
  throw new TypeError("invalid_image_source");
}

function avif(source: Uint8Array): ImageSourceMetadata | null {
  if (source.byteLength < 16 || ascii(source, 4, 8) !== "ftyp") return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const ftypSize = Math.min(source.byteLength, view.getUint32(0));
  const brands = ascii(source, 8, ftypSize);
  if (!brands.includes("avif") && !brands.includes("avis")) return null;
  for (let offset = 0; offset + 20 <= source.byteLength; offset += 1) {
    if (ascii(source, offset + 4, offset + 8) !== "ispe") continue;
    const size = view.getUint32(offset);
    if (size < 20 || offset + size > source.byteLength) continue;
    return { contentType: "image/avif", ...dimensions(view.getUint32(offset + 12), view.getUint32(offset + 16)) };
  }
  throw new TypeError("invalid_image_source");
}

export function inspectImageSource(source: Uint8Array): ImageSourceMetadata {
  if (source.byteLength < 12) throw new TypeError("invalid_image_source");
  const metadata = png(source) ?? jpeg(source) ?? webp(source) ?? avif(source);
  if (metadata === null) throw new TypeError("invalid_image_source");
  return metadata;
}

export type ImageSourceMetadata = Readonly<{
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  width: number;
  height: number;
}>;

const invalid = (): never => {
  throw new TypeError("invalid_image_source");
};

const maxPngRasterBytes = 16 * 1024 * 1024;
const maxPngRowBytes = 8 * 1024 * 1024;
const maxPngRows = 100_000;
const maxImagePixels = 40_000_000;
const maxPngChunks = 4_096;
const maxWebpChunks = 4_096;

function dimensions(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    width * height > maxImagePixels
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

async function validatePngRaster(
  chunks: ReadonlyArray<Uint8Array>,
  passes: ReadonlyArray<
    Readonly<{ rowLength: number; rowCount: number; pixelWidth: number }>
  >,
  indexed:
    | Readonly<{ bitDepth: number; paletteEntries: number }>
    | undefined,
) {
  const expectedLength = passes.reduce(
    (total, pass) =>
      total + (pass.rowLength + 1) * pass.rowCount,
    0,
  );
  const compressed = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let compressedOffset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.byteLength;
  }
  try {
    const reader = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"))
      .getReader();
    const raster = new Uint8Array(expectedLength);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > raster.byteLength) {
        await reader.cancel();
        invalid();
      }
      raster.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expectedLength) invalid();
    offset = 0;
    for (const pass of passes) {
      let previous = new Uint8Array(pass.rowLength);
      let current = new Uint8Array(pass.rowLength);
      for (let row = 0; row < pass.rowCount; row += 1) {
        const filter = raster[offset];
        if (filter === undefined || filter > 4) invalid();
        if (indexed !== undefined) {
          current.fill(0);
          for (let byte = 0; byte < pass.rowLength; byte += 1) {
            const encoded = raster[offset + 1 + byte]!;
            const left = byte === 0 ? 0 : current[byte - 1]!;
            const above = previous[byte]!;
            const upperLeft = byte === 0 ? 0 : previous[byte - 1]!;
            let predictor = 0;
            if (filter === 1) predictor = left;
            if (filter === 2) predictor = above;
            if (filter === 3) predictor = Math.floor((left + above) / 2);
            if (filter === 4) {
              const estimate = left + above - upperLeft;
              const leftDistance = Math.abs(estimate - left);
              const aboveDistance = Math.abs(estimate - above);
              const upperLeftDistance = Math.abs(estimate - upperLeft);
              predictor =
                leftDistance <= aboveDistance &&
                leftDistance <= upperLeftDistance
                  ? left
                  : aboveDistance <= upperLeftDistance
                    ? above
                    : upperLeft;
            }
            current[byte] = (encoded + predictor) & 0xff;
          }
          const mask = (1 << indexed.bitDepth) - 1;
          for (let pixel = 0; pixel < pass.pixelWidth; pixel += 1) {
            const bitOffset = pixel * indexed.bitDepth;
            const paletteIndex =
              (current[Math.floor(bitOffset / 8)]! >>
                (8 - indexed.bitDepth - (bitOffset % 8))) &
              mask;
            if (paletteIndex >= indexed.paletteEntries) invalid();
          }
          const completed = previous;
          previous = current;
          current = completed;
        }
        offset += pass.rowLength + 1;
      }
    }
  } catch {
    invalid();
  }
}

function pngRows(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
): ReadonlyArray<
  Readonly<{ rowLength: number; rowCount: number; pixelWidth: number }>
> {
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ]).get(colorType);
  const validDepths: Readonly<Record<number, ReadonlyArray<number>>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    channels === undefined ||
    !validDepths[colorType]?.includes(bitDepth) ||
    (interlace !== 0 && interlace !== 1)
  ) {
    invalid();
  }
  const channelCount = channels as number;
  const passes =
    interlace === 0
      ? [[0, 0, 1, 1] as const]
      : ([
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ] as const);
  const rows: Array<
    Readonly<{ rowLength: number; rowCount: number; pixelWidth: number }>
  > = [];
  let rasterBytes = 0;
  let rasterRows = 0;
  let rasterPixels = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth =
      width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight =
      height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (passWidth === 0 || passHeight === 0) continue;
    const rowLength = Math.ceil(
      (passWidth * channelCount * bitDepth) / 8,
    );
    const passBytes = (rowLength + 1) * passHeight;
    const passPixels = passWidth * passHeight;
    if (
      rowLength > maxPngRowBytes ||
      !Number.isSafeInteger(passBytes) ||
      !Number.isSafeInteger(passPixels) ||
      rasterBytes + passBytes > maxPngRasterBytes ||
      rasterRows + passHeight > maxPngRows ||
      rasterPixels + passPixels > maxImagePixels
    ) {
      invalid();
    }
    rasterBytes += passBytes;
    rasterRows += passHeight;
    rasterPixels += passPixels;
    rows.push({ rowLength, rowCount: passHeight, pixelWidth: passWidth });
  }
  return rows;
}

async function png(source: Uint8Array): Promise<ImageSourceMetadata | null> {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => source[index] === byte)) return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let offset = 8;
  let metadata: ImageSourceMetadata | null = null;
  let sawImageData = false;
  let startedImageData = false;
  let endedImageData = false;
  let sawPalette = false;
  let paletteEntries: number | null = null;
  let bitDepth: number | null = null;
  let colorType: number | null = null;
  let chunkCount = 0;
  let rasterPasses: ReturnType<typeof pngRows> | null = null;
  const imageData: Uint8Array[] = [];
  while (offset + 12 <= source.byteLength) {
    chunkCount += 1;
    if (chunkCount > maxPngChunks) invalid();
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > source.byteLength) invalid();
    const type = ascii(source, offset + 4, offset + 8);
    const typeBytes = source.slice(offset + 4, offset + 8);
    if (
      typeBytes.some(
        (byte) =>
          !(
            (byte >= 0x41 && byte <= 0x5a) ||
            (byte >= 0x61 && byte <= 0x7a)
          ),
      ) ||
      typeBytes[2]! < 0x41 ||
      typeBytes[2]! > 0x5a
    ) {
      invalid();
    }
    const expectedCrc = view.getUint32(offset + 8 + length);
    if (crc32(source, offset + 4, offset + 8 + length) !== expectedCrc) {
      invalid();
    }
    if (
      !["IHDR", "PLTE", "IDAT", "IEND"].includes(type) &&
      source[offset + 4]! >= 0x41 &&
      source[offset + 4]! <= 0x5a
    ) {
      invalid();
    }
    if (metadata === null) {
      if (type !== "IHDR" || length !== 13) invalid();
      metadata = {
        contentType: "image/png",
        ...dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12)),
      };
      bitDepth = source[offset + 16]!;
      colorType = source[offset + 17]!;
      if (
        source[offset + 18] !== 0 ||
        source[offset + 19] !== 0
      ) {
        invalid();
      }
      rasterPasses = pngRows(
        metadata.width,
        metadata.height,
        bitDepth,
        colorType,
        source[offset + 20]!,
      );
    } else if (type === "IHDR") {
      invalid();
    }
    if (startedImageData && type !== "IDAT") endedImageData = true;
    if (type === "PLTE") {
      if (
        sawPalette ||
        startedImageData ||
        colorType === 0 ||
        colorType === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 256 * 3 ||
        (colorType === 3 && length / 3 > 2 ** (bitDepth ?? invalid()))
      ) {
        invalid();
      }
      sawPalette = true;
      paletteEntries = length / 3;
    }
    if (type === "IDAT") {
      if (endedImageData) invalid();
      if (colorType === 3 && (!sawPalette || paletteEntries === null)) {
        invalid();
      }
      startedImageData = true;
      if (length > 0) {
        sawImageData = true;
        imageData.push(source.slice(offset + 8, offset + 8 + length));
      }
    }
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || end !== source.byteLength) invalid();
      await validatePngRaster(
        imageData,
        rasterPasses ?? invalid(),
        colorType === 3
          ? {
              bitDepth: bitDepth ?? invalid(),
              paletteEntries: paletteEntries ?? invalid(),
            }
          : undefined,
      );
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
): number | null {
  if (
    payloadLength < 14 ||
    ascii(source, payloadOffset, payloadOffset + 6) !== "Exif\u0000\u0000"
  ) {
    return null;
  }
  const tiff = payloadOffset + 6;
  const littleEndian =
    source[tiff] === 0x49 && source[tiff + 1] === 0x49
      ? true
      : source[tiff] === 0x4d && source[tiff + 1] === 0x4d
        ? false
        : null;
  if (littleEndian === null) return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (view.getUint16(tiff + 2, littleEndian) !== 42) return null;
  const directory = tiff + view.getUint32(tiff + 4, littleEndian);
  const payloadEnd = payloadOffset + payloadLength;
  if (directory < tiff || directory + 2 > payloadEnd) return null;
  const count = view.getUint16(directory, littleEndian);
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > payloadEnd) return null;
    if (
      view.getUint16(entry, littleEndian) === 0x0112 &&
      view.getUint16(entry + 2, littleEndian) === 3 &&
      view.getUint32(entry + 4, littleEndian) === 1
    ) {
      const orientation = view.getUint16(entry + 8, littleEndian);
      return orientation >= 1 && orientation <= 8 ? orientation : null;
    }
  }
  return null;
}

function jpeg(source: Uint8Array): ImageSourceMetadata | null {
  if (source[0] !== 0xff || source[1] !== 0xd8) return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const frames = new Set([0xc0, 0xc1, 0xc2]);
  const unsupportedFrames = new Set([
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
  ]);
  let offset = 2;
  let metadata: ImageSourceMetadata | null = null;
  let orientation = 1;
  let sawOrientation = false;
  let sawScan = false;
  let frameComponents: ReadonlySet<number> | null = null;
  let frameMarker: number | null = null;
  const definedQuantizationTables = new Set<number>();
  const frameQuantizationTables = new Map<number, number>();
  const quantizationTableGenerations = new Map<number, number>();
  const progressiveComponentTableGenerations = new Map<number, number>();
  const definedHuffmanTables = new Set<string>();
  const sequentialCompatibleAcTables = new Map<number, boolean>();
  const scannedFrameComponents = new Set<number>();
  const initialDcComponents = new Set<number>();
  const progressiveApproximation = new Map<string, number>();
  let restartInterval = 0;
  while (offset < source.byteLength) {
    if (source[offset] !== 0xff) invalid();
    while (source[offset] === 0xff) offset += 1;
    const marker = source[offset++];
    if (marker === undefined) invalid();
    if (marker === 0xd9) {
      const declaredFrameComponents = frameComponents ?? invalid();
      const coveredComponents =
        frameMarker === 0xc2 ? initialDcComponents : scannedFrameComponents;
      if (
        !sawScan ||
        offset !== source.byteLength ||
        [...declaredFrameComponents].some(
          (componentId) => !coveredComponents.has(componentId),
        )
      ) {
        invalid();
      }
      if (metadata === null) throw new TypeError("invalid_image_source");
      return orientation >= 5 && orientation <= 8
        ? { ...metadata, width: metadata.height, height: metadata.width }
        : metadata;
    }
    if (marker === 0xd8) invalid();
    if (unsupportedFrames.has(marker)) invalid();
    if (marker === 0x01) continue;
    if (marker < 0xc0) invalid();
    if (marker >= 0xd0 && marker <= 0xd7) invalid();
    if (offset + 2 > source.byteLength) invalid();
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > source.byteLength) invalid();
    if (marker === 0xdd) {
      if (length !== 4) invalid();
      restartInterval = view.getUint16(offset + 2);
    }
    if (marker === 0xe1 && !sawOrientation) {
      const found = exifOrientation(source, offset + 2, length - 2);
      if (found !== null) {
        orientation = found;
        sawOrientation = true;
      }
    }
    if (marker === 0xdb) {
      let tableOffset = offset + 2;
      const tableEnd = offset + length;
      while (tableOffset < tableEnd) {
        const tableInformation = source[tableOffset++]!;
        const precision = tableInformation >>> 4;
        const tableId = tableInformation & 0x0f;
        const tableBytes = precision === 0 ? 64 : 0;
        if (tableId > 3 || tableBytes === 0 || tableOffset + tableBytes > tableEnd) {
          invalid();
        }
        for (
          let coefficientOffset = tableOffset;
          coefficientOffset < tableOffset + tableBytes;
          coefficientOffset += precision === 0 ? 1 : 2
        ) {
          const coefficient =
            precision === 0
              ? source[coefficientOffset]!
              : view.getUint16(coefficientOffset);
          if (coefficient === 0) invalid();
        }
        definedQuantizationTables.add(tableId);
        quantizationTableGenerations.set(
          tableId,
          (quantizationTableGenerations.get(tableId) ?? 0) + 1,
        );
        tableOffset += tableBytes;
      }
      if (tableOffset !== tableEnd) invalid();
    }
    if (marker === 0xc4) {
      let tableOffset = offset + 2;
      const tableEnd = offset + length;
      while (tableOffset < tableEnd) {
        const tableInformation = source[tableOffset++]!;
        const tableClass = tableInformation >>> 4;
        const tableId = tableInformation & 0x0f;
        if (tableClass > 1 || tableId > 3 || tableOffset + 16 > tableEnd) {
          invalid();
        }
        let symbolCount = 0;
        let availableCodes = 1;
        for (let index = 0; index < 16; index += 1) {
          const count = source[tableOffset + index]!;
          availableCodes = availableCodes * 2 - count;
          if (availableCodes < 0) invalid();
          symbolCount += count;
        }
        tableOffset += 16;
        if (
          symbolCount === 0 ||
          symbolCount > 256 ||
          availableCodes === 0 ||
          tableOffset + symbolCount > tableEnd
        ) {
          invalid();
        }
        const symbols = source.slice(tableOffset, tableOffset + symbolCount);
        const sequentialCompatibleAcTable =
          tableClass !== 1 ||
          symbols.every((symbol) => {
            const size = symbol & 0x0f;
            return size > 0 || symbol === 0x00 || symbol === 0xf0;
          });
        if (
          new Set(symbols).size !== symbolCount ||
          (tableClass === 0
            ? symbols.some((symbol) => symbol > 11)
            : symbols.some((symbol) => (symbol & 0x0f) > 10))
        ) {
          invalid();
        }
        definedHuffmanTables.add(`${tableClass}:${tableId}`);
        if (tableClass === 1) {
          sequentialCompatibleAcTables.set(
            tableId,
            sequentialCompatibleAcTable,
          );
        }
        tableOffset += symbolCount;
      }
      if (tableOffset !== tableEnd) invalid();
    }
    if (frames.has(marker)) {
      const componentCount = source[offset + 7];
      if (
        source[offset + 2] !== 8 ||
        componentCount === undefined ||
        componentCount < 1 ||
        componentCount > 4 ||
        length !== 8 + componentCount * 3 ||
        metadata !== null
      ) {
        invalid();
      }
      const componentIds = new Set<number>();
      let blocksPerMcu = 0;
      for (let index = 0; index < componentCount; index += 1) {
        const descriptor = offset + 8 + index * 3;
        componentIds.add(source[descriptor]!);
        const sampling = source[descriptor + 1]!;
        const horizontalSampling = sampling >>> 4;
        const verticalSampling = sampling & 0x0f;
        const quantizationTable = source[descriptor + 2]!;
        if (
          horizontalSampling < 1 ||
          horizontalSampling > 4 ||
          verticalSampling < 1 ||
          verticalSampling > 4 ||
          quantizationTable > 3
        ) {
          invalid();
        }
        frameQuantizationTables.set(
          source[descriptor]!,
          quantizationTable,
        );
        blocksPerMcu += horizontalSampling * verticalSampling;
      }
      if (componentIds.size !== componentCount || blocksPerMcu > 10) invalid();
      frameComponents = componentIds;
      frameMarker = marker;
      metadata = {
        contentType: "image/jpeg",
        ...dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)),
      };
    }
    if (marker === 0xda) {
      const componentCount = source[offset + 2];
      const availableFrameComponents = frameComponents ?? invalid();
      if (
        componentCount === undefined ||
        componentCount < 1 ||
        componentCount > 4 ||
        length !== 6 + componentCount * 2
      ) {
        invalid();
      }
      const scanComponents = new Set<number>();
      const spectralStart = source[offset + 3 + componentCount * 2]!;
      const spectralEnd = source[offset + 4 + componentCount * 2]!;
      const approximation = source[offset + 5 + componentCount * 2]!;
      const approximationHigh = approximation >>> 4;
      const approximationLow = approximation & 0x0f;
      for (let index = 0; index < componentCount; index += 1) {
        const componentId = source[offset + 3 + index * 2]!;
        const tableSelectors = source[offset + 4 + index * 2]!;
        if (!availableFrameComponents.has(componentId)) invalid();
        const selectorLimit = frameMarker === 0xc0 ? 1 : 3;
        if (
          (tableSelectors >>> 4) > selectorLimit ||
          (tableSelectors & 0x0f) > selectorLimit
        ) {
          invalid();
        }
        if (
          (frameMarker !== 0xc2 &&
            (!definedHuffmanTables.has(`0:${tableSelectors >>> 4}`) ||
              !definedHuffmanTables.has(`1:${tableSelectors & 0x0f}`) ||
              sequentialCompatibleAcTables.get(tableSelectors & 0x0f) !==
                true)) ||
          (frameMarker === 0xc2 &&
            spectralStart === 0 &&
            !definedHuffmanTables.has(`0:${tableSelectors >>> 4}`)) ||
          (frameMarker === 0xc2 &&
            spectralStart > 0 &&
            !definedHuffmanTables.has(`1:${tableSelectors & 0x0f}`))
        ) {
          invalid();
        }
        scanComponents.add(componentId);
      }
      if (scanComponents.size !== componentCount) invalid();
      for (const componentId of scanComponents) {
        const tableId =
          frameQuantizationTables.get(componentId) ?? invalid();
        if (!definedQuantizationTables.has(tableId)) invalid();
      }
      if (frameMarker === 0xc2) {
        for (const componentId of scanComponents) {
          const tableId =
            frameQuantizationTables.get(componentId) ?? invalid();
          const generation =
            quantizationTableGenerations.get(tableId) ?? invalid();
          const firstGeneration =
            progressiveComponentTableGenerations.get(componentId);
          if (
            firstGeneration !== undefined &&
            firstGeneration !== generation
          ) {
            invalid();
          }
          progressiveComponentTableGenerations.set(
            componentId,
            generation,
          );
        }
      }
      if (
        spectralStart > spectralEnd ||
        spectralEnd > 63 ||
        approximationHigh > 13 ||
        approximationLow > 13 ||
        (frameMarker !== 0xc2 &&
          (spectralStart !== 0 ||
            spectralEnd !== 63 ||
            approximation !== 0)) ||
        (frameMarker === 0xc2 &&
          ((spectralStart === 0 && spectralEnd !== 0) ||
            (spectralStart > 0 && componentCount !== 1) ||
            (approximationHigh !== 0 &&
              approximationHigh !== approximationLow + 1)))
      ) {
        invalid();
      }
      if (frameMarker === 0xc2) {
        if (
          (spectralStart > 0 || approximationHigh > 0) &&
          [...scanComponents].some(
            (componentId) => !initialDcComponents.has(componentId),
          )
        ) {
          invalid();
        }
        for (const componentId of scanComponents) {
          for (
            let coefficient = spectralStart;
            coefficient <= spectralEnd;
            coefficient += 1
          ) {
            const key = `${componentId}:${coefficient}`;
            const currentApproximation = progressiveApproximation.get(key);
            if (
              (approximationHigh === 0 &&
                currentApproximation !== undefined) ||
              (approximationHigh > 0 &&
                currentApproximation !== approximationHigh)
            ) {
              invalid();
            }
            progressiveApproximation.set(key, approximationLow);
          }
        }
        if (spectralStart === 0 && approximationHigh === 0) {
          for (const componentId of scanComponents) {
            initialDcComponents.add(componentId);
          }
        }
      } else {
        if (
          [...scanComponents].some((componentId) =>
            scannedFrameComponents.has(componentId),
          )
        ) {
          invalid();
        }
        for (const componentId of scanComponents) {
          scannedFrameComponents.add(componentId);
        }
      }
    }
    offset += length;
    if (marker !== 0xda) continue;
    sawScan = true;
    let scanBytes = 0;
    let expectedRestartMarker = 0xd0;
    while (offset + 1 < source.byteLength) {
      if (source[offset] !== 0xff) {
        scanBytes += 1;
        offset += 1;
        continue;
      }
      const next = source[offset + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        if (next === 0x00) {
          scanBytes += 1;
        } else {
          if (restartInterval === 0 || next !== expectedRestartMarker) {
            invalid();
          }
          expectedRestartMarker =
            next === 0xd7 ? 0xd0 : expectedRestartMarker + 1;
        }
        offset += 2;
        continue;
      }
      break;
    }
    if (scanBytes === 0) invalid();
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
  let chunkCount = 0;
  let animatedCanvas = false;
  let alphaCanvas = false;
  let iccpCanvas = false;
  let exifCanvas = false;
  let xmpCanvas = false;
  let sawAnimationParameters = false;
  let sawAnimatedFrame = false;
  let sawAnimatedAlpha = false;
  let sawStillAlpha = false;
  let sawIccp = false;
  let sawExif = false;
  let sawXmp = false;
  let sawTrailingMetadata = false;
  const knownChunkTypes = new Set([
    "VP8X",
    "ICCP",
    "ANIM",
    "ANMF",
    "ALPH",
    "VP8 ",
    "VP8L",
    "EXIF",
    "XMP ",
  ]);
  const uint24 = (at: number) =>
    source[at]! | (source[at + 1]! << 8) | (source[at + 2]! << 16);
  const imagePayloadDimensions = (
    type: string,
    data: number,
    length: number,
  ): Readonly<{ width: number; height: number }> | null => {
    if (type === "VP8 ") {
      const frameTag =
        source[data]! |
        (source[data + 1]! << 8) |
        (source[data + 2]! << 16);
      if (
        length < 10 ||
        (source[data]! & 1) !== 0 ||
        ((source[data]! >>> 1) & 0x07) > 3 ||
        (frameTag >>> 5) > length - 10 ||
        source[data + 3] !== 0x9d ||
        source[data + 4] !== 0x01 ||
        source[data + 5] !== 0x2a
      ) {
        invalid();
      }
      return dimensions(
        view.getUint16(data + 6, true) & 0x3fff,
        view.getUint16(data + 8, true) & 0x3fff,
      );
    }
    if (type === "VP8L") {
      if (length < 5 || source[data] !== 0x2f) invalid();
      const bits = view.getUint32(data + 1, true);
      if (bits >>> 29 !== 0) invalid();
      return dimensions(
        (bits & 0x3fff) + 1,
        ((bits >>> 14) & 0x3fff) + 1,
      );
    }
    return null;
  };
  const validateAlphaPayload = (
    data: number,
    length: number,
    width: number,
    height: number,
  ) => {
    if (length < 2 || (source[data]! & 0xe2) !== 0) invalid();
    if ((source[data]! & 0x03) === 0 && length !== width * height + 1) {
      invalid();
    }
  };
  while (offset + 8 <= source.byteLength) {
    if ((chunkCount += 1) > maxWebpChunks) invalid();
    const type = ascii(source, offset, offset + 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    const end = data + length + (length % 2);
    if (end > source.byteLength) invalid();
    if (length % 2 === 1 && source[data + length] !== 0) invalid();
    if (type === "VP8X") {
      if (
        length !== 10 ||
        metadata !== null ||
        chunkCount !== 1 ||
        (source[data]! & 0xc1) !== 0 ||
        source[data + 1] !== 0 ||
        source[data + 2] !== 0 ||
        source[data + 3] !== 0
      ) {
        invalid();
      }
      animatedCanvas = (source[data]! & 0x02) !== 0;
      alphaCanvas = (source[data]! & 0x10) !== 0;
      iccpCanvas = (source[data]! & 0x20) !== 0;
      exifCanvas = (source[data]! & 0x08) !== 0;
      xmpCanvas = (source[data]! & 0x04) !== 0;
      const width = source[data + 4]! | (source[data + 5]! << 8) | (source[data + 6]! << 16);
      const height = source[data + 7]! | (source[data + 8]! << 8) | (source[data + 9]! << 16);
      const canvas = dimensions(width + 1, height + 1);
      if (canvas.width * canvas.height > 0xffffffff) invalid();
      metadata = { contentType: "image/webp", ...canvas };
    } else if (type === "ICCP") {
      if (
        metadata === null ||
        !iccpCanvas ||
        sawIccp ||
        sawAnimationParameters ||
        sawStillAlpha ||
        sawImagePayload ||
        length === 0
      ) {
        invalid();
      }
      sawIccp = true;
    } else if (type === "ANIM") {
      if (
        length !== 6 ||
        metadata === null ||
        !animatedCanvas ||
        sawAnimationParameters ||
        sawImagePayload ||
        sawTrailingMetadata
      ) {
        invalid();
      }
      sawAnimationParameters = true;
    } else if (type === "ALPH") {
      const canvas = metadata;
      const canvasMetadata = canvas ?? invalid();
      if (
        animatedCanvas ||
        !alphaCanvas ||
        sawStillAlpha ||
        sawImagePayload
      ) {
        invalid();
      }
      validateAlphaPayload(
        data,
        length,
        canvasMetadata.width,
        canvasMetadata.height,
      );
      sawStillAlpha = true;
    } else if (type === "VP8 " || type === "VP8L") {
      const payload = imagePayloadDimensions(type, data, length) ?? invalid();
      const extended = metadata !== null;
      if (
        animatedCanvas ||
        sawImagePayload ||
        sawTrailingMetadata ||
        (sawStillAlpha && type !== "VP8 ") ||
        (extended &&
          type === "VP8 " &&
          alphaCanvas !== sawStillAlpha) ||
        (metadata !== null &&
          (metadata.width !== payload.width ||
            metadata.height !== payload.height))
      ) {
        invalid();
      }
      sawImagePayload = true;
      metadata ??= {
        contentType: "image/webp",
        width: payload.width,
        height: payload.height,
      };
    } else if (type === "ANMF") {
      const canvas = metadata;
      if (
        length < 24 ||
        !animatedCanvas ||
        !sawAnimationParameters ||
        sawTrailingMetadata
      ) {
        invalid();
      }
      const canvasMetadata = canvas ?? invalid();
      const frameX = uint24(data) * 2;
      const frameY = uint24(data + 3) * 2;
      const frameWidth = uint24(data + 6) + 1;
      const frameHeight = uint24(data + 9) + 1;
      if (
        (source[data + 15]! & 0xfc) !== 0 ||
        frameX + frameWidth > canvasMetadata.width ||
        frameY + frameHeight > canvasMetadata.height
      ) {
        invalid();
      }
      const frameEnd = data + length;
      let frameOffset = data + 16;
      let framePayload: Readonly<{ width: number; height: number }> | null =
        null;
      let sawAlpha = false;
      while (frameOffset + 8 <= frameEnd) {
        if ((chunkCount += 1) > maxWebpChunks) invalid();
        const frameType = ascii(source, frameOffset, frameOffset + 4);
        const frameLength = view.getUint32(frameOffset + 4, true);
        const frameData = frameOffset + 8;
        const childEnd = frameData + frameLength + (frameLength % 2);
        if (childEnd > frameEnd) invalid();
        if (
          frameLength % 2 === 1 &&
          source[frameData + frameLength] !== 0
        ) {
          invalid();
        }
        if (frameType === "ALPH") {
          if (
            !alphaCanvas ||
            sawAlpha ||
            framePayload !== null ||
            frameLength === 0
          ) {
            invalid();
          }
          validateAlphaPayload(
            frameData,
            frameLength,
            frameWidth,
            frameHeight,
          );
          sawAlpha = true;
        } else {
          const candidate = imagePayloadDimensions(
            frameType,
            frameData,
            frameLength,
          );
          if (
            candidate === null &&
            framePayload !== null &&
            !knownChunkTypes.has(frameType)
          ) {
            frameOffset = childEnd;
            continue;
          }
          if (
            candidate === null ||
            framePayload !== null ||
            (sawAlpha && frameType !== "VP8 ") ||
            candidate.width !== frameWidth ||
            candidate.height !== frameHeight
          ) {
            invalid();
          }
          framePayload = candidate;
          if (sawAlpha || frameType === "VP8L") sawAnimatedAlpha = true;
        }
        frameOffset = childEnd;
      }
      if (frameOffset !== frameEnd || framePayload === null) invalid();
      sawImagePayload = true;
      sawAnimatedFrame = true;
    } else if (type === "EXIF" || type === "XMP ") {
      const signaled = type === "EXIF" ? exifCanvas : xmpCanvas;
      const alreadySaw = type === "EXIF" ? sawExif : sawXmp;
      if (
        metadata === null ||
        !signaled ||
        alreadySaw ||
        !sawImagePayload ||
        length === 0
      ) {
        invalid();
      }
      if (type === "EXIF") sawExif = true;
      else sawXmp = true;
      sawTrailingMetadata = true;
    }
    offset = end;
  }
  if (offset !== source.byteLength || metadata === null || !sawImagePayload) {
    invalid();
  }
  if (animatedCanvas && (!sawAnimationParameters || !sawAnimatedFrame)) {
    invalid();
  }
  if (animatedCanvas && alphaCanvas && !sawAnimatedAlpha) invalid();
  if (
    iccpCanvas !== sawIccp ||
    exifCanvas !== sawExif ||
    xmpCanvas !== sawXmp
  ) {
    invalid();
  }
  return metadata;
}

function avif(source: Uint8Array): ImageSourceMetadata | null {
  if (source.byteLength < 16 || ascii(source, 4, 8) !== "ftyp") return null;
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let boxCount = 0;
  function boxAt(offset: number, limit: number) {
    if (offset + 8 > limit) invalid();
    const size32 = view.getUint32(offset);
    const type = ascii(source, offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > limit) invalid();
      const extended = view.getBigUint64(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      size = Number(extended);
      headerSize = 16;
    } else if (size32 === 0) {
      size = limit - offset;
    }
    if (
      size < headerSize ||
      offset + size > limit ||
      (boxCount += 1) > 4_096
    ) {
      invalid();
    }
    return { type, headerSize, size, end: offset + size };
  }

  function unsigned(offset: number, size: number, end: number) {
    if (size < 0 || size > 8 || offset + size > end) invalid();
    let value = 0n;
    for (let index = 0; index < size; index += 1) {
      value = (value << 8n) | BigInt(source[offset + index]!);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return Number(value);
  }

  function fullBox(offset: number, box: ReturnType<typeof boxAt>) {
    const start = offset + box.headerSize;
    if (start + 4 > box.end) invalid();
    return {
      version: source[start]!,
      flags:
        (source[start + 1]! << 16) |
        (source[start + 2]! << 8) |
        source[start + 3]!,
      start: start + 4,
    };
  }

  type AvifProperty = Readonly<{
    type: string;
    metadata?: Readonly<{ width: number; height: number }>;
    av1Configuration?: Av1Configuration;
  }>;
  type Av1Configuration = Readonly<{
    profile: number;
    level: number;
    tier: number;
    highBitDepth: number;
    twelveBit: number;
    monochrome: number;
    chromaSubsamplingX: number;
    chromaSubsamplingY: number;
    chromaSamplePosition: number;
  }>;
  type AvifLocation = Readonly<{
    constructionMethod: number;
    dataReferenceIndex: number;
    baseOffset: number;
    extents: ReadonlyArray<Readonly<{ offset: number; length: number }>>;
  }>;

  let primaryItemId: number | undefined;
  const itemTypes = new Map<number, string>();
  const itemLocations = new Map<number, AvifLocation>();
  const properties: AvifProperty[] = [];
  const associations = new Map<
    number,
    Array<Readonly<{ propertyIndex: number; essential: boolean }>>
  >();
  let totalExtentCount = 0;

  function parseItemInfo(offset: number, box: ReturnType<typeof boxAt>) {
    const header = fullBox(offset, box);
    if (header.version > 1) invalid();
    let entryOffset = header.start;
    const countSize = header.version === 0 ? 2 : 4;
    const entryCount = unsigned(entryOffset, countSize, box.end);
    entryOffset += countSize;
    if (entryCount > 4_096) invalid();
    let parsedEntries = 0;
    while (entryOffset < box.end) {
      const entry = boxAt(entryOffset, box.end);
      if (entry.type !== "infe") invalid();
      const entryHeader = fullBox(entryOffset, entry);
      if (entryHeader.version !== 2 && entryHeader.version !== 3) invalid();
      const idSize = entryHeader.version === 2 ? 2 : 4;
      const itemId = unsigned(entryHeader.start, idSize, entry.end);
      const typeOffset = entryHeader.start + idSize + 2;
      const nameOffset = typeOffset + 4;
      const nameTerminator = source.indexOf(0, nameOffset);
      if (
        nameOffset >= entry.end ||
        nameTerminator < nameOffset ||
        nameTerminator >= entry.end ||
        itemTypes.has(itemId)
      ) {
        invalid();
      }
      itemTypes.set(itemId, ascii(source, typeOffset, typeOffset + 4));
      parsedEntries += 1;
      entryOffset = entry.end;
    }
    if (entryOffset !== box.end || parsedEntries !== entryCount) invalid();
  }

  function parseItemLocations(offset: number, box: ReturnType<typeof boxAt>) {
    const header = fullBox(offset, box);
    if (
      header.version > 2 ||
      header.flags !== 0 ||
      header.start + 2 > box.end
    ) {
      invalid();
    }
    const offsetSize = source[header.start]! >>> 4;
    const lengthSize = source[header.start]! & 0x0f;
    const baseOffsetSize = source[header.start + 1]! >>> 4;
    const reservedOrIndexSize = source[header.start + 1]! & 0x0f;
    const indexSize =
      header.version === 0 ? 0 : reservedOrIndexSize;
    if (
      ![0, 4, 8].includes(offsetSize) ||
      lengthSize < 1 ||
      ![0, 4, 8].includes(lengthSize) ||
      ![0, 4, 8].includes(baseOffsetSize) ||
      ![0, 4, 8].includes(indexSize) ||
      (header.version === 0 && reservedOrIndexSize !== 0)
    ) {
      invalid();
    }
    let itemOffset = header.start + 2;
    const itemIdSize = header.version < 2 ? 2 : 4;
    const itemCount = unsigned(itemOffset, itemIdSize, box.end);
    itemOffset += itemIdSize;
    if (itemCount > 4_096) invalid();
    for (let item = 0; item < itemCount; item += 1) {
      const itemId = unsigned(itemOffset, itemIdSize, box.end);
      itemOffset += itemIdSize;
      let constructionMethod = 0;
      if (header.version > 0) {
        const encodedConstructionMethod = unsigned(itemOffset, 2, box.end);
        if ((encodedConstructionMethod & 0xfff0) !== 0) invalid();
        constructionMethod = encodedConstructionMethod & 0x0f;
        itemOffset += 2;
      }
      const dataReferenceIndex = unsigned(itemOffset, 2, box.end);
      itemOffset += 2;
      const baseOffset = unsigned(itemOffset, baseOffsetSize, box.end);
      itemOffset += baseOffsetSize;
      const extentCount = unsigned(itemOffset, 2, box.end);
      itemOffset += 2;
      if (
        extentCount < 1 ||
        extentCount > 4_096 ||
        totalExtentCount > 4_096 - extentCount
      ) {
        invalid();
      }
      totalExtentCount += extentCount;
      const extents: Array<{ offset: number; length: number }> = [];
      for (let extent = 0; extent < extentCount; extent += 1) {
        if (header.version > 0 && indexSize > 0) {
          unsigned(itemOffset, indexSize, box.end);
          itemOffset += indexSize;
        }
        const extentOffset = unsigned(itemOffset, offsetSize, box.end);
        itemOffset += offsetSize;
        const length = unsigned(itemOffset, lengthSize, box.end);
        itemOffset += lengthSize;
        if (length < 1) invalid();
        extents.push({ offset: extentOffset, length });
      }
      if (itemLocations.has(itemId)) invalid();
      itemLocations.set(itemId, {
        constructionMethod,
        dataReferenceIndex,
        baseOffset,
        extents,
      });
    }
    if (itemOffset !== box.end) invalid();
  }

  function parsePropertyContainer(
    offset: number,
    box: ReturnType<typeof boxAt>,
  ) {
    let propertyOffset = offset + box.headerSize;
    while (propertyOffset < box.end) {
      const property = boxAt(propertyOffset, box.end);
      let metadata: Readonly<{ width: number; height: number }> | undefined;
      let av1Configuration: Av1Configuration | undefined;
      if (property.type === "ispe") {
        const header = fullBox(propertyOffset, property);
        if (
          header.version !== 0 ||
          header.flags !== 0 ||
          header.start + 8 !== property.end
        ) {
          invalid();
        }
        metadata = dimensions(
          view.getUint32(header.start),
          view.getUint32(header.start + 4),
        );
      } else if (property.type === "av1C") {
        const payload = propertyOffset + property.headerSize;
        if (
          payload + 4 !== property.end ||
          source[payload] !== 0x81 ||
          source[payload + 3] !== 0
        ) {
          invalid();
        }
        av1Configuration = {
          profile: source[payload + 1]! >>> 5,
          level: source[payload + 1]! & 0x1f,
          tier: source[payload + 2]! >>> 7,
          highBitDepth: (source[payload + 2]! >>> 6) & 1,
          twelveBit: (source[payload + 2]! >>> 5) & 1,
          monochrome: (source[payload + 2]! >>> 4) & 1,
          chromaSubsamplingX: (source[payload + 2]! >>> 3) & 1,
          chromaSubsamplingY: (source[payload + 2]! >>> 2) & 1,
          chromaSamplePosition: source[payload + 2]! & 3,
        };
      }
      properties.push({ type: property.type, metadata, av1Configuration });
      propertyOffset = property.end;
    }
    if (propertyOffset !== box.end || properties.length > 4_096) invalid();
  }

  function parsePropertyAssociations(
    offset: number,
    box: ReturnType<typeof boxAt>,
  ) {
    const header = fullBox(offset, box);
    if (header.version > 1 || (header.flags & ~1) !== 0) invalid();
    let entryOffset = header.start;
    const entryCount = unsigned(entryOffset, 4, box.end);
    entryOffset += 4;
    if (entryCount > 4_096) invalid();
    for (let entry = 0; entry < entryCount; entry += 1) {
      const itemIdSize = header.version === 0 ? 2 : 4;
      const itemId = unsigned(entryOffset, itemIdSize, box.end);
      entryOffset += itemIdSize;
      const associationCount = unsigned(entryOffset, 1, box.end);
      entryOffset += 1;
      if (associationCount > 127) invalid();
      const propertyAssociations: Array<{
        propertyIndex: number;
        essential: boolean;
      }> = [];
      for (
        let association = 0;
        association < associationCount;
        association += 1
      ) {
        const wide = (header.flags & 1) !== 0;
        const encoded = unsigned(entryOffset, wide ? 2 : 1, box.end);
        entryOffset += wide ? 2 : 1;
        const propertyIndex = encoded & (wide ? 0x7fff : 0x7f);
        if (propertyIndex < 1) invalid();
        propertyAssociations.push({
          propertyIndex,
          essential: (encoded & (wide ? 0x8000 : 0x80)) !== 0,
        });
      }
      if (associations.has(itemId)) invalid();
      associations.set(itemId, propertyAssociations);
    }
    if (entryOffset !== box.end) invalid();
  }

  function parseItemProperties(offset: number, box: ReturnType<typeof boxAt>) {
    let childOffset = offset + box.headerSize;
    let sawContainer = false;
    let sawAssociations = false;
    while (childOffset < box.end) {
      const child = boxAt(childOffset, box.end);
      if (child.type === "ipco") {
        if (sawContainer) invalid();
        sawContainer = true;
        parsePropertyContainer(childOffset, child);
      } else if (child.type === "ipma") {
        if (sawAssociations) invalid();
        sawAssociations = true;
        parsePropertyAssociations(childOffset, child);
      }
      childOffset = child.end;
    }
    if (childOffset !== box.end || !sawContainer || !sawAssociations) {
      invalid();
    }
  }

  function parseMeta(offset: number, box: ReturnType<typeof boxAt>) {
    const header = fullBox(offset, box);
    if (header.version !== 0 || header.flags !== 0) invalid();
    let childOffset = header.start;
    let sawHandler = false;
    let sawPrimary = false;
    let sawInfo = false;
    let sawLocations = false;
    let sawProperties = false;
    while (childOffset < box.end) {
      const child = boxAt(childOffset, box.end);
      if (child.type === "hdlr") {
        if (sawHandler) invalid();
        sawHandler = true;
        const handler = fullBox(childOffset, child);
        if (
          handler.version !== 0 ||
          handler.flags !== 0 ||
          handler.start + 20 >= child.end ||
          view.getUint32(handler.start) !== 0 ||
          ascii(source, handler.start + 4, handler.start + 8) !== "pict" ||
          source
            .subarray(handler.start + 8, handler.start + 20)
            .some((value) => value !== 0) ||
          source[child.end - 1] !== 0
        ) {
          invalid();
        }
      } else if (child.type === "pitm") {
        if (sawPrimary) invalid();
        sawPrimary = true;
        const primary = fullBox(childOffset, child);
        if (primary.version > 1 || primary.flags !== 0) invalid();
        const idSize = primary.version === 0 ? 2 : 4;
        if (primary.start + idSize !== child.end) invalid();
        primaryItemId = unsigned(primary.start, idSize, child.end);
      } else if (child.type === "iinf") {
        if (sawInfo) invalid();
        sawInfo = true;
        parseItemInfo(childOffset, child);
      } else if (child.type === "iloc") {
        if (sawLocations) invalid();
        sawLocations = true;
        parseItemLocations(childOffset, child);
      } else if (child.type === "iprp") {
        if (sawProperties) invalid();
        sawProperties = true;
        parseItemProperties(childOffset, child);
      }
      childOffset = child.end;
    }
    if (
      childOffset !== box.end ||
      !sawHandler ||
      !sawPrimary ||
      !sawInfo ||
      !sawLocations ||
      !sawProperties
    ) {
      invalid();
    }
  }

  function validateAv1SequenceHeader(sequence: Uint8Array) {
    let bitOffset = 0;
    const read = (count: number) => {
      if (count < 0 || count > 32 || bitOffset + count > sequence.byteLength * 8) {
        invalid();
      }
      let value = 0;
      for (let bit = 0; bit < count; bit += 1) {
        value =
          value * 2 +
          ((sequence[bitOffset >>> 3]! >>> (7 - (bitOffset & 7))) & 1);
        bitOffset += 1;
      }
      return value;
    };
    const profile = read(3);
    if (profile !== 0 || read(1) !== 1 || read(1) !== 1) invalid();
    const level = read(5);
    const widthBits = read(4) + 1;
    const heightBits = read(4) + 1;
    const width = read(widthBits) + 1;
    const height = read(heightBits) + 1;
    read(1);
    read(1);
    read(1);
    read(1);
    read(1);
    read(1);
    const highBitDepth = read(1);
    const monochrome = read(1);
    if (read(1) !== 0) invalid();
    read(1);
    let chromaSamplePosition = 0;
    if (monochrome === 0) {
      chromaSamplePosition = read(2);
    }
    read(1);
    read(1);
    if (read(1) !== 1) invalid();
    while (bitOffset < sequence.byteLength * 8) {
      if (read(1) !== 0) invalid();
    }
    return {
      dimensions: dimensions(width, height),
      configuration: {
        profile,
        level,
        tier: 0,
        highBitDepth,
        twelveBit: 0,
        monochrome,
        chromaSubsamplingX: 1,
        chromaSubsamplingY: 1,
        chromaSamplePosition,
      } satisfies Av1Configuration,
    };
  }

  function validateAv1Item(
    payload: Uint8Array,
    expectedDimensions: Readonly<{ width: number; height: number }>,
    expectedConfiguration: Av1Configuration,
  ) {
    let offset = 0;
    let sequenceHeaderCount = 0;
    let sawFrame = false;
    let sawFrameHeader = false;
    let sawTileGroup = false;
    let sequenceMetadata:
      | ReturnType<typeof validateAv1SequenceHeader>
      | undefined;
    while (offset < payload.byteLength) {
      const header = payload[offset++]!;
      const type = (header >>> 3) & 0x0f;
      if ((header & 0x81) !== 0 || type === 0 || (header & 0x02) === 0) {
        invalid();
      }
      if ((header & 0x04) !== 0) {
        if (offset >= payload.byteLength || (payload[offset++]! & 0x07) !== 0) {
          invalid();
        }
      }
      let size = 0;
      let shift = 0;
      let terminated = false;
      for (let byte = 0; byte < 8 && offset < payload.byteLength; byte += 1) {
        const value = payload[offset++]!;
        size += (value & 0x7f) * 2 ** shift;
        shift += 7;
        if ((value & 0x80) === 0) {
          terminated = true;
          break;
        }
      }
      if (
        !terminated ||
        !Number.isSafeInteger(size) ||
        (size < 1 && type !== 2 && type !== 15) ||
        offset + size > payload.byteLength
      ) {
        invalid();
      }
      if (type === 1) {
        sequenceHeaderCount += 1;
        sequenceMetadata = validateAv1SequenceHeader(
          payload.subarray(offset, offset + size),
        );
      }
      if (type === 6) sawFrame = true;
      if (type === 3 || type === 7) sawFrameHeader = true;
      if (type === 4) sawTileGroup = true;
      offset += size;
    }
    if (
      offset !== payload.byteLength ||
      sequenceHeaderCount !== 1 ||
      !(sawFrame || (sawFrameHeader && sawTileGroup))
    ) {
      invalid();
    }
    if (
      sequenceMetadata === undefined ||
      sequenceMetadata.dimensions.width !== expectedDimensions.width ||
      sequenceMetadata.dimensions.height !== expectedDimensions.height ||
      Object.entries(sequenceMetadata.configuration).some(
        ([key, value]) =>
          expectedConfiguration[key as keyof Av1Configuration] !== value,
      )
    ) {
      invalid();
    }
  }

  let offset = 0;
  let validBrand = false;
  let sawMeta = false;
  const mediaData: Array<Readonly<{ start: number; end: number }>> = [];
  while (offset + 8 <= source.byteLength) {
    const box = boxAt(offset, source.byteLength);
    if (box.type === "ftyp") {
      const payloadSize = box.size - box.headerSize;
      if (
        box.size > 1_024 ||
        payloadSize < 8 ||
        payloadSize % 4 !== 0
      ) {
        invalid();
      }
      const majorBrand = ascii(
        source,
        offset + box.headerSize,
        offset + box.headerSize + 4,
      );
      if (majorBrand === "avif") validBrand = true;
      for (
        let brandOffset = offset + box.headerSize + 8;
        brandOffset + 4 <= box.end;
        brandOffset += 4
      ) {
        const brand = ascii(source, brandOffset, brandOffset + 4);
        if (brand === "avif") validBrand = true;
      }
    }
    if (box.type === "meta") {
      if (sawMeta) invalid();
      sawMeta = true;
      parseMeta(offset, box);
    }
    if (box.type === "mdat") {
      const start = offset + box.headerSize;
      if (start >= box.end) invalid();
      mediaData.push({ start, end: box.end });
    }
    offset = box.end;
  }
  if (
    offset !== source.byteLength ||
    !validBrand ||
    !sawMeta ||
    mediaData.length < 1 ||
    primaryItemId === undefined ||
    itemTypes.get(primaryItemId) !== "av01"
  ) {
    invalid();
  }
  const primaryId = primaryItemId ?? invalid();
  const location = itemLocations.get(primaryId) ?? invalid();
  if (location.constructionMethod !== 0 || location.dataReferenceIndex !== 0) {
    invalid();
  }
  const associatedProperties = (associations.get(primaryId) ?? invalid()).map(
    (association) => {
      const property =
        properties[association.propertyIndex - 1] ?? invalid();
      if (
        association.essential &&
        property.type !== "ispe" &&
        property.type !== "av1C"
      ) {
        invalid();
      }
      return { property, essential: association.essential };
    },
  );
  const av1ConfigurationProperties = associatedProperties.filter(
    ({ property }) => property.type === "av1C",
  );
  if (
    associatedProperties.some(
      ({ property }) => property.type === "irot" || property.type === "imir",
    ) ||
    av1ConfigurationProperties.length !== 1 ||
    !av1ConfigurationProperties[0]!.essential
  ) {
    invalid();
  }
  const dimensionProperties = associatedProperties
    .map(({ property }) => property.metadata)
    .filter(
      (metadata): metadata is Readonly<{ width: number; height: number }> =>
        metadata !== undefined,
    );
  if (dimensionProperties.length !== 1) invalid();
  const av1Configuration =
    av1ConfigurationProperties[0]!.property.av1Configuration ?? invalid();
  let payloadLength = 0;
  const resolvedExtents = location.extents.map((extent) => {
    const start = location.baseOffset + extent.offset;
    const end = start + extent.length;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !mediaData.some((range) => start >= range.start && end <= range.end)
    ) {
      invalid();
    }
    if (payloadLength > source.byteLength - extent.length) invalid();
    payloadLength += extent.length;
    return { start, end };
  });
  const payload = new Uint8Array(payloadLength);
  let payloadOffset = 0;
  for (const extent of resolvedExtents) {
    const chunk = source.subarray(extent.start, extent.end);
    payload.set(chunk, payloadOffset);
    payloadOffset += chunk.byteLength;
  }
  validateAv1Item(payload, dimensionProperties[0]!, av1Configuration);
  const avifMetadata = dimensionProperties[0]!;
  return {
    contentType: "image/avif",
    width: avifMetadata.width,
    height: avifMetadata.height,
  };
}

export async function inspectImageSource(
  source: Uint8Array,
): Promise<ImageSourceMetadata> {
  if (source.byteLength < 12) invalid();
  const pngMetadata = await png(source);
  return pngMetadata ?? jpeg(source) ?? webp(source) ?? invalid();
}

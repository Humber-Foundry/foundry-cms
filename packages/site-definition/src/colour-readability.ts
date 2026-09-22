/**
 * How readable one colour is on another, and how two colours mix.
 *
 * The design contract promises the owner that every look it offers is legible:
 * ADR-0009 sets the ratios, and ADR-0040 extends them to the card surface and
 * the light band a page component paints with. The checks that hold that
 * promise live in two packages, so the arithmetic behind them lives here rather
 * than being written out twice.
 */

/** One channel's share of luminance, from WCAG 2.2. */
function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function channels(hex: string): ReadonlyArray<number> {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (match === null) {
    throw new TypeError(`not_a_six_digit_hex_colour:${hex}`);
  }
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = channels(hex);
  return (
    0.2126 * channelLuminance(red!) +
    0.7152 * channelLuminance(green!) +
    0.0722 * channelLuminance(blue!)
  );
}

/** The WCAG 2.2 contrast ratio between two six-digit hex colours. */
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * `color-mix(in srgb, <first> <weight>%, <second>)`, worked out the same way a
 * browser works it out. `weight` runs from 0 to 1.
 *
 * A mixed colour exists nowhere to read: the stylesheet writes the expression
 * and only the browser paints the result. A check on the text placed over one
 * has to mix it first.
 */
export function mixInSrgb(
  first: string,
  weight: number,
  second: string,
): string {
  const [firstChannels, secondChannels] = [channels(first), channels(second)];
  return `#${firstChannels
    .map((channel, index) =>
      Math.round(channel * weight + secondChannels[index]! * (1 - weight))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

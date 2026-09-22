import { describe, expect, it } from "vitest";

import {
  applySiteDefinitionEdits,
  defaultSiteDesign,
  designContract,
  designEditsForDesign,
  designPresets,
  matchDesignPreset,
  referenceSiteDefinition,
  type DesignPreset,
  type SiteDesign,
} from "./index";

/**
 * Relative luminance and contrast ratio from WCAG 2.2. The Design module offers
 * colours the owner cannot inspect for readability, so the contract itself has
 * to guarantee every offered pair is legible.
 */
function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (match === null) {
    throw new TypeError(`not_a_six_digit_hex_colour:${hex}`);
  }
  const value = Number.parseInt(match[1]!, 16);
  return (
    0.2126 * channelLuminance((value >> 16) & 0xff) +
    0.7152 * channelLuminance((value >> 8) & 0xff) +
    0.0722 * channelLuminance(value & 0xff)
  );
}

/**
 * `color-mix(in srgb, <first> <weight>%, <second>)`, worked out the same way a
 * browser works it out. `--design-band` is mixed from the accent and the paper,
 * so the band's colour exists nowhere to read: it has to be mixed here before
 * the text on it can be checked.
 */
function mixInSrgb(first: string, weight: number, second: string): string {
  const channels = (hex: string): number[] => {
    const match = /^#([0-9a-f]{6})$/iu.exec(hex);
    if (match === null) throw new TypeError(`not_a_six_digit_hex_colour:${hex}`);
    const value = Number.parseInt(match[1]!, 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  };
  const [firstChannels, secondChannels] = [channels(first), channels(second)];
  const mixed = firstChannels.map((channel, index) =>
    Math.round(channel * weight + secondChannels[index]! * (1 - weight)),
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** The weight `globals.css` mixes `--design-band` with. */
const bandAccentWeight = 0.2;

export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const accentOptions = designContract.tokens["colour.accent"].options;
const neutralOptions = designContract.tokens["colour.neutral"].options;

describe("design token contract", () => {
  it("gives every token a plain label, help text and a registered default", () => {
    for (const [key, token] of Object.entries(designContract.tokens)) {
      expect(token.label, key).toMatch(/^[A-Z]/u);
      expect(token.help.length, key).toBeGreaterThan(10);
      expect(token.values, key).toContain(token.default);
      expect(token.options.map((option) => option.value), key).toEqual(
        token.values,
      );
    }
  });

  it("gives every option a distinct plain label and a written description", () => {
    for (const [key, token] of Object.entries(designContract.tokens)) {
      const labels = token.options.map((option) => option.label);
      expect(new Set(labels).size, key).toBe(labels.length);
      for (const option of token.options) {
        expect(option.label, `${key}:${option.value}`).toMatch(/^[A-Z]/u);
        expect(option.description, `${key}:${option.value}`).toMatch(
          /^[A-Z].*\.$/su,
        );
        expect(
          option.description.length,
          `${key}:${option.value}`,
        ).toBeGreaterThan(20);
      }
    }
  });

  it("gives every component variant a plain label and description", () => {
    for (const [key, variant] of Object.entries(designContract.variants)) {
      expect(variant.options.map((option) => option.value), key).toEqual(
        variant.values,
      );
      for (const option of variant.options) {
        expect(option.label, `${key}:${option.value}`).toMatch(/^[A-Z]/u);
        expect(option.description, `${key}:${option.value}`).toMatch(
          /^[A-Z].*\.$/su,
        );
        expect(
          option.description.length,
          `${key}:${option.value}`,
        ).toBeGreaterThan(20);
      }
    }
  });

  it("offers only accent colours that carry their own ink at WCAG AA", () => {
    // ADR-0040 made each accent option name the ink that reads on it, rather
    // than leaving white written here by hand. This check reads that ink, so
    // an accent registered with an ink it cannot carry fails.
    for (const option of accentOptions) {
      const preview = option.preview;
      expect(preview.kind, option.value).toBe("accent");
      if (preview.kind !== "accent") continue;
      expect(
        contrastRatio(preview.colour, preview.inkColour),
        `accent ${option.value}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(preview.deepColour, preview.inkColour),
        `accent hover ${option.value}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("offers only page tones whose body text reaches WCAG AAA", () => {
    for (const option of neutralOptions) {
      const preview = option.preview;
      expect(preview.kind, option.value).toBe("neutral");
      if (preview.kind !== "neutral") continue;
      expect(
        contrastRatio(preview.ink, preview.paper),
        `ink on paper ${option.value}`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(preview.softInk, preview.paper),
        `soft ink on paper ${option.value}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("offers only page tones whose card surface carries the same text", () => {
    // ADR-0040 lets a page component paint a card, a photo mount or an input
    // field with `--design-card`, and put ordinary page text on it. The card
    // therefore owes the same reading guarantee the paper gives.
    for (const option of neutralOptions) {
      const preview = option.preview;
      if (preview.kind !== "neutral") continue;
      expect(
        contrastRatio(preview.ink, preview.card),
        `ink on card ${option.value}`,
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrastRatio(preview.softInk, preview.card),
        `soft ink on card ${option.value}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps page text readable on the light band every accent mixes", () => {
    // ADR-0040 mixes `--design-band` from the accent and the paper, and page
    // components put ordinary page text on it. Every accent and page tone the
    // owner can pair therefore owes the same reading guarantee.
    for (const accent of accentOptions) {
      for (const neutral of neutralOptions) {
        if (accent.preview.kind !== "accent") continue;
        if (neutral.preview.kind !== "neutral") continue;
        const band = mixInSrgb(
          accent.preview.colour,
          bandAccentWeight,
          neutral.preview.paper,
        );
        expect(
          contrastRatio(neutral.preview.ink, band),
          `ink on ${accent.value} band over ${neutral.value}`,
        ).toBeGreaterThanOrEqual(7);
        expect(
          contrastRatio(neutral.preview.softInk, band),
          `soft ink on ${accent.value} band over ${neutral.value}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps every accent readable on every page tone", () => {
    for (const accent of accentOptions) {
      for (const neutral of neutralOptions) {
        if (accent.preview.kind !== "accent") continue;
        if (neutral.preview.kind !== "neutral") continue;
        expect(
          contrastRatio(accent.preview.colour, neutral.preview.paper),
          `${accent.value} on ${neutral.value}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("preset looks", () => {
  it("offers presets that fill complete rows of three", () => {
    expect(designPresets.length % 3).toBe(0);
    expect(designPresets.length).toBeGreaterThanOrEqual(6);
  });

  it("names every preset and describes it in one plain sentence", () => {
    for (const preset of designPresets) {
      expect(preset.id).toMatch(/^[a-z][a-z0-9-]*$/u);
      expect(preset.name).toMatch(/^[A-Z]/u);
      expect(preset.description.length).toBeGreaterThan(15);
    }
  });

  it("gives each preset a distinct, fully registered set of token values", () => {
    const seen = new Set<string>();
    for (const preset of designPresets) {
      const serialized = JSON.stringify(preset.design);
      expect(seen.has(serialized), preset.id).toBe(false);
      seen.add(serialized);
      for (const [key, token] of Object.entries(designContract.tokens)) {
        const [group, name] = key.split(".") as [
          keyof SiteDesign,
          string,
        ];
        const value = (preset.design[group] as Record<string, string>)[name];
        expect(token.values, `${preset.id}.${key}`).toContain(value);
      }
    }
  });

  it("matches the shipped default design to a preset the owner can see", () => {
    const matched = matchDesignPreset(defaultSiteDesign);
    expect(matched?.id).toBe("editorial");
  });

  it("reports no preset once one value is fine-tuned away from it", () => {
    const preset = designPresets[0]!;
    const fineTuned: SiteDesign = {
      ...preset.design,
      layout: { contentWidth: "wide" },
    };

    expect(matchDesignPreset(preset.design)).toEqual(preset);
    expect(
      matchDesignPreset(fineTuned) === undefined ||
        matchDesignPreset(fineTuned)!.id !== preset.id,
    ).toBe(true);
  });

  it("turns a preset into the exact field edits the draft needs", () => {
    const preset = designPresets.find(
      (candidate: DesignPreset) => candidate.id !== "editorial",
    )!;
    const edits = designEditsForDesign(
      referenceSiteDefinition.design,
      preset.design,
    );

    expect(edits.length).toBeGreaterThan(0);
    for (const edit of edits) {
      expect(edit.path).toMatch(/^design\./u);
    }
    const applied = applySiteDefinitionEdits(referenceSiteDefinition, edits);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.definition.design).toEqual(preset.design);
    expect(matchDesignPreset(applied.definition.design)).toEqual(preset);
  });

  it("asks for no edit when the draft already uses that design", () => {
    expect(
      designEditsForDesign(
        referenceSiteDefinition.design,
        referenceSiteDefinition.design,
      ),
    ).toEqual([]);
  });
});

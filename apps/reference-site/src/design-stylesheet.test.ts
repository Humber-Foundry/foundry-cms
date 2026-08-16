import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  designContract,
  designTokenAttributeName,
  designTokenKeys,
} from "@humber-foundry/site-definition";

/**
 * The design contract names the colours, fonts and sizes the Design module
 * shows the owner. The stylesheet is what the visitor actually sees. If the two
 * disagree, the Design module lies about what an option does, so this test
 * reads the real stylesheet and compares it with the real contract.
 */
const stylesheet = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

/** The declarations inside `.site-canvas[<attribute>="<value>"] { … }`. */
function tokenRule(attribute: string, value: string): string {
  const selector = `.site-canvas[${attribute}="${value}"]`;
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`no_stylesheet_rule_for:${selector}`);
  }
  const open = stylesheet.indexOf("{", start);
  const close = stylesheet.indexOf("}", open);
  return stylesheet.slice(open + 1, close);
}

function customProperty(rule: string, property: string): string {
  const match = new RegExp(`${property}:\\s*([^;]+);`, "u").exec(rule);
  if (match === null) {
    throw new Error(`no_declaration_for:${property}`);
  }
  return match[1]!.trim().replaceAll(/\s+/gu, " ");
}

/** The largest length in a declaration, used to order the size options. */
function largestRem(declaration: string): number {
  const lengths = [...declaration.matchAll(/([\d.]+)rem/gu)].map((match) =>
    Number.parseFloat(match[1]!),
  );
  if (lengths.length === 0) {
    throw new Error(`no_rem_length_in:${declaration}`);
  }
  return Math.max(...lengths);
}

describe("design stylesheet matches the design contract", () => {
  it("has one rule for every registered option of every token", () => {
    for (const key of designTokenKeys) {
      const attribute = designTokenAttributeName(key);
      for (const option of designContract.tokens[key].options) {
        expect(() => tokenRule(attribute, option.value)).not.toThrow();
      }
    }
  });

  it("uses the exact font stack each font option advertises", () => {
    for (const [key, property] of [
      ["typography.heading", "--design-heading-font"],
      ["typography.body", "--design-body-font"],
    ] as const) {
      const attribute = designTokenAttributeName(key);
      for (const option of designContract.tokens[key].options) {
        if (option.preview.kind !== "font") continue;
        expect(
          customProperty(tokenRule(attribute, option.value), property),
          `${key}:${option.value}`,
        ).toBe(option.preview.fontFamily);
      }
    }
  });

  it("uses the exact accent colours each accent option advertises", () => {
    const attribute = designTokenAttributeName("colour.accent");
    for (const option of designContract.tokens["colour.accent"].options) {
      if (option.preview.kind !== "accent") continue;
      const rule = tokenRule(attribute, option.value);
      expect(customProperty(rule, "--design-accent"), option.value).toBe(
        option.preview.colour,
      );
      expect(customProperty(rule, "--design-accent-deep"), option.value).toBe(
        option.preview.deepColour,
      );
    }
  });

  it("uses the exact page tones each page-tone option advertises", () => {
    const attribute = designTokenAttributeName("colour.neutral");
    for (const option of designContract.tokens["colour.neutral"].options) {
      if (option.preview.kind !== "neutral") continue;
      const rule = tokenRule(attribute, option.value);
      for (const [property, expected] of [
        ["--paper", option.preview.paper],
        ["--panel", option.preview.panel],
        ["--ink", option.preview.ink],
        ["--ink-soft", option.preview.softInk],
        ["--line", option.preview.line],
      ] as const) {
        expect(
          customProperty(rule, property),
          `${option.value}${property}`,
        ).toBe(expected);
      }
    }
  });

  it("paints the page root with the same paper each page tone advertises", () => {
    for (const option of designContract.tokens["colour.neutral"].options) {
      if (option.preview.kind !== "neutral") continue;
      // The area beyond the document is painted from the root, so the root
      // rule has to name the same colour as the canvas rule.
      const selector =
        "html:not(:has(.dashboard)):has(.site-canvas" +
        `[data-colour-neutral="${option.value}"])`;
      const start = stylesheet.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      const open = stylesheet.indexOf("{", start);
      const rule = stylesheet.slice(open + 1, stylesheet.indexOf("}", open));

      expect(customProperty(rule, "background"), option.value).toBe(
        option.preview.paper,
      );
    }
  });

  it("orders the size options exactly as their previews claim", () => {
    for (const [key, property] of [
      ["spacing.section", "--design-section-padding"],
      ["layout.contentWidth", "--design-content-width"],
    ] as const) {
      const attribute = designTokenAttributeName(key);
      const measured = designContract.tokens[key].options.map((option) => ({
        value: option.value,
        ratio: option.preview.kind === "scale" ? option.preview.ratio : 0,
        rem: largestRem(
          customProperty(tokenRule(attribute, option.value), property),
        ),
      }));
      const byRatio = [...measured].sort((a, b) => a.ratio - b.ratio);
      const byLength = [...measured].sort((a, b) => a.rem - b.rem);

      expect(byLength.map(({ value }) => value), key).toEqual(
        byRatio.map(({ value }) => value),
      );
    }
  });
});

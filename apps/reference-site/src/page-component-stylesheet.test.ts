import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The page component stylesheet may not hold a colour or a font family of its
 * own.
 *
 * `public.css` is the stylesheet every page component draws itself with, and
 * an installation copies it alongside `foundry/page-components.tsx`. A hard
 * colour written here cannot follow the design the owner chose, so the Design
 * preview would show a change that never reaches the page. This test reads the
 * real stylesheet and fails on any colour or font family that is not a design
 * token custom property. See ADR-0040.
 */
const stylesheet = readFileSync(
  fileURLToPath(new URL("../app/public.css", import.meta.url)),
  "utf8",
);

/** The properties whose value paints a colour or picks a font. */
const paintingProperties = new Set([
  "accent-color",
  "background",
  "background-color",
  "background-image",
  "border",
  "border-block",
  "border-block-end",
  "border-block-start",
  "border-bottom",
  "border-color",
  "border-inline",
  "border-inline-end",
  "border-inline-start",
  "border-left",
  "border-right",
  "border-top",
  "box-shadow",
  "caret-color",
  "color",
  "column-rule",
  "fill",
  "font",
  "font-family",
  "outline",
  "outline-color",
  "stroke",
  "text-decoration-color",
  "text-emphasis-color",
  "text-shadow",
]);

/** The CSS-wide keywords, which name no colour and no font of their own. */
const cssWideKeywords = new Set([
  "currentcolor",
  "inherit",
  "initial",
  "none",
  "revert",
  "transparent",
  "unset",
]);

/**
 * Colour words a browser understands. Writing one is the same fault as writing
 * a hex value, so the list holds the ones a stylesheet reaches for.
 */
const colourWords = [
  "aqua", "beige", "black", "blue", "brown", "coral", "crimson", "cyan",
  "fuchsia", "gold", "gray", "green", "grey", "indigo", "ivory", "khaki",
  "lavender", "lime", "magenta", "maroon", "navy", "olive", "orange", "orchid",
  "pink", "plum", "purple", "red", "salmon", "silver", "tan", "teal",
  "tomato", "turquoise", "violet", "wheat", "white", "yellow",
];

type Declaration = Readonly<{ property: string; value: string; line: number }>;

/**
 * Every declaration in the stylesheet, with the line it is on. Comments are
 * removed first so a colour named in a comment is not read as a declaration.
 */
function declarations(css: string): ReadonlyArray<Declaration> {
  const withoutComments = css.replaceAll(
    /\/\*[\s\S]*?\*\//gu,
    (comment) => comment.replaceAll(/[^\n]/gu, " "),
  );
  const found: Declaration[] = [];
  for (const match of withoutComments.matchAll(
    /([a-z-]+)\s*:\s*([^;{}]+);/gu,
  )) {
    found.push({
      property: match[1]!,
      value: match[2]!.trim().replaceAll(/\s+/gu, " "),
      line: withoutComments.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

const painting = declarations(stylesheet).filter(({ property }) =>
  paintingProperties.has(property),
);

function place(declaration: Declaration): string {
  return `public.css:${declaration.line} ${declaration.property}: ${declaration.value}`;
}

describe("the page component stylesheet paints only from design tokens", () => {
  it("reads enough painting declarations to be a real check", () => {
    expect(painting.length).toBeGreaterThan(20);
  });

  it("writes no literal colour", () => {
    const offenders = painting
      .filter(({ value }) =>
        /#[0-9a-f]{3,8}\b/iu.test(value) ||
        /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/iu.test(value) ||
        new RegExp(`\\b(?:${colourWords.join("|")})\\b`, "iu").test(value),
      )
      .map(place);

    expect(offenders).toEqual([]);
  });

  it("names only design token custom properties", () => {
    const offenders = painting
      .filter(({ value }) =>
        [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/giu)].some(
          (match) => !match[1]!.startsWith("--design-"),
        ),
      )
      .map(place);

    expect(offenders).toEqual([]);
  });

  it("writes no literal font family", () => {
    const offenders = declarations(stylesheet)
      .filter(
        ({ property, value }) =>
          (property === "font-family" || property === "font") &&
          !cssWideKeywords.has(value.toLowerCase()) &&
          !/^var\(--design-[a-z-]+\)$/u.test(value),
      )
      .map(place);

    expect(offenders).toEqual([]);
  });
});

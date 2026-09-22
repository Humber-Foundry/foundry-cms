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

const globalStylesheet = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

/**
 * The rules a page component paints with that live in `globals.css` rather
 * than in `public.css`. The hero renders `button button-primary` and three
 * components render `eyebrow`, so these are page component rules wherever
 * their text sits.
 */
const sharedControlSelectors = [
  ".eyebrow",
  ".button",
  ".button-primary",
  ".button-primary:hover",
];

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
  "border-block-color",
  "border-bottom",
  "border-bottom-color",
  "border-color",
  "border-inline",
  "border-inline-end",
  "border-inline-color",
  "border-inline-start",
  "border-left",
  "border-left-color",
  "border-right",
  "border-right-color",
  "border-top",
  "border-top-color",
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
  // The terminator is a semicolon or the rule's closing brace: the last
  // declaration in a rule may leave the semicolon out, and a rule that did
  // would otherwise slip past every check below.
  for (const match of withoutComments.matchAll(
    /(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;{}]+)[;}]/gu,
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

/**
 * A value that names a colour of its own rather than reading one. Custom
 * property names are taken out first: `var(--white)` reads a property whose
 * name happens to hold a colour word, and which property it may read is the
 * next test's question, not this one's.
 */
function holdsALiteralColour(value: string): boolean {
  const withoutNames = value.replaceAll(/--[a-z0-9-]+/giu, "");
  return (
    /#[0-9a-f]{3,8}\b/iu.test(withoutNames) ||
    /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/iu.test(withoutNames) ||
    new RegExp(`\\b(?:${colourWords.join("|")})\\b`, "iu").test(withoutNames)
  );
}

describe("the page component stylesheet paints only from design tokens", () => {
  it("reads enough painting declarations to be a real check", () => {
    expect(painting.length).toBeGreaterThan(20);
  });

  it("writes no literal colour", () => {
    const offenders = painting
      .filter(({ value }) => holdsALiteralColour(value))
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

  it("smuggles no literal colour into a custom property of its own", () => {
    // A rule could dodge every check above by defining its own custom property
    // and reading it back. A custom property declared here is not a design
    // token, so it may hold no colour either.
    const offenders = declarations(stylesheet)
      .filter(
        ({ property, value }) =>
          property.startsWith("--") && holdsALiteralColour(value),
      )
      .map(place);

    expect(offenders).toEqual([]);
  });

  it("paints the shared controls a page component renders from tokens too", () => {
    // `.eyebrow` and `.button-primary` also render outside a site canvas, on
    // the dashboard and the page-not-found screen, where no design token is
    // set. Each one therefore reads a token with a fallback, and the fallback
    // is the value that class had before any design existed.
    const offenders: string[] = [];
    for (const selector of sharedControlSelectors) {
      const start = globalStylesheet.indexOf(`${selector} {`);
      expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
      const open = globalStylesheet.indexOf("{", start);
      const rule = globalStylesheet.slice(
        open + 1,
        globalStylesheet.indexOf("}", open),
      );
      for (const declaration of declarations(`${rule}}`)) {
        if (!paintingProperties.has(declaration.property)) continue;
        const names = [
          ...declaration.value.matchAll(/var\(\s*(--[a-z0-9-]+)/giu),
        ].map((match) => match[1]!);
        // The first name is the one the browser reads; anything after it is
        // the fallback for the same class outside a site canvas.
        const readsAToken = names.length === 0 || names[0]!.startsWith("--design-");
        if (readsAToken && !holdsALiteralColour(declaration.value)) continue;
        offenders.push(
          `globals.css ${selector} ${declaration.property}: ${declaration.value}`,
        );
      }
    }

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

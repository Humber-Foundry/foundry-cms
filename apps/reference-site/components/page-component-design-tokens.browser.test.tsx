import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  designFontStack,
  designPresets,
  homePage,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

import { installedPageComponentRegistry } from "@/foundry/page-components";

import { SiteRenderer } from "./site-renderer";

// The real stylesheets, because this test is about what the visitor sees.
import "../app/globals.css";
import "../app/public.css";

/**
 * A page component must draw itself from the design tokens.
 *
 * The Design screen promises the owner that every change shows in the preview
 * straight away. That promise is only true if each page component reads its
 * colours, fonts, spacing and width from the `--design-*` custom properties the
 * draft sets on `.site-canvas`. A component that writes its own colour looks
 * the same whatever the owner chooses, and the preview then lies.
 *
 * This test renders every registered page component under two preset looks that
 * differ in every token, and fails when a component paints the same either way.
 * See ADR-0040.
 */

const presetOf = (id: string) => designPresets.find((preset) => preset.id === id)!;

/** Two looks that differ in every single token. */
const firstLook = presetOf("editorial");
const secondLook = presetOf("technical");

/** A site whose home page holds one section, built from a component's defaults. */
function siteWithComponent(
  component: string,
  design: SiteDefinition["design"],
): Readonly<{ definition: SiteDefinition; page: SitePage }> {
  const base = { ...referenceSiteDefinition, design };
  const home = homePage(base);
  const section = installedPageComponentRegistry.createDefault(
    component,
    "section_under_test",
    { definition: base, page: home },
  );
  const page = { ...home, sections: [section] };
  const definition = {
    ...base,
    pages: base.pages.map((candidate) =>
      candidate.id === home.id ? page : candidate,
    ),
  };
  return { definition, page };
}

/**
 * The properties a page component's own rules paint with. `background-image` is
 * left out: a gradient resolves to a string of mixed colours that no palette
 * can be compared against, and `page-component-stylesheet.test.ts` already
 * reads the gradient's source text.
 */
const paintedProperties = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "box-shadow",
  "font-family",
] as const;

/** A value a browser paints nothing with. */
const paintsNothing = new Set(["rgba(0, 0, 0, 0)", "none", ""]);

function paintedValue(element: Element, property: string): string {
  const computed = getComputedStyle(element);
  if (property.startsWith("border-")) {
    const side = property.slice("border-".length, -"-color".length);
    if (computed.getPropertyValue(`border-${side}-style`) === "none") return "";
  }
  return computed.getPropertyValue(property);
}

/**
 * The values a component's own rules set, as against the ones it inherits from
 * the canvas. A value that matches the parent's was not painted by this
 * component, so it says nothing about whether the component reads the tokens.
 */
function ownPaint(element: Element): ReadonlyArray<[string, string]> {
  const parent = element.parentElement;
  if (parent === null) return [];
  return paintedProperties
    .map((property): [string, string] => [
      property,
      paintedValue(element, property),
    ])
    .filter(
      ([property, value]) =>
        !paintsNothing.has(value) && value !== paintedValue(parent, property),
    );
}

type OwnPaint = Readonly<{ element: string; property: string; value: string }>;

/** Everything a rendered component paints for itself, element by element. */
function ownPaintOfTree(host: HTMLElement): ReadonlyArray<OwnPaint> {
  const main = host.querySelector(".site-canvas #main-content")!;
  return [main, ...main.querySelectorAll("*")].flatMap((element, index) =>
    ownPaint(element).map(([property, value]) => ({
      element: `${index}:${element.tagName.toLowerCase()}.${element.className}`,
      property,
      value,
    })),
  );
}

/**
 * The painted value of one design token under the look now on the canvas. A
 * probe is the only honest way to read one: `--design-shadow` and
 * `--design-band` are `color-mix` expressions, so only the browser can say what
 * colour they come out as.
 */
function paintedToken(host: HTMLElement, token: string, font: boolean): string {
  const canvas = host.querySelector(".site-canvas")!;
  const probe = document.createElement("span");
  probe.style.setProperty(font ? "font-family" : "color", `var(${token})`);
  canvas.append(probe);
  const value = font
    ? getComputedStyle(probe).fontFamily
    : getComputedStyle(probe).color;
  probe.remove();
  return value;
}

/**
 * The two design properties that hold still when the look changes: the
 * fixed-width font for a small technical detail, and the ink that reads on
 * every one of the six accents. A value a component paints for itself is
 * allowed to stay the same between two looks only if it is one of these.
 */
function lookInvariantValues(host: HTMLElement): ReadonlySet<string> {
  return new Set([
    paintedToken(host, "--design-mono-font", true),
    paintedToken(host, "--design-accent-ink", false),
  ]);
}

describe("every page component draws itself from the design tokens", () => {
  const mounted: Root[] = [];

  function render(component: string, design: SiteDefinition["design"]) {
    const { definition, page } = siteWithComponent(component, design);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(SiteRenderer, { definition, page, editingSurface: true }),
      );
    });
    return host;
  }

  afterEach(() => {
    for (const root of mounted.splice(0)) flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  it("registers the components this test covers", () => {
    expect(
      installedPageComponentRegistry.allowedComponents.length,
    ).toBeGreaterThan(4);
  });

  for (const component of installedPageComponentRegistry.allowedComponents) {
    it(`paints ${component} for itself only from the design tokens`, () => {
      const firstHost = render(component, firstLook.design);
      const secondHost = render(component, secondLook.design);
      const first = ownPaintOfTree(firstHost);
      const second = ownPaintOfTree(secondHost);
      const invariant = lookInvariantValues(firstHost);

      expect(first.length, `${component} paints nothing of its own`).toBeGreaterThan(0);
      expect(second.length, component).toBe(first.length);

      // Every value the component paints for itself must follow the look, or
      // be one of the two design properties that never change. A value that
      // holds still for any other reason is a colour or a font the component
      // wrote by hand.
      const stuck = first
        .map((painted, index) => ({ painted, other: second[index]! }))
        .filter(
          ({ painted, other }) =>
            painted.value === other.value && !invariant.has(painted.value),
        )
        .map(
          ({ painted }) =>
            `${painted.element} ${painted.property}: ${painted.value}`,
        );

      expect(stuck, component).toEqual([]);
    });

    it(`sets every heading in ${component} in the chosen heading font`, () => {
      for (const look of [firstLook, secondLook]) {
        const host = render(component, look.design);
        const headings = [
          ...host.querySelectorAll<HTMLElement>(
            "#main-content h1, #main-content h2, #main-content h3",
          ),
        ];
        const expected = designFontStack(
          "typography.heading",
          look.design.typography.heading,
        );
        for (const heading of headings) {
          expect(
            getComputedStyle(heading).fontFamily,
            `${component} ${heading.tagName} under ${look.name}`,
          ).toBe(expected);
        }
      }
    });
  }
});

describe("the published home page keeps its own look", () => {
  const mounted: Root[] = [];

  afterEach(() => {
    for (const root of mounted.splice(0)) flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  /**
   * The reference site's published design is warm paper with the moss accent
   * and serif headings. These are the exact colours it painted before page
   * components were moved onto tokens, so an unintended change to the public
   * site fails here.
   */
  it("holds only the four foundation sections, which the pin below covers", () => {
    // If a bespoke section ever joined the published home page, the colours
    // pinned below would stop covering the whole page without anyone noticing.
    expect(
      homePage(referenceSiteDefinition).sections.map((section) => section.type),
    ).toEqual(["hero", "services", "proof", "callToAction"]);
  });

  it("paints the published colours the page tone and accent name", () => {
    const definition = referenceSiteDefinition;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    flushSync(() => {
      root.render(
        createElement(SiteRenderer, {
          definition,
          page: homePage(definition),
        }),
      );
    });

    const canvas = host.querySelector<HTMLElement>(".site-canvas")!;
    expect(getComputedStyle(canvas).backgroundColor).toBe("rgb(245, 243, 237)");
    expect(getComputedStyle(canvas).color).toBe("rgb(23, 32, 29)");

    const contact = host.querySelector<HTMLElement>(".contact")!;
    expect(getComputedStyle(contact).backgroundColor).toBe("rgb(21, 70, 51)");
    expect(getComputedStyle(contact).color).toBe("rgb(255, 255, 255)");

    const proof = host.querySelector<HTMLElement>(".proof")!;
    expect(getComputedStyle(proof).backgroundColor).toBe("rgb(233, 225, 207)");

    const heading = host.querySelector<HTMLElement>(".hero h1")!;
    expect(getComputedStyle(heading).fontFamily).toBe(
      'Charter, "Source Serif 4", Georgia, serif',
    );

    const number = host.querySelector<HTMLElement>(".service-number")!;
    expect(getComputedStyle(number).color).toBe("rgb(30, 92, 67)");
    expect(getComputedStyle(number).fontFamily).toBe(
      '"IBM Plex Mono", "Source Code Pro", monospace',
    );
  });
});

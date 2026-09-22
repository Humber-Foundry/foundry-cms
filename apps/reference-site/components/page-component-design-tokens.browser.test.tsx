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

/** The painted result of one element: what a visitor's eye actually reads. */
function paintOf(element: Element): string {
  const computed = getComputedStyle(element);
  return [
    "color",
    "background-color",
    "background-image",
    "border-top-color",
    "border-bottom-color",
    "box-shadow",
    "font-family",
  ]
    .map((property) => `${property}=${computed.getPropertyValue(property)}`)
    .join("|");
}

/** The painted result of a whole rendered component, element by element. */
function paintOfTree(host: HTMLElement): string {
  const canvas = host.querySelector(".site-canvas")!;
  const main = canvas.querySelector("#main-content")!;
  return [main, ...main.querySelectorAll("*")].map(paintOf).join("\n");
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
    it(`paints ${component} differently under two different looks`, () => {
      const first = paintOfTree(render(component, firstLook.design));
      const second = paintOfTree(render(component, secondLook.design));

      expect(first, component).not.toBe(second);
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

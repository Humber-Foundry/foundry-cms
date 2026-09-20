import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  homePage,
  referenceSiteDefinition,
  type SiteDefinition,
  type SitePage,
} from "@humber-foundry/site-definition";

import { SiteHeader } from "./site-shell";

/**
 * The reference definition, plus a second page with its own section, and a
 * navigation item for each of the four link targets #155 adds: the home
 * page's own contact section, the second page, a section on the second page,
 * and the Blog. The published reference content keeps its one page; this
 * fixture only adds a second page and these links for this test.
 */
function withNavigationFixture(): SiteDefinition {
  const home = homePage(referenceSiteDefinition);
  const about: SitePage = {
    id: "page_about",
    slug: "about",
    title: "About",
    seo: { title: "", description: "", keywords: [], shareImage: null },
    sections: [
      {
        id: "section_intro",
        type: "proof",
        variant: "panel",
        quote: "A second page.",
        attribution: "Fixture",
        metrics: [],
      },
    ],
  };
  return {
    ...referenceSiteDefinition,
    pages: [home, about],
    site: {
      ...referenceSiteDefinition.site,
      navigation: [
        { id: "nav_contact", label: "Contact", href: `page:${home.id}#section_contact` },
        { id: "nav_about", label: "About", href: "page:page_about" },
        { id: "nav_about_intro", label: "About intro", href: "page:page_about#section_intro" },
        { id: "nav_blog", label: "Journal", href: "blog" },
        { id: "nav_write", label: "Write to us", href: "mailto:hello@example.com" },
      ],
    },
  };
}

describe("SiteHeader link resolution", () => {
  it("resolves a page-anchor link to the home page's own section as a bare anchor while on the home page", () => {
    const definition = withNavigationFixture();
    const markup = renderToStaticMarkup(
      <SiteHeader definition={definition} currentPage={homePage(definition)} />,
    );
    expect(markup).toContain('href="#section_contact"');
  });

  it("resolves the same link to the home page's path plus the anchor while on another page", () => {
    const definition = withNavigationFixture();
    const about = definition.pages.find((page) => page.id === "page_about")!;
    const markup = renderToStaticMarkup(
      <SiteHeader definition={definition} currentPage={about} />,
    );
    expect(markup).toContain('href="/#section_contact"');
  });

  it("resolves a whole-page link to the target page's path", () => {
    const definition = withNavigationFixture();
    const markup = renderToStaticMarkup(
      <SiteHeader definition={definition} currentPage={homePage(definition)} />,
    );
    expect(markup).toContain('href="/about"');
  });

  it("resolves a link to a section on another page as that page's path plus the anchor", () => {
    const definition = withNavigationFixture();
    const markup = renderToStaticMarkup(
      <SiteHeader definition={definition} currentPage={homePage(definition)} />,
    );
    expect(markup).toContain('href="/about#section_intro"');
  });

  it("resolves the same section link as a bare anchor while already on that page", () => {
    const definition = withNavigationFixture();
    const about = definition.pages.find((page) => page.id === "page_about")!;
    const markup = renderToStaticMarkup(
      <SiteHeader definition={definition} currentPage={about} />,
    );
    expect(markup).toContain('href="#section_intro"');
  });

  it("resolves a Blog link to the given Blog address", () => {
    const definition = withNavigationFixture();
    const markup = renderToStaticMarkup(
      <SiteHeader
        definition={definition}
        currentPage={homePage(definition)}
        blogHref="/blog"
      />,
    );
    expect(markup).toContain('href="/blog">Journal</a>');
  });

  it("resolves a mailto link unchanged", () => {
    const definition = withNavigationFixture();
    const markup = renderToStaticMarkup(
      <SiteHeader definition={definition} currentPage={homePage(definition)} />,
    );
    expect(markup).toContain('href="mailto:hello@example.com"');
  });

  it("resolves a page link correctly with no current page, such as on the Blog", () => {
    const definition = withNavigationFixture();
    const markup = renderToStaticMarkup(<SiteHeader definition={definition} />);
    expect(markup).toContain('href="/about"');
    expect(markup).toContain('href="/#section_contact"');
  });
});

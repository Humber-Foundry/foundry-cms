import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SiteHrefField } from "./site-href-field";

const targets = [
  {
    id: "page_home",
    title: "Home",
    sections: [
      { id: "section_hero", label: "Hero" },
      { id: "section_contact", label: "Call to action" },
    ],
  },
  {
    id: "page_about",
    title: "About",
    sections: [{ id: "section_intro", label: "Proof" }],
  },
];

function render(value: string) {
  return renderToStaticMarkup(
    <SiteHrefField
      id="nav_about-href-field"
      value={value}
      targets={targets}
      disabled={false}
      invalid={false}
      describedBy="nav_about-href-error"
      onChange={vi.fn()}
    />,
  );
}

describe("SiteHrefField", () => {
  it("shows a whole-page link as 'A page' with the target page selected", () => {
    const markup = render("page:page_about");
    expect(markup).toContain('<option value="page" selected="">A page</option>');
    expect(markup).toContain('<option value="page_about" selected="">About</option>');
    expect(markup).not.toContain("aria-label=\"Section\"");
  });

  it("shows a page-and-anchor link as 'A section on a page' with both pickers", () => {
    const markup = render("page:page_about#section_intro");
    expect(markup).toContain("A section on a page");
    expect(markup).toContain('<option value="page_about" selected="">About</option>');
    expect(markup).toContain(
      '<option value="section_intro" selected="">Proof</option>',
    );
  });

  it("shows a bare #anchor as a section on the home page, the page it has always meant", () => {
    const markup = render("#section_contact");
    expect(markup).toContain("A section on a page");
    expect(markup).toContain('<option value="page_home" selected="">Home</option>');
    expect(markup).toContain(
      '<option value="section_contact" selected="">Call to action</option>',
    );
  });

  it("shows blog as 'The Blog' with no page picker", () => {
    const markup = render("blog");
    expect(markup).toContain("The Blog");
    expect(markup).not.toContain("aria-label=\"Page\"");
  });

  it("shows a mailto: link as an email address field", () => {
    const markup = render("mailto:hello@example.com");
    expect(markup).toContain("An email address");
    expect(markup).toContain('value="hello@example.com"');
  });
});

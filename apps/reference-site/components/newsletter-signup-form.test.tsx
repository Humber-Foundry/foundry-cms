import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NewsletterSignupForm } from "./newsletter-signup-form";

/**
 * What a visitor receives before any JavaScript runs. A browser that runs
 * JavaScript never parses the contents of a `noscript` element, so the wording
 * inside it can only be checked against the server-rendered markup.
 */
function markup(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <NewsletterSignupForm
      title="Get the newsletter"
      body="A short note every month or so."
      actionLabel="Sign up"
      consentNote="We send you the newsletter and nothing else."
      titleId="section_newsletter_title"
      {...extra}
    />,
  );
}

describe("the newsletter signup form, before any JavaScript runs", () => {
  it("tells somebody with JavaScript off what to do", () => {
    expect(markup()).toContain(
      "Signup needs JavaScript turned on, because every signup is checked for automated traffic before it is accepted.",
    );
  });

  it("shows the owner's words and the consent sentence", () => {
    const html = markup();
    expect(html).toContain("Get the newsletter");
    expect(html).toContain("A short note every month or so.");
    expect(html).toContain("We send you the newsletter and nothing else.");
    expect(html).toContain("Sign up");
  });

  it("names the section with the heading the renderer points at", () => {
    expect(markup()).toContain('id="section_newsletter_title"');
  });

  it("gives the address field a label a screen reader can use", () => {
    const html = markup();
    const inputId = /<input[^>]*id="([^"]+)"/u.exec(html)?.[1];
    expect(inputId).toBeDefined();
    expect(html).toContain(`for="${inputId}"`);
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="email"');
  });

  it("starts with the field locked until the server answers", () => {
    expect(markup()).toContain("disabled");
  });

  it("carries no address and no site key in the first response", () => {
    const html = markup();
    expect(html).not.toContain("@");
    expect(html.toLowerCase()).not.toContain("sitekey");
  });
});

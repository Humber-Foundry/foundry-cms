import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OverviewActivity,
  OverviewNumbers,
  SiteCard,
} from "./site-overview";

describe("SiteCard", () => {
  function markupFor(hasDraftChanges: boolean) {
    return renderToStaticMarkup(
      <SiteCard
        siteName="Harbour Works"
        publicAddress="harbourworks.example"
        publicHref="/"
        editHref="/dash/pages?workspace=w1&page=page_home"
        hasDraftChanges={hasDraftChanges}
        preview={<div className="picture" />}
      />,
    );
  }

  it("names the site, shows the address as the link to it, and opens the editor", () => {
    const markup = markupFor(false);

    expect(markup).toContain('<h1 id="site-card-name">Harbour Works</h1>');
    expect(markup).toContain('href="/"');
    expect(markup).toContain("View site");
    expect(markup).toContain("harbourworks.example");
    expect(markup).toContain(
      'href="/dash/pages?workspace=w1&amp;page=page_home"',
    );
    expect(markup).toContain("Edit site");
    expect(markup).toContain("dash-button-primary");
    expect(markup).toContain('class="picture"');
  });

  it("names the site only when it has no readable address", () => {
    const markup = renderToStaticMarkup(
      <SiteCard
        siteName="Harbour Works"
        publicAddress={null}
        publicHref="/"
        editHref="/dash/pages"
        hasDraftChanges={false}
        preview={null}
      />,
    );

    expect(markup).toContain("View site");
    expect(markup).not.toContain("dash-site-card-host");
  });

  it("says whether the draft is published, in the owner's words", () => {
    expect(markupFor(false)).toContain("Your draft matches your live site");
    expect(markupFor(true)).toContain(
      "Draft changes waiting to be published",
    );
  });
});

describe("OverviewNumbers", () => {
  const numbers = [
    {
      key: "visits",
      label: "Visits in the last 30 days",
      href: "/dash/analytics?days=30",
      value: "1,234",
      note: null,
    },
    {
      key: "messages",
      label: "Messages you have not read",
      href: "/dash/forms",
      value: null,
      note: "Your message store could not be read just now.",
    },
  ];

  it("links every number to the screen it comes from", () => {
    const markup = renderToStaticMarkup(
      <OverviewNumbers numbers={numbers} sample={false} />,
    );

    expect(markup).toContain('href="/dash/analytics?days=30"');
    expect(markup).toContain('href="/dash/forms"');
    expect(markup).toContain("1,234");
  });

  it("puts a sentence where a missing number would be, and no figure", () => {
    const markup = renderToStaticMarkup(
      <OverviewNumbers numbers={numbers} sample={false} />,
    );

    expect(markup).toContain("Your message store could not be read just now.");
    // Only the one number that has a figure draws a figure.
    expect(markup.match(/dash-number-value/gu)).toHaveLength(1);
  });

  it("says so when the figures are local development samples", () => {
    expect(
      renderToStaticMarkup(
        <OverviewNumbers numbers={numbers} sample={true} />,
      ),
    ).toContain("made-up samples");
    expect(
      renderToStaticMarkup(
        <OverviewNumbers numbers={numbers} sample={false} />,
      ),
    ).not.toContain("made-up samples");
  });
});

describe("OverviewActivity", () => {
  it("draws one row per thing that happened, with its time", () => {
    const markup = renderToStaticMarkup(
      <OverviewActivity
        items={[
          {
            key: "one",
            label: "You published your site",
            time: "3 Sep 2026, 9:14 am",
            href: "/dash/pages?workspace=w1",
          },
        ]}
      />,
    );

    expect(markup).toContain("You published your site");
    expect(markup).toContain("3 Sep 2026, 9:14 am");
    expect(markup).toContain('class="dash-row"');
  });

  it("says what to do next when nothing has happened yet", () => {
    const markup = renderToStaticMarkup(<OverviewActivity items={[]} />);

    expect(markup).toContain("Nothing has happened yet");
    expect(markup).toContain("dash-empty");
  });

  it("says the records could not be read, rather than that nothing happened", () => {
    const markup = renderToStaticMarkup(<OverviewActivity items={null} />);

    expect(markup).toContain("publish records could not be read");
    expect(markup).not.toContain("Nothing has happened yet");
  });
});
